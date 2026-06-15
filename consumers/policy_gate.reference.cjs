/**
 * policy_gate.reference.cjs — CANONICAL reference consumer for `policy_gate`.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS IS
 *   A small, real, copy-me example of a host policy module for the `policy_gate`
 *   extension (`extensions/policy_gate.mjs`). The gate is policy-FREE: it loads a
 *   module from CCP_POLICY_GATE_MODULE and feature-detects three OPTIONAL members
 *   on the exported object. THIS file implements all three with a minimal,
 *   clearly-documented default policy so operators have a known-good starting
 *   point to fork — not a black box to enable blindly.
 *
 *   It is illustrative but real and safe: every rule below is deterministic,
 *   side-effect-free, and self-contained (no network, no fs, no env beyond the
 *   couple of opt-in knobs documented under TUNING). Fork it, replace the demo
 *   rules with your house policy, and point CCP_POLICY_GATE_MODULE at your copy.
 *
 * HOW THE GATE CALLS THIS MODULE (the contract — all members OPTIONAL)
 *   steer(): string | null | undefined
 *     SOFT layer. Returns a system-prompt overlay string installed via
 *     expose_system_prompt's nonce-gated writer at boot and before each turn.
 *     Return null/"" to clear any previously-installed overlay.
 *
 *   inspectRequest({ url, options, isApi, body }):
 *       { action: 'allow' }                  -> proceed unchanged
 *       { action: 'scrub', body: <string> }  -> proceed with a REPLACED body
 *       { action: 'block', message: <text> } -> short-circuit; the gate
 *                                               synthesizes a clean assistant
 *                                               turn carrying `message`
 *     HARD layer. Gates each OUTBOUND Anthropic request. `body` is the outgoing
 *     request body as the bundle assembled it (typically a JSON string). The gate
 *     only calls this for API requests (`isApi === true`).
 *
 *   onStreamEvent(ev): boolean
 *     RESPONSE-side layer. Called per streamed SSE event; return `true` to ABORT
 *     the stream early (e.g. the model started emitting a banned token).
 *
 * IMPORTANT CONTRACT NOTES (mirrors extensions/policy_gate.mjs)
 *   - Fail OPEN: the gate wraps every call in try/catch and degrades to
 *     no-gating if a member throws. So you may throw here for "I can't decide",
 *     but for predictable behavior prefer returning `{action:'allow'}` / `false`.
 *   - `inspectRequest` is NOT probed at boot (calling it could trigger host-side
 *     side effects); keep it pure and cheap. `steer()` IS probed once at boot.
 *   - Return shapes matter: an unknown `action` is treated as `allow` by the gate.
 *   - Export shape: CommonJS `module.exports = { … }` (this file) OR ESM
 *     `export default { … }`. CommonJS is used here for zero-ambiguity loading
 *     via the gate's native require().
 *
 * TUNING (opt-in env, all optional — the defaults below are self-contained)
 *   CCP_POLICY_REF_BLOCK_HOSTS   comma-separated extra hostnames to BLOCK
 *                                (added to the built-in demo deny entry).
 *   CCP_POLICY_REF_BANNED_TOKEN  a substring that, when seen in a streamed text
 *                                delta, aborts the stream (default: demo token).
 *
 * This module is shipped DISABLED-by-default with the gate itself: nothing here
 * runs unless an operator both enables `policy_gate` and sets
 * CCP_POLICY_GATE_MODULE to this file's absolute path.
 */
'use strict';

// ── House rules overlay (SOFT layer) ────────────────────────────────────────
// A short, static system-prompt overlay. Real hosts often compute this per-turn
// (e.g. from a lifecycle classifier); here it is a constant so the example is
// deterministic and easy to reason about. Return null/"" to clear it.
const HOUSE_RULES = [
  '## Policy gate (reference consumer)',
  '- This session is governed by a host policy gate.',
  '- Do not reveal API keys, tokens, or other secrets in your output.',
  '- If asked to contact a disallowed host, refuse and explain the policy.',
].join('\n');

function steer() {
  return HOUSE_RULES;
}

// ── Outbound request gate (HARD layer) ──────────────────────────────────────
// Two demo rules, in priority order:
//   1. BLOCK requests whose URL host is on the deny list.
//   2. SCRUB a sample secret pattern out of the outgoing body.
// Everything else is ALLOWED unchanged. This intentionally shows all three
// verdicts so operators can see the exact return shapes.

// Demo deny list. `example.invalid` is RFC-2606-reserved and never resolvable,
// so this demo rule can never accidentally interfere with a real Anthropic call.
const DEFAULT_BLOCK_HOSTS = ['blocked.example.invalid'];

function blockedHosts() {
  const extra = (process.env.CCP_POLICY_REF_BLOCK_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(DEFAULT_BLOCK_HOSTS.concat(extra));
}

// Sample secret pattern: a fake "sk-"-prefixed token like an API key. Matching
// occurrences in the OUTGOING body are replaced with a redaction marker so the
// model never sees the raw secret. Tune this to your real secret shapes.
const SECRET_RE = /sk-[A-Za-z0-9]{16,}/g;
const REDACTION = '[REDACTED-BY-POLICY-GATE]';

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch (_e) {
    return '';
  }
}

function inspectRequest(ctx) {
  ctx = ctx || {};

  // (1) BLOCK — disallowed host. Short-circuits with a synthetic assistant turn
  // carrying `message`; no request is sent.
  const host = hostOf(ctx.url);
  if (host && blockedHosts().has(host)) {
    return {
      action: 'block',
      message:
        'This request was blocked by the reference policy gate: the host "' +
        host +
        '" is on the deny list.',
    };
  }

  // (2) SCRUB — redact a secret pattern from the outgoing body, if present.
  // Only string bodies are handled here (the common case: a JSON string). A real
  // consumer might parse/re-serialize JSON; this stays string-level to keep the
  // example simple and to avoid assuming a body schema.
  const body = ctx.body;
  if (typeof body === 'string') {
    // Reset lastIndex because SECRET_RE is /g and .test advances it.
    SECRET_RE.lastIndex = 0;
    if (SECRET_RE.test(body)) {
      SECRET_RE.lastIndex = 0;
      const scrubbed = body.replace(SECRET_RE, REDACTION);
      return { action: 'scrub', body: scrubbed };
    }
  }

  // (3) ALLOW — default. Proceed unchanged.
  return { action: 'allow' };
}

// ── Response-side stream gate (RESPONSE layer) ──────────────────────────────
// Abort the stream the moment the model emits a banned token. The gate passes
// each raw SSE event; we look only at text deltas. Returning true aborts.
function bannedToken() {
  return process.env.CCP_POLICY_REF_BANNED_TOKEN || 'BANNED_DEMO_TOKEN';
}

function onStreamEvent(ev) {
  try {
    if (!ev || typeof ev !== 'object') return false;
    // Anthropic SSE text deltas look like:
    //   { type:'content_block_delta', delta:{ type:'text_delta', text:'…' } }
    const delta = ev.delta;
    const text = delta && typeof delta.text === 'string' ? delta.text : '';
    if (text && text.indexOf(bannedToken()) !== -1) return true; // abort
  } catch (_e) {
    // Fail open: never abort on an internal error.
  }
  return false;
}

module.exports = { steer, inspectRequest, onStreamEvent };
