/**
 * expose_system_prompt — runtime override slot for the main-loop system prompt.
 *
 * Unblocks ADK handoff `mode: 'swap'` (see packages/adk/HANDOFF.md). Exposes a
 * persona-overlay slot that is appended to the main agent's system-prompt array
 * on every query, so a handoff can swap the active persona IN PLACE — with full
 * system authority, not as a low-authority synthetic user message.
 *
 * ── Exposed globals ──────────────────────────────────────────────────────────
 *   globalThis.__ccpSetSystemPrompt(callerNonce, str|null)
 *     Set (or clear, with null/"") the persona overlay. Subsequent queries
 *     append `str` as a trailing system text block. Idempotent.
 *     NONCE-GATED: `callerNonce` (first arg) must equal the value returned by
 *     __ccpGetSystemPromptNonce(); a wrong/absent nonce throws. Flipping the live
 *     persona is HIGHER authority than tool dispatch (it changes "who the agent
 *     is" mid-session), so the writer mirrors the expose_tool_dispatch nonce gate
 *     to keep unguarded in-process code (e.g. a compromised MCP server) from
 *     silently reassigning the persona.
 *
 *   globalThis.__ccpGetSystemPromptNonce()
 *     Returns the load-time nonce __ccpSetSystemPrompt requires as its first
 *     argument. Trusted callers acquire this once at startup and pass it on every
 *     write. Mirrors __ccpGetDispatchNonce() from expose_tool_dispatch.
 *
 *   globalThis.__ccpGetSystemPrompt()
 *     Returns the current overlay string, or null. UNGATED — reading the active
 *     persona is not a privilege escalation, only writing is.
 *
 *   globalThis.__ccpApplySystemPromptOverride(arr)
 *     Internal — wraps the bundle's system-prompt array builder. Pushes the
 *     overlay block when set and returns the (same) array. Injected at the
 *     assembly site so callers never invoke it directly.
 *
 * ── Anchor ───────────────────────────────────────────────────────────────────
 * The main-loop system prompt is assembled as:
 *   <VAR>=<wrap>([<intro-selector>({isNonInteractive:…,hasAppendSystemPrompt:…}),
 *               ...<VAR>, …].filter(Boolean))
 * The keys `isNonInteractive` and `hasAppendSystemPrompt` are stable English
 * identifiers; the wrap fn (u9/b9/V9/Z9) and LHS var rotate per build and are
 * captured. Cardinality verified = 1 across v2.1.156/158/160/161.
 *
 * We rewrite `<VAR>=<wrap>([...])` → `<VAR>=globalThis.__ccpApplySystemPromptOverride(<wrap>([...]))`,
 * preserving the surrounding `,a19($);` comma-sequence statement.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 * The overlay is scoped to main-loop queries by query source: __ccpApplySystem-
 * PromptOverride only appends the persona block when globalThis.__ccp_path is
 * unset or "root". While a subagent runs, expose_agent_tool sets __ccp_path to a
 * non-root "<parent>/<child>" path, so an active overlay is NOT appended to a
 * subagent's prompt — the swapped persona stays on the main agent. Callers should
 * still clear the overlay (__ccpSetSystemPrompt(null)) when the swapped session
 * ends. Note: scoping degrades safely to "always apply" if expose_agent_tool is
 * absent (no __ccp_path is ever set, so every query reads as main-loop).
 */
import { spliceBoot } from '../runner/patch-helpers.mjs';

