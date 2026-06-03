/**
 * expose_system_prompt — runtime override slot for the main-loop system prompt.
 *
 * Unblocks ADK handoff `mode: 'swap'` (see packages/adk/HANDOFF.md). Exposes a
 * persona-overlay slot that is appended to the main agent's system-prompt array
 * on every query, so a handoff can swap the active persona IN PLACE — with full
 * system authority, not as a low-authority synthetic user message.
 *
 * ── Exposed globals ──────────────────────────────────────────────────────────
 *   globalThis.__ccpSetSystemPrompt(str|null)
 *     Set (or clear, with null/"") the persona overlay. Subsequent queries
 *     append `str` as a trailing system text block. Idempotent.
 *
 *   globalThis.__ccpGetSystemPrompt()
 *     Returns the current overlay string, or null.
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
 * ── Scope caveat ─────────────────────────────────────────────────────────────
 * The overlay applies to every query through the main assembly path, which can
 * include subagent queries while the slot is set. Subagents normally carry their
 * own getSystemPrompt-derived prompt; an active overlay would also append to
 * theirs. Swap is an advanced/opt-in mode — callers should clear the overlay
 * (__ccpSetSystemPrompt(null)) when the swapped session ends. A future revision
 * may scope by querySource.
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

  globalThis.__ccpSetSystemPrompt = function (s) {
    globalThis.__ccpSystemPromptOverride = (typeof s === 'string' && s) ? s : null;
    return globalThis.__ccpSystemPromptOverride;
  };
  globalThis.__ccpGetSystemPrompt = function () {
    return globalThis.__ccpSystemPromptOverride || null;
  };
  // Wraps the bundle's system-prompt array builder result. Appends the overlay
  // block when set; always returns the same array reference.
  globalThis.__ccpApplySystemPromptOverride = function (arr) {
    try {
      var sp = globalThis.__ccpSystemPromptOverride;
      if (sp && typeof sp === 'string' && Array.isArray(arr)) {
        arr.push({ type: 'text', text: sp });
      }
    } catch (_ccpSP_) {}
    return arr;
  };

  if (typeof globalThis.__ccpProvide === 'function') {
    try {
      globalThis.__ccpProvide('systemPrompt', {
        version: 1,
        producer: 'expose_system_prompt',
        shape: ['set', 'get'],
        value: { set: globalThis.__ccpSetSystemPrompt, get: globalThis.__ccpGetSystemPrompt },
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
