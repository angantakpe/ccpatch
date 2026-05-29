// Single verify primitive shared by all three call sites.
//
// Historically present/absent/count assertions were implemented THREE times,
// with subtly divergent issue strings:
//   - runner.mjs    checkVerify()       — 'expected present: '/'expected absent: '
//                                         + count '... (across K string(s))'
//   - anchors.mjs   checkVerifyLocal()  — 'verify.present missing: '
//                                         /'verify.absent still present: '
//                                         + count WITHOUT the 'across' suffix
//   - verify-batch  verifyBatch()       — same strings as runner.mjs, but driven
//                                         off a single-pass positions Map.
//
// checkVerifyCore() consolidates the logic in ONE place while preserving every
// caller's exact strings via the `opts.style` selector ('default' | 'local').
// verifyBatch passes its pre-computed `opts.positions` Map so the count /
// present / absent decisions reuse the recorded offsets instead of re-scanning.

/** Normalize a string|string[]|undefined into a string[] of non-empty strings. */
export function toList(x) {
  if (x === undefined || x === null) return [];
  const arr = Array.isArray(x) ? x : [x];
  return arr;
}

/** Count non-overlapping occurrences of `needle` in `haystack` (0 when empty). */
export function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
  return n;
}

// Per-style message templates. `default` mirrors runner.mjs / verify-batch.mjs;
// `local` mirrors anchors.mjs checkVerifyLocal (different prefixes + no
// 'across' suffix on the count messages).
const STYLES = {
  default: {
    present: (s) => `expected present: ${s.slice(0, 60)}`,
    absent:  (s) => `expected absent: ${s.slice(0, 60)}`,
    countPresent: (want, got, k) => `expected count.present=${want}, actual=${got} (across ${k} string(s))`,
    countAbsent:  (want, got, k) => `expected count.absent=${want}, actual=${got} (across ${k} string(s))`,
  },
  local: {
    present: (s) => `verify.present missing: ${s.slice(0, 60)}`,
    absent:  (s) => `verify.absent still present: ${s.slice(0, 60)}`,
    countPresent: (want, got) => `expected count.present=${want}, actual=${got}`,
    countAbsent:  (want, got) => `expected count.absent=${want}, actual=${got}`,
  },
};

/**
 * The one verify primitive. Evaluates present/absent/count assertions against
 * `code` and returns an array of human-readable issue strings (empty = pass).
 *
 * @param {{present?: string|string[], absent?: string|string[], count?: number|{present?: number, absent?: number}}} verify
 * @param {string} code
 * @param {{positions?: Map<string, number[]>, style?: 'default'|'local'}} [opts]
 * @returns {string[]}
 */
export function checkVerifyCore(verify, code, opts = {}) {
  const style = STYLES[opts.style] || STYLES.default;
  const positions = opts.positions || null;

  // Occurrence count for a literal: prefer the recorded single-pass positions,
  // else fall back to a fresh indexOf scan. Both keyings are code-unit based so
  // results are identical.
  const occ = (s) => {
    if (positions) {
      const list = positions.get(s);
      return list ? list.length : 0;
    }
    return countOccurrences(code, s);
  };
  // Presence test. With a positions Map, presence == recorded occurrence > 0
  // (verify-batch pre-filters empty literals, so this matches its behavior).
  // Without positions, defer to String.includes() so the empty-string edge
  // case stays byte-identical to the original checkVerify/checkVerifyLocal.
  const has = positions ? (s) => occ(s) > 0 : (s) => code.includes(s);

  const issues = [];
  const presents = toList(verify.present);
  const absents  = toList(verify.absent);

  for (const s of presents) {
    if (!has(s)) issues.push(style.present(s));
  }
  for (const s of absents) {
    if (has(s)) issues.push(style.absent(s));
  }

  if (verify.count !== undefined && verify.count !== null) {
    const c = typeof verify.count === 'number' ? { present: verify.count } : verify.count;
    if (typeof c.present === 'number') {
      const total = presents.reduce((n, s) => n + occ(s), 0);
      if (total !== c.present) {
        issues.push(style.countPresent(c.present, total, presents.length));
      }
    }
    if (typeof c.absent === 'number') {
      const total = absents.reduce((n, s) => n + occ(s), 0);
      if (total !== c.absent) {
        issues.push(style.countAbsent(c.absent, total, absents.length));
      }
    }
  }

  return issues;
}