const BOOT = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] expose_system_prompt — __ccpSetSystemPrompt persona overlay
// ══════════════════════════════════════════════════════════════════════════
(() => {
  if (globalThis.__ccpSystemPromptExposed_v1) return;
  globalThis.__ccpSystemPromptExposed_v1 = true;
  if (globalThis.__ccpSystemPromptOverride === undefined) globalThis.__ccpSystemPromptOverride = null;

  // Load-time nonce — generated once when the patch runs. The persona-swap
  // writer (__ccpSetSystemPrompt) is HIGHER authority than tool dispatch, so it
  // is gated exactly like __ccpInvokeTool: any caller that did not acquire the
  // nonce via __ccpGetSystemPromptNonce() at startup is rejected, preventing
  // unguarded in-process code (e.g. a compromised MCP server) from flipping the
  // live persona.
  var _ccpSysPromptNonce = [0, 0, 0, 0].map(function () { return Math.random().toString(36).slice(2); }).join('');
  // Nonce getter — trusted callers call this once at startup and cache the result.
  globalThis.__ccpGetSystemPromptNonce = function () { return _ccpSysPromptNonce; };

  // Persona-overlay writer. Requires callerNonce as its FIRST argument (obtained
  // via __ccpGetSystemPromptNonce()). Wrong/absent nonce throws.
  globalThis.__ccpSetSystemPrompt = function (callerNonce, s) {
    if (callerNonce !== _ccpSysPromptNonce) throw new Error('__ccpSetSystemPrompt: invalid nonce. Call __ccpGetSystemPromptNonce() at startup.');
    globalThis.__ccpSystemPromptOverride = (typeof s === 'string' && s) ? s : null;
    return globalThis.__ccpSystemPromptOverride;
  };
  globalThis.__ccpGetSystemPrompt = function () {
    return globalThis.__ccpSystemPromptOverride || null;
  };
  // Wraps the bundle's system-prompt array builder result. Appends the overlay
  // block when set; always returns the same array reference.
  //
  // Scoped by query source: the overlay is a main-loop persona swap, so it must
  // only apply to main-loop queries. While a subagent runs, expose_agent_tool
  // sets globalThis.__ccp_path to a non-root path ("<parent>/<child>"); when the
  // path is non-root we are assembling a subagent's prompt and skip the overlay,
  // so a swapped persona never leaks into a concurrently-running subagent query.
  globalThis.__ccpApplySystemPromptOverride = function (arr) {
    try {
      var sp = globalThis.__ccpSystemPromptOverride;
      var path = globalThis.__ccp_path;
      var isMainLoop = !path || path === 'root';
      if (sp && typeof sp === 'string' && isMainLoop && Array.isArray(arr)) {
        arr.push({ type: 'text', text: sp });
      }
    } catch (_ccpSP_) {}
    return arr;
  };

  if (typeof globalThis.__ccpProvide === 'function') {
    try {
      globalThis.__ccpProvide('systemPrompt', {
        version: 2,
        producer: 'expose_system_prompt',
        shape: ['set', 'get', 'getNonce'],
        value: {
          set: globalThis.__ccpSetSystemPrompt,
          get: globalThis.__ccpGetSystemPrompt,
          getNonce: globalThis.__ccpGetSystemPromptNonce,
        },
      });
    } catch (_) {}
  }
})();
`;

export default {
  category: 'expose',
  description: 'Expose __ccpSetSystemPrompt — runtime persona overlay on the main-loop system prompt (unblocks ADK swap handoff).',
  capabilities: ['prompt'],
  verify: {
    present: ['__ccpSystemPromptExposed_v1', 'globalThis.__ccpApplySystemPromptOverride('],
    // BOOT references the sentinel twice (guard + assignment); the anchor
    // rewrite adds one __ccpApplySystemPromptOverride( call site. Total = 3.
    count: { present: 3 },
    // Nonce getter must be present after the patch is applied (advisory — like
    // expose_tool_dispatch's also_present, this documents the contract surface).
    also_present: ['__ccpGetSystemPromptNonce'],
  },
  apply: (code) => {
    if (code.includes('__ccpSystemPromptExposed_v1')) return code; // idempotent

    // Anchor the main-loop system-prompt assembly. The two key names are stable;
    // the wrap fn and LHS var rotate and are captured. `.{0,N}?` spans nested
    // brackets (the array contains `...j?[qG7]:[]`).
    const RE = /([\w$]+)=([\w$]+)\(\[.{0,120}?isNonInteractive.{0,80}?hasAppendSystemPrompt.{0,160}?\.filter\(Boolean\)\)/g;
    const all = [...code.matchAll(RE)];
    if (all.length !== 1) {
      console.warn(`  [!] expose_system_prompt: assembly anchor matched ${all.length} times (want 1) — skipping override injection`);
      return spliceBoot(code, BOOT); // helpers still exposed; overlay just won't apply
    }

    const m = all[0];
    const matched = m[0];
    const lhs = m[1];
    // Rewrite `<lhs>=<rest>` → `<lhs>=globalThis.__ccpApplySystemPromptOverride(<rest>)`.
    // Splice at the regex-discovered offset (m.index) rather than String.replace
    // so `$`-bearing minified identifiers in `rest` aren't treated as replacement
    // specials, and the offset is exact (the match is unique, asserted above).
    const rest = matched.slice(lhs.length + 1); // drop "<lhs>="
    const replacement = `${lhs}=globalThis.__ccpApplySystemPromptOverride(${rest})`;
    const at = m.index;
    code = code.slice(0, at) + replacement + code.slice(at + matched.length);

    return spliceBoot(code, BOOT);
  },
};
