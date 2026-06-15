/**
 * policy_gate — generic, host-driven behavior gate for the running CLI.
 *
 * STATUS: ships DISABLED (`enabled: false` in ccpatch.yml). This patch is the
 * GATE MECHANISM only — it is policy-FREE and inert until a host wires a
 * consumer module via CCP_POLICY_GATE_MODULE (see "WIRING A CONSUMER" below).
 * A canonical REFERENCE CONSUMER ships at consumers/policy_gate.reference.cjs
 * (a small, documented example operators fork); the gate itself is a platform-
 * tier building block intended for downstream hosts that own their own policy
 * logic. It stays disabled-by-default because (a) with no module configured it does
 * nothing useful, and (b) when configured it loads ARBITRARY host code into the
 * CLI process (capability `exec`), so enabling it is an explicit operator
 * decision, never an implicit default.
 *
 * WIRING A CONSUMER (operator quickstart)
 *   1. Write a module that exports any subset of the HOST POLICY MODULE CONTRACT
 *      below (steer / inspectRequest / onStreamEvent). Start from the shipped
 *      reference: consumers/policy_gate.reference.cjs (copy it and edit the rules).
 *   2. Enable `policy_gate` (and its deps fetch_interceptor + expose_system_prompt)
 *      in your profile, then re-apply the patch set.
 *   3. Point the CLI at the module:
 *        export CCP_POLICY_GATE_MODULE=/abs/path/to/policy.cjs
 *      Optionally set CCP_POLICY_GATE_REQUIRED=1 to fail CLOSED (see FAIL-CLOSED).
 *   A worked operator reference (env table + the reference-consumer pointer)
 *   lives in EXTENSIONS_API.md ("policy_gate: host-driven behavior gate").
 *
 * KEEP DECISION (COD-15): the owner resolved to KEEP this gate and ship a real
 * reference consumer (consumers/policy_gate.reference.cjs) plus an end-to-end
 * contract test (tests/policy_gate_consumer.test.mjs). It stays enabled:false —
 * loading a host module runs arbitrary code (exec) — so arming a policy remains
 * an explicit operator opt-in via CCP_POLICY_GATE_MODULE. Removing this security-
 * relevant enforcement primitive must not happen without owner sign-off.
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
 * FAIL-OPEN (default): a missing module, a throwing member, or an absent host
 * contract all degrade to "no gating" — this patch must never wedge a turn.
 * FAIL-CLOSED (opt-in): set CCP_POLICY_GATE_REQUIRED=1 and a configured-but-
 * degraded gate instead BLOCKS every outbound Anthropic request (synthetic
 * assistant turn) so nothing proceeds unpoliced. Use it where a silently-
 * disabled gate is worse than an unavailable CLI. BOOT VISIBILITY:
 * when CCP_POLICY_GATE_MODULE is set but the gate degrades (module missing/
 * throwing, wrong export shape, or steer() throwing during a one-shot boot
 * probe), ONE loud console.warn is printed at boot — always, not just under
 * CLAUDE_DEBUG — so operators can't silently lose enforcement. After the warn
 * the gate continues fail-open exactly as before; the runtime request path is
 * unchanged. Per-request errors still surface only under CLAUDE_DEBUG=1 (or
 * paranoid mode via fetch_interceptor's bus; CCPATCH_PARANOID=1 behavior is
 * unchanged).
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

  // FAIL-CLOSED opt-in. By default the gate fails OPEN (a missing/broken policy
  // module degrades to no-gating) so it can never wedge a turn. Operators who
  // depend on enforcement can set CCP_POLICY_GATE_REQUIRED=1: then a configured-
  // but-degraded gate stops short-circuiting silently and instead installs a
  // hard BLOCK on every outbound Anthropic request, so NO model call proceeds
  // unpoliced. This trades availability for safety, which is the whole point of
  // opting in. A typo'd module path now fails loudly AND closed, not silently
  // open. (Only armed when a module is configured — an unset module is 'inert',
  // not 'degraded', and never blocks.)
  var REQUIRED = false;
  try { REQUIRED = (process.env.CCP_POLICY_GATE_REQUIRED === '1'); } catch (_e) {}

  // Load the host-supplied policy module (env-pointed). Inert when unset.
  var policy = null;
  var modPath = '';
  var loadErr = null;
  try { modPath = (typeof process !== 'undefined' && process.env) ? (process.env.CCP_POLICY_GATE_MODULE || '') : ''; } catch (_e) {}
  if (modPath) {
    try {
      var req = (typeof __ccp_nativeRequire === 'function') ? __ccp_nativeRequire
              : (typeof require === 'function') ? require : null;
      if (!req) { loadErr = 'no require available in this bundle'; }
      else {
        policy = req(modPath);
        policy = (policy && policy.default) ? policy.default : policy;
      }
    } catch (e) { loadErr = 'module failed to load: ' + ((e && e.message) || e); }
  }

  // ── Boot probe (visibility fix) ──────────────────────────────────────────
  // When a policy module IS configured but the gate cannot enforce it — module
  // missing/throwing, wrong export shape, or a steer() that throws — print ONE
  // loud console.warn at boot (always, not just under CLAUDE_DEBUG) and then
  // continue fail-open exactly as before. A silently-degraded gate defeats the
  // operator's intent; the runtime request path is unchanged.
  var __bootWarned = false;
  function bootDegraded(reason) {
    if (__bootWarned) return;
    __bootWarned = true;
    if (REQUIRED) {
      try {
        console.error('[ccpatch] policy_gate: CCP_POLICY_GATE_MODULE is set (' + modPath + ') but the policy gate is DEGRADED: ' + reason + '. CCP_POLICY_GATE_REQUIRED=1 is set, so the gate is FAILING CLOSED: every outbound Anthropic request will be BLOCKED until a valid policy module loads. Fix the module (or unset CCP_POLICY_GATE_REQUIRED to fall back to fail-open).');
      } catch (_e) {}
      installFailClosed(reason);
      return;
    }
    try {
      console.warn('[ccpatch] policy_gate: CCP_POLICY_GATE_MODULE is set (' + modPath + ') but the policy gate is DEGRADED to NO-GATING: ' + reason + '. The CLI continues WITHOUT policy enforcement (fail-open). Set CCP_POLICY_GATE_REQUIRED=1 to fail closed instead.');
    } catch (_e) {}
  }

  // Hard fail-closed: block every outbound API call with a synthetic assistant
  // turn explaining the gate is unavailable. Registered via the same deferred
  // __ccpOnFetchBefore path the normal gate uses, so it is robust to prepend
  // order. syntheticAssistant() is a hoisted function declaration below.
  var __failClosedRegistered = false;
  function installFailClosed(reason) {
    function reg() {
      if (__failClosedRegistered) return;
      if (typeof globalThis.__ccpOnFetchBefore !== 'function') return;
      __failClosedRegistered = true;
      globalThis.__ccpOnFetchBefore('policy_gate_fail_closed', function (ctx) {
        try {
          if (!ctx || !ctx.isApi) return;
          ctx._intercept = syntheticAssistant('Policy gate is required (CCP_POLICY_GATE_REQUIRED=1) but unavailable: ' + reason + '. Blocking this request until the policy module loads.');
        } catch (_e) {}
      }, 0); // priority 0 — run before any other before-hook
    }
    reg();
    try { setTimeout(reg, 0); } catch (_e) {}
  }

  if (!modPath) { dbg('no policy module; gate inert'); return; }
  if (loadErr) { bootDegraded(loadErr); return; }
  if (!policy || typeof policy !== 'object') {
    bootDegraded('module did not export an object (got ' + (policy === null ? 'null' : typeof policy) + ')');
    return;
  }
  var __hasContract = (typeof policy.steer === 'function')
    || (typeof policy.inspectRequest === 'function')
    || (typeof policy.onStreamEvent === 'function');
  if (!__hasContract) {
    // Wrong shape: an object with none of the contract members gates nothing.
    bootDegraded('module exports none of steer()/inspectRequest()/onStreamEvent() — wrong contract shape');
  } else if (typeof policy.steer === 'function') {
    // Cheap probe: call the soft-layer member once in a try/catch so a broken
    // steer() is announced at boot instead of silently swallowed per-turn.
    // (inspectRequest is NOT probed — invoking it with a sentinel request
    // could trigger host-side side effects; presence-typeof is enough there.)
    try { policy.steer(); }
    catch (e) { bootDegraded('steer() threw during the boot probe: ' + ((e && e.message) || e)); }
  }

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
  // Honest capability set (review fix): the gate require()s an ARBITRARY
  // module path taken from CCP_POLICY_GATE_MODULE — loading host-supplied code
  // into the CLI process is exec-shaped, on top of the network (request gate),
  // prompt (steer), fs (module read), and env powers it already declared.
  capabilities: ['network', 'prompt', 'fs', 'env', 'exec'],
  phase: 'post',
  dependsOn: ['fetch_interceptor', 'expose_system_prompt'],
  env: ['CCP_POLICY_GATE_MODULE', 'CCP_POLICY_GATE_PRIORITY', 'CCP_POLICY_GATE_REQUIRED', 'CLAUDE_DEBUG'],
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
