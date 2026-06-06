/**
 * policy_gate — generic, host-driven behavior gate for the running CLI.
 *
 * WHY THIS EXISTS
 * Some products need a behavior check that is enforced IN the CLI process, on
 * every surface (interactive terminal AND headless), because their server-side
 * policy engine can't reach a raw `claude` session. This patch wires two
 * enforcement points to a HOST-SUPPLIED policy module so the check lives in one
 * place (the host's, e.g. a lifecycle classifier) instead of being re-coded per
 * surface:
 *
 *   1. SOFT — system-prompt steer. At boot (and before each turn) the gate asks
 *      the host policy for a steer string and installs it as a main-loop system
 *      block via expose_system_prompt's nonce-gated __ccpSetSystemPrompt. Use it
 *      to force a stance ("this store is at day-zero; do not brief on numbers").
 *
 *   2. HARD — outbound request gate. Via fetch_interceptor's __ccpOnFetchBefore,
 *      the gate hands each outgoing Anthropic request to the host policy, which
 *      may ALLOW it, SCRUB it (replace the request body — e.g. strip a poisoned
 *      context block before the model ever sees it), or BLOCK it (short-circuit
 *      with a synthetic assistant reply, surfaced as a clean turn, not an error).
 *      Note: __ccpOnFetchBefore fires on the OUTGOING request, so it sees the
 *      assembled prompt/context, not the model's reply. To gate the model's
 *      OUTPUT, the host policy may also export onStreamEvent (response-side).
 *
 * The patch itself is policy-FREE: with no host module configured it is inert.
 * The host module path is read at runtime from CCP_POLICY_GATE_MODULE.
 *
 * HOST POLICY MODULE CONTRACT (all members optional; the gate feature-detects)
 *   module.exports = {
 *     // SOFT: return a system-prompt steer string, or null/"" to clear it.
 *     steer() { return "## ..." | null },
 *     // HARD outbound: classify one outgoing API request.
 *     //   { action: 'allow' }                  -> proceed unchanged
 *     //   { action: 'scrub', body: <string> }  -> proceed with replaced body
 *     //   { action: 'block', message: <text> } -> short-circuit, synthetic reply
 *     inspectRequest({ url, options, isApi, body }) { return { action:'allow' } },
 *     // RESPONSE-side (optional): inspect each streamed SSE event; return true
 *     // to abort the stream early (e.g. the model emitted a banned claim).
 *     onStreamEvent(ev) { return false },
 *   }
 *
 * FAIL-OPEN: a missing module, a throwing member, or an absent host contract all
 * degrade to "no gating" — this patch must never wedge a turn. Errors surface
 * only under CLAUDE_DEBUG=1 (or paranoid mode via fetch_interceptor's bus).
 *
 * DEPENDENCIES: fetch_interceptor (hard layer) and expose_system_prompt (soft
 * layer). Both are also feature-detected at runtime, so the gate degrades
 * gracefully if either is disabled. Registration is deferred one tick past
 * synchronous boot (mirroring rate_limit) so the bus globals exist regardless of
 * prepend order.
 */
import { spliceBoot } from '../runner/patch-helpers.mjs';

