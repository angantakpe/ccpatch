import { createHash } from 'node:crypto';
import { changedWindow } from './text-span.mjs';

// PERF (MEASURED 2026-06): sha256 over the ~15MB bundle costs ~20ms, and each
// changed patch hashes BOTH its pre and post code — ~40 hashes/build. But the
// runner threads `nextCode = effectiveCode` straight into the next patch's
// preCode (same string reference), so a changed patch's postCode IS the next
// changed patch's preCode. Memoise by string identity (JS can't weak-ref a
// string) so each code state is hashed once instead of twice. Correctness is
// unaffected if the reference ever differs: it just recomputes.
//
// A single last-seen slot only hit when post(N) === pre(N+1) AND nothing else
// was hashed in between. With pre and post BOTH consulting (and BOTH writing) a
// small bounded ring, a string hashed once as a "post" is reused when it next
// appears as a "pre" even if interleaved with other hashes. Bounded to the last
// few references so memory stays flat on large builds (entries are string refs,
// not copies — the strings are already live in the runner).
const HASH_CACHE_MAX = 64;
// Keyed by string reference (Map uses === for keys): same content in a fresh
// string object is a miss and recomputes — identical hash, just not deduped.
const hashCache = new Map();
export function sha256(s) {
  const cached = hashCache.get(s);
  if (cached !== undefined) return cached;
  const v = createHash('sha256').update(s, 'utf8').digest('hex');
  // Evict oldest (insertion-ordered Map) before exceeding the bound.
  if (hashCache.size >= HASH_CACHE_MAX) {
    hashCache.delete(hashCache.keys().next().value);
  }
  hashCache.set(s, v);
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
export function captureReverseDiff(name, preCode, effectiveCode, captureReverse, carriedPreSha) {
  // EXPLICIT-request gate: no array → capture was not requested → skip entirely.
  // Return value threads `postSha256` forward to become the NEXT record's
  // `preSha256` (the post code state of patch N IS the pre code state of patch
  // N+1, by content). Callers pass the prior return as `carriedPreSha` so each
  // distinct 16MB code state is hashed exactly ONCE across the whole build,
  // instead of twice per changed patch. The reference-keyed `hashCache` above
  // can't catch this because every patch transform (and coverage injection)
  // produces a FRESH string object — same content, new reference, cache miss.
  // Hashing is the dominant build cost (profiled: ~64% of native time), so this
  // halves it. Correctness is unaffected: if a carried sha is ever absent we
  // recompute, and the value is identical either way.
  if (!Array.isArray(captureReverse)) return undefined;
  if (typeof effectiveCode !== 'string') return carriedPreSha;
  if (effectiveCode === preCode) {
    // No-change apply contributes no record; the code state is unchanged, so the
    // pre-sha carries through untouched to the next patch.
    return carriedPreSha;
  }

  // The changed window: original (pre-apply) middle is what a revert must
  // restore; patched middle is what it must remove. `at` is the splice offset in
  // the PATCHED bundle (prefix is identical in both, so the offset coincides).
  const { at, preWin: originalMiddle, postWin: patchedMiddle } = changedWindow(preCode, effectiveCode);

  const preSha256 = carriedPreSha ?? sha256(preCode);
  const postSha256 = sha256(effectiveCode);
  captureReverse.push({
    name,
    splice: { at, removeLen: patchedMiddle.length, insert: originalMiddle },
    added: countLines(patchedMiddle),
    removed: countLines(originalMiddle),
    preSha256,
    postSha256,
  });
  return postSha256;
}
