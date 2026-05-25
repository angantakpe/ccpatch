/**
 * Generate fingerprints for module chunks.
 *
 * A fingerprint captures the identity of a module independent of
 * variable name mangling. It uses:
 * 1. Ordered sequence of string literal values (stable across versions)
 * 2. Set of unique strings (for fast candidate filtering)
 * 3. Code size metrics
 */

import { verbose, elapsed } from './utils.mjs';

/**
 * @typedef {Object} ModuleFingerprint
 * @property {string[]}    stringSequence  - ordered string literal values
 * @property {Set<string>} uniqueStrings   - set of string values in this module
 * @property {number}      codeLength      - character count of module body
 * @property {number}      stringCount     - number of string literals
 * @property {string}      sizeClass       - 'tiny'|'small'|'medium'|'large'|'huge'
 */

/**
 * Generate a fingerprint for a single module chunk.
 * @param {import('./module-segmenter.mjs').ModuleChunk} chunk
 * @returns {ModuleFingerprint}
 */
export function fingerprint(chunk) {
  const stringSequence = chunk.strings.map(s => s.value);
  const uniqueStrings = new Set(stringSequence);

  const len = chunk.code.length;
  let sizeClass;
  if (len < 200) sizeClass = 'tiny';
  else if (len < 2000) sizeClass = 'small';
  else if (len < 20000) sizeClass = 'medium';
  else if (len < 200000) sizeClass = 'large';
  else sizeClass = 'huge';

  return {
    stringSequence,
    uniqueStrings,
    codeLength: len,
    stringCount: stringSequence.length,
    sizeClass,
  };
}

/**
 * Generate fingerprints for all chunks.
 * @param {import('./module-segmenter.mjs').ModuleChunk[]} chunks
 * @returns {ModuleFingerprint[]}
 */
export function fingerprintAll(chunks) {
  const t0 = Date.now();
  const fps = chunks.map(c => fingerprint(c));
  verbose('fingerprint', `Generated ${fps.length} fingerprints in ${elapsed(t0)}`);
  return fps;
}

/**
 * Compute Jaccard similarity between two fingerprints based on string sets.
 * @param {ModuleFingerprint} a
 * @param {ModuleFingerprint} b
 * @returns {number} 0.0 to 1.0
 */
export function jaccardSimilarity(a, b) {
  if (a.uniqueStrings.size === 0 && b.uniqueStrings.size === 0) return 0;

  let intersection = 0;
  // Iterate the smaller set
  const [smaller, larger] = a.uniqueStrings.size <= b.uniqueStrings.size
    ? [a.uniqueStrings, b.uniqueStrings]
    : [b.uniqueStrings, a.uniqueStrings];

  for (const s of smaller) {
    if (larger.has(s)) intersection++;
  }

  const union = a.uniqueStrings.size + b.uniqueStrings.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compute ordered string sequence similarity using LCS ratio.
 * More precise than Jaccard — considers ordering.
 * @param {ModuleFingerprint} a
 * @param {ModuleFingerprint} b
 * @returns {number} 0.0 to 1.0
 */
export function sequenceSimilarity(a, b) {
  const seqA = a.stringSequence;
  const seqB = b.stringSequence;
  if (seqA.length === 0 && seqB.length === 0) return 0;
  if (seqA.length === 0 || seqB.length === 0) return 0;

  // For large sequences, use a fast approximate LCS
  // (full LCS is O(n*m) which can be slow for huge modules)
  if (seqA.length > 800 || seqB.length > 800) {
    return jaccardSimilarity(a, b); // fallback to Jaccard for huge modules
  }

  const lcsLen = lcsLength(seqA, seqB);
  return (2 * lcsLen) / (seqA.length + seqB.length);
}

/**
 * Compute LCS length between two string arrays.
 * Uses O(min(n,m)) space.
 */
function lcsLength(a, b) {
  if (a.length > b.length) [a, b] = [b, a]; // ensure a is shorter
  const m = a.length, n = b.length;
  let prev = new Array(m + 1).fill(0);
  let curr = new Array(m + 1).fill(0);

  for (let j = 1; j <= n; j++) {
    for (let i = 1; i <= m; i++) {
      if (a[i - 1] === b[j - 1]) {
        curr[i] = prev[i - 1] + 1;
      } else {
        curr[i] = Math.max(prev[i], curr[i - 1]);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }

  return prev[m];
}