const BOOT = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] policy_gate — host-driven soft steer + outbound request gate
// ══════════════════════════════════════════════════════════════════════════
(() => {
  if (globalThis.__ccpPolicyGateInstalled_v1) return;
  globalThis.__ccpPolicyGateInstalled_v1 = true;

  var DEBUG = false;
  try { DEBUG = (process.env.CLAUDE_DEBUG === '1' || process.env.CC_DEBUG === '1'); } catch (_e) {}
  function dbg(msg) { if (DEBUG) { try { process.stderr.write('[ccp:policy_gate] ' + msg + '\\n'); } catch (_e) {} } }

  // Load the host-supplied policy module (env-pointed). Inert when unset/unloadable.
  var policy = null;
  try {
    var modPath = (typeof process !== 'undefined' && process.env) ? process.env.CCP_POLICY_GATE_MODULE : '';
    if (modPath) {
      var req = (typeof __ccp_nativeRequire === 'function') ? __ccp_nativeRequire
              : (typeof require === 'function') ? require : null;
      if (!req) { dbg('require unavailable; gate inert'); return; }
      policy = req(modPath);
      policy = (policy && policy.default) ? policy.default : policy;
    }
  } catch (e) { dbg('policy load failed: ' + ((e && e.message) || e)); }
  if (!policy || typeof policy !== 'object') { dbg('no policy module; gate inert'); return; }

  // ── SOFT: refresh the main-loop system-prompt steer from policy.steer() ──
  function refreshSteer() {
    try {
      if (typeof policy.steer !== 'function') return;
      if (typeof globalThis.__ccpGetSystemPromptNonce !== 'function'
          || typeof globalThis.__ccpSetSystemPrompt !== 'function') return;
      var nonce = globalThis.__ccpGetSystemPromptNonce();
      var s = policy.steer();
      globalThis.__ccpSetSystemPrompt(nonce, (typeof s === 'string' && s) ? s : null);
    } catch (e) { dbg('steer failed: ' + ((e && e.message) || e)); }
  }

  // Build a minimal, valid Anthropic SSE stream carrying one assistant text
  // block, so a hard BLOCK surfaces as a clean turn rather than an API error.
  function syntheticAssistant(text) {
    var safe = String(text == null ? '' : text);
    var ev = [
      ['message_start', { type:'message_start', message:{ id:'msg_ccp_policy_gate', type:'message', role:'assistant', model:'ccp-policy-gate', content:[], stop_reason:null, stop_sequence:null, usage:{ input_tokens:0, output_tokens:0 } } }],
      ['content_block_start', { type:'content_block_start', index:0, content_block:{ type:'text', text:'' } }],
      ['content_block_delta', { type:'content_block_delta', index:0, delta:{ type:'text_delta', text:safe } }],
      ['content_block_stop', { type:'content_block_stop', index:0 }],
      ['message_delta', { type:'message_delta', delta:{ stop_reason:'end_turn', stop_sequence:null }, usage:{ output_tokens:0 } }],
      ['message_stop', { type:'message_stop' }],
    ];
    var body = '';
    for (var i = 0; i < ev.length; i++) {
      body += 'event: ' + ev[i][0] + '\\n' + 'data: ' + JSON.stringify(ev[i][1]) + '\\n\\n';
    }
    return new Response(body, { status:200, headers:{ 'Content-Type':'text/event-stream; charset=utf-8' } });
  }

  // ── HARD: register the outbound gate + optional response-side hook ──
  // Deferred one tick (like rate_limit): this IIFE may run before
  // fetch_interceptor installs the bus, depending on prepend order.
  var registered = false;
  function register() {
    if (registered) return;
    // SOFT steer once the system-prompt bus is up.
    refreshSteer();
    if (typeof globalThis.__ccpOnFetchBefore === 'function' && typeof policy.inspectRequest === 'function') {
      registered = true;
      var priority = 20;
      try { if (process.env.CCP_POLICY_GATE_PRIORITY) priority = Number(process.env.CCP_POLICY_GATE_PRIORITY) || 20; } catch (_e) {}
      globalThis.__ccpOnFetchBefore('policy_gate', function (ctx) {
        try {
          if (!ctx || !ctx.isApi) return;
          // Opportunistically refresh the steer for the NEXT turn (this turn's
          // prompt is already assembled into ctx.options.body).
          refreshSteer();
          var verdict = policy.inspectRequest({
            url: ctx.url,
            options: ctx.options,
            isApi: ctx.isApi,
            body: ctx.options ? ctx.options.body : undefined,
          });
          if (!verdict || verdict.action == null || verdict.action === 'allow') return;
          if (verdict.action === 'scrub' && typeof verdict.body !== 'undefined') {
            // Mutate options in place; fetch_interceptor picks up ctx.options.
            ctx.options = Object.assign({}, ctx.options, { body: verdict.body });
            dbg('scrubbed outbound request body');
            return;
          }
          if (verdict.action === 'block') {
            ctx._intercept = syntheticAssistant(verdict.message || 'This request was blocked by store policy.');
            dbg('blocked outbound request');
            return;
          }
        } catch (e) { dbg('inspectRequest failed: ' + ((e && e.message) || e)); }
      }, priority);
    }
    if (typeof globalThis.__ccpOnFetchStream === 'function' && typeof policy.onStreamEvent === 'function') {
      globalThis.__ccpOnFetchStream('policy_gate', function (ev, abortFn) {
        try { if (policy.onStreamEvent(ev)) abortFn(); } catch (e) { dbg('onStreamEvent failed: ' + ((e && e.message) || e)); }
      });
    }
  }

  // Try synchronously (in case the bus is already up), then defer one tick to
  // cover the prepend-order case where fetch_interceptor installs after us.
  register();
  try { setTimeout(register, 0); } catch (_e) {}
})();
`;

export default {
  category: 'feature',
  description:
    'Host-driven behavior gate: soft system-prompt steer + outbound request gate (allow/scrub/block) wired to a policy module at CCP_POLICY_GATE_MODULE.',
  capabilities: ['network', 'prompt', 'fs', 'env'],
  phase: 'post',
  dependsOn: ['fetch_interceptor', 'expose_system_prompt'],
  env: ['CCP_POLICY_GATE_MODULE', 'CCP_POLICY_GATE_PRIORITY', 'CLAUDE_DEBUG'],
  verify: {
    // BOOT references the sentinel exactly twice (guard read + assignment).
    present: ['__ccpPolicyGateInstalled_v1'],
    count: { present: 2 },
  },
  apply: (code) => {
    if (code.includes('__ccpPolicyGateInstalled_v1')) return code; // idempotent
    return spliceBoot(code, BOOT);
  },
};
