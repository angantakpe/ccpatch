// Single-pass batched verifier.
//
// The legacy per-patch checkVerify() re-walks the entire bundle once for every
// `verify.present` / `verify.absent` literal — with ~90 enabled patches each
// declaring 1–2 strings, that's ~180 full bundle scans per build (cli.js is
// ~10MB so this is genuinely measurable).
//
// This module collapses all of those scans into ONE linear walk over the
// final code string. It builds a union of unique literals across every patch,
// scans the code once recording all hit offsets per literal, then satisfies
// each patch's assertions from the recorded hits.
//
// Algorithm: bucket every literal by its first 2 characters and walk the code
// byte by byte; at each position, consult the bucket keyed on code[i..i+2] and
// try-match each candidate literal. Buckets keep the per-position work small
// even when the literal set is large. Pre-existing single-pass implementations
// (Aho-Corasick) would be faster on pathological inputs but materially harder
// to read for a ~200x speedup that's already plenty.

function countOccurrencesIn(positions) {
  return positions ? positions.length : 0;
}

function toList(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

/**
 * Build the union literal index used by both the scan and the per-patch
 * satisfaction step.
 *
 * @param {Array<{patchName: string, present?: string[], absent?: string[], count?: any}>} items
 * @returns {{
 *   literals: string[],            // unique, length >= 1
 *   bucketsByPrefix: Map<string, string[]>,
 *   prefixLen: number,
 * }}
 */
function buildLiteralIndex(items) {
  const uniq = new Set();
  for (const it of items) {
    for (const s of toList(it.present)) if (typeof s === 'string' && s.length > 0) uniq.add(s);
    for (const s of toList(it.absent))  if (typeof s === 'string' && s.length > 0) uniq.add(s);
  }
  const literals = [...uniq];
  // Shortest literal length caps prefix size; anything shorter than the prefix
  // gets bucketed separately under its own length-key (handled in scan).
  const prefixLen = 2;
  const bucketsByPrefix = new Map();
  for (const lit of literals) {
    const key = lit.length >= prefixLen ? lit.slice(0, prefixLen) : `__SHORT__${lit}`;
    let arr = bucketsByPrefix.get(key);
    if (!arr) { arr = []; bucketsByPrefix.set(key, arr); }
    arr.push(lit);
  }
  return { literals, bucketsByPrefix, prefixLen };
}

/**
 * Scan `code` once and record every offset at which each literal occurs.
 *
 * @param {string} code
 * @param {ReturnType<typeof buildLiteralIndex>} index
 * @returns {Map<string, number[]>}
 */
function scanCode(code, index) {
  const positions = new Map();
  for (const lit of index.literals) positions.set(lit, []);

  // Short literals (< prefixLen) are uncommon; handle with one-shot indexOf.
  for (const lit of index.literals) {
    if (lit.length < index.prefixLen) {
      const list = positions.get(lit);
      let idx = 0;
      while ((idx = code.indexOf(lit, idx)) !== -1) {
        list.push(idx);
        idx += lit.length;
      }
    }
  }

  // Main single-pass walk for literals >= prefixLen.
  const n = code.length;
  const plen = index.prefixLen;
  const last = n - plen;
  for (let i = 0; i <= last; i++) {
    const key = code.slice(i, i + plen);
    const bucket = index.bucketsByPrefix.get(key);
    if (!bucket) continue;
    for (const lit of bucket) {
      // Inline startsWith to avoid the slice allocation cost in hot path.
      const L = lit.length;
      if (i + L > n) continue;
      let ok = true;
      // Skip the prefix chars we already matched via the bucket key.
      for (let j = plen; j < L; j++) {
        if (code.charCodeAt(i + j) !== lit.charCodeAt(j)) { ok = false; break; }
      }
      if (ok) positions.get(lit).push(i);
    }
  }
  return positions;
}

/**
 * Run all per-patch verify assertions in a single pass over `code`.
 *
 * Returns an array shaped `[{ name, issues: string[] }]`, with one entry per
 * input item (issues empty when the patch passed). Mirrors checkVerify()'s
 * issue strings so callers can route them unchanged.
 *
 * @param {string} code
 * @param {Array<{patchName: string, present?: string[]|string, absent?: string[]|string, count?: any}>} items
 * @returns {Array<{ name: string, issues: string[] }>}
 */
export function verifyBatch(code, items) {
  const norm = items.map((it) => ({
    name: it.patchName,
    present: toList(it.present).filter((s) => typeof s === 'string' && s.length > 0),
    absent:  toList(it.absent).filter((s) => typeof s === 'string' && s.length > 0),
    count: it.count,
  }));

  const index = buildLiteralIndex(norm);
  const positions = index.literals.length > 0 ? scanCode(code, index) : new Map();

  const out = [];
  for (const it of norm) {
    const issues = [];
    for (const s of it.present) {
      if (countOccurrencesIn(positions.get(s)) === 0) {
        issues.push(`expected present: ${s.slice(0, 60)}`);
      }
    }
    for (const s of it.absent) {
      if (countOccurrencesIn(positions.get(s)) > 0) {
        issues.push(`expected absent: ${s.slice(0, 60)}`);
      }
    }
    if (it.count !== undefined && it.count !== null) {
      const c = typeof it.count === 'number' ? { present: it.count } : it.count;
      if (typeof c.present === 'number') {
        const total = it.present.reduce((n, s) => n + countOccurrencesIn(positions.get(s)), 0);
        if (total !== c.present) {
          issues.push(`expected count.present=${c.present}, actual=${total} (across ${it.present.length} string(s))`);
        }
      }
      if (typeof c.absent === 'number') {
        const total = it.absent.reduce((n, s) => n + countOccurrencesIn(positions.get(s)), 0);
        if (total !== c.absent) {
          issues.push(`expected count.absent=${c.absent}, actual=${total} (across ${it.absent.length} string(s))`);
        }
      }
    }
    out.push({ name: it.name, issues });
  }
  return out;
}
