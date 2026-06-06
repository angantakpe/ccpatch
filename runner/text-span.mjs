/**
 * Shared byte-span scan helpers for localized edits to large (~15MB) bundles.
 *
 * A patch is a localized string edit, so preCode and effectiveCode share a long
 * common prefix and suffix. Finding that boundary with a per-character charCodeAt
 * loop is O(n) in slow JS and dominated a build profile when edits landed late in
 * the file. These helpers compare in native BLOCK-sized chunks (V8 string
 * equality is memcmp-fast) and only fall back to a char loop inside the single
 * block where the strings first differ.
 *
 * Pure, side-effect free. Used by reverse-diff.mjs (revert splice) and
 * conflict.mjs (windowed overlap diff).
 */

const SCAN_BLOCK = 1 << 16; // 64 KiB

/** Length of the common prefix of a and b, capped at `max`. */
export function commonPrefixLen(a, b, max) {
  let i = 0;
  while (i + SCAN_BLOCK <= max && a.slice(i, i + SCAN_BLOCK) === b.slice(i, i + SCAN_BLOCK)) i += SCAN_BLOCK;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * Length of the common suffix of a and b, capped at `max`, scanning backward.
 * aLen/bLen are the full lengths of a/b (passed in so callers that already know
 * them avoid a property read in the hot loop).
 */
export function commonSuffixLen(a, b, max, aLen, bLen) {
  let s = 0;
  while (s + SCAN_BLOCK <= max && a.slice(aLen - s - SCAN_BLOCK, aLen - s) === b.slice(bLen - s - SCAN_BLOCK, bLen - s)) s += SCAN_BLOCK;
  while (s < max && a.charCodeAt(aLen - 1 - s) === b.charCodeAt(bLen - 1 - s)) s++;
  return s;
}

/**
 * The minimal changed window between preCode and effectiveCode: the slice
 * bounded by the common prefix and common suffix. Returns { at, preWin, postWin }
 * where `at` is the byte offset of the window start (identical in both strings,
 * since the prefix is shared). For a multi-edit patch the window spans from the
 * first to the last changed byte — correct, never under-covering.
 *
 * Returns null when the strings are identical (no change).
 */
export function changedWindow(preCode, effectiveCode) {
  if (preCode === effectiveCode) return null;
  const preLen = preCode.length;
  const postLen = effectiveCode.length;
  const maxPre = Math.min(preLen, postLen);
  const at = commonPrefixLen(preCode, effectiveCode, maxPre);
  const suf = commonSuffixLen(preCode, effectiveCode, maxPre - at, preLen, postLen);
  return {
    at,
    preWin: preCode.slice(at, preLen - suf),
    postWin: effectiveCode.slice(at, postLen - suf),
  };
}
