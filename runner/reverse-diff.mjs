import { createHash } from 'node:crypto';
import { changedWindow } from './text-span.mjs';

// PERF (MEASURED 2026-06): sha256 over the ~15MB bundle costs ~20ms, and each
// changed patch hashes BOTH its pre and post code — ~40 hashes/build. But the
// runner threads `nextCode = effectiveCode` straight into the next patch's
// preCode (same string reference), so a changed patch's postCode IS the next
// changed patch's preCode. Memoise by string identity (same last-seen pattern as
// conflict.mjs / ast-cache.mjs — JS can't weak-ref a string) so each code state
// is hashed once instead of twice. Correctness is unaffected if the reference
// ever differs: it just recomputes.
let lastHashStr = null;
let lastHashVal = null;
export function sha256(s) {
  if (lastHashStr === s && lastHashVal !== null) return lastHashVal;
  const v = createHash('sha256').update(s, 'utf8').digest('hex');
  lastHashStr = s;
  lastHashVal = v;
  return v;
}

// Count line segments in a slice (for the `ccpatch diff` +/- display columns).
// A slice with no newline is one segment; each '\n' starts another.
function countLines(s) {
  if (s.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Capture a reverse splice from the effective post-apply code back to the
 * pre-apply code so the patched bundle can be restored byte-for-byte later.
 *
 * Skips no-change applies (effectiveCode === preCode) — they contribute
 * nothing to a revert. Pushes a sidecar record into `captureReverse` (the
 * caller's array) when a meaningful change exists.
 *
 * Perf#4 (MEASURED 2026-06): the previous implementation ran `createPatch` —
 * a full line-by-line diff of the entire ~15MB minified bundle — for every
 * changed patch (~24x per build). A CPU profile attributed ~10s of a ~20s
 * build to the `diff` library's tokenize/splitLines/equals/join (plus the GC
 * churn from millions of line tokens). But a patch is a localized string edit,
 * so the changed region is found exactly by a two-ended common prefix/suffix
 * scan — two O(n) passes (~tens of ms on 15MB) instead of an O(n·d) line diff.
 * We store the minimal SPLICE (`{ at, removeLen, insert }`): to revert,
 * `code.slice(0, at) + insert + code.slice(at + removeLen)` reproduces preCode
 * byte-for-byte. A multi-region patch collapses to one span covering its first
 * to last changed byte — always correct (the `insert` carries the full original
 * middle verbatim), at worst slightly larger than minimal.
 *
 * Records carry { name, splice, added, removed, preSha256, postSha256 }.
 * `added`/`removed` feed the `ccpatch diff` display; the SHAs anchor the
 * per-step revert verification in runner/cli/cmd-revert.mjs.
 *
 * No-op when `captureReverse` isn't an array or `effectiveCode` is not a
 * string. Mutates `captureReverse` in place.
 */
export function captureReverseDiff(name, preCode, effectiveCode, captureReverse) {
  // EXPLICIT-request gate: no array → capture was not requested → skip entirely.
  if (!Array.isArray(captureReverse)) return;
  if (typeof effectiveCode !== 'string') return;
  if (effectiveCode === preCode) return;

  // The changed window: original (pre-apply) middle is what a revert must
  // restore; patched middle is what it must remove. `at` is the splice offset in
  // the PATCHED bundle (prefix is identical in both, so the offset coincides).
  const { at, preWin: originalMiddle, postWin: patchedMiddle } = changedWindow(preCode, effectiveCode);

  captureReverse.push({
    name,
    splice: { at, removeLen: patchedMiddle.length, insert: originalMiddle },
    added: countLines(patchedMiddle),
    removed: countLines(originalMiddle),
    preSha256: sha256(preCode),
    postSha256: sha256(effectiveCode),
  });
}
