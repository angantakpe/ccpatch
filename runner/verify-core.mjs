// Single verify primitive + the ONE literal-matching kernel shared by all
// call sites.
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
// checkVerifyCore() consolidates the assertion logic in ONE place while
// preserving every caller's exact strings via the `opts.style` selector
// ('default' | 'local'). verifyBatch passes a pre-computed `opts.positions`
// Map so the count / present / absent decisions reuse recorded offsets
// instead of re-scanning.
//
// The MATCHING side was likewise duplicated: countOccurrences() here and the
// bucketing/scan walk in verify-batch.mjs each re-implemented "find every
// occurrence of a literal" — and they DIVERGED for self-overlapping literals
// ('aa' in 'aaa': non-overlapping counts 1, the old batch scan recorded 2),
// so the same count assertion could pass via checkVerify (onVerifyFail heal
// retry, anchors.mjs) and fail via verifyBatch (the phase flush), or vice
// versa. findOccurrences() / scanOccurrences() below are now the single
// kernel both paths compose: NON-OVERLAPPING, leftmost-first — the semantics
// countOccurrences always documented. Real verify literals are code snippets
// that never self-overlap, so in practice results are byte-identical to both
// predecessors; the unification only pins down the pathological case.

/** Normalize a string|string[]|undefined into a string[] of non-empty strings. */
export function toList(x) {
  if (x === undefined || x === null) return [];
  const arr = Array.isArray(x) ? x : [x];
  return arr;
}

/**
 * THE per-literal matching kernel: every NON-OVERLAPPING occurrence of
 * `needle` in `haystack`, leftmost-first (each match resumes scanning at its
 * own end — the classic indexOf walk). Returns the match offsets; empty for
 * an empty/missing needle.
 *
 * Everything that matches literals — countOccurrences, scanOccurrences'
 * fast path, and (by equivalence) its bucketed walk — derives from this
 * one definition, so present/absent/count semantics cannot drift apart again.
 */
export function findOccurrences(haystack, needle) {
  const out = [];
  if (!needle) return out;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    out.push(idx);
    idx += needle.length;
  }
  return out;
}

/** Count non-overlapping occurrences of `needle` in `haystack` (0 when empty). */
export function countOccurrences(haystack, needle) {
  return findOccurrences(haystack, needle).length;
}

// ── Multi-literal scan (moved here from verify-batch.mjs — task 1 dedup) ────
//
// The legacy per-patch checkVerify() re-walks the entire bundle once for every
// `verify.present` / `verify.absent` literal — with ~90 enabled patches each
// declaring 1–2 strings, that's ~180 full bundle scans per build (cli.js is
// ~10MB so this is genuinely measurable). scanOccurrences collapses all of
// those scans into ONE linear walk over the code string when the literal set
// is large, recording all hit offsets per literal.
//
// Algorithm: bucket every literal by its first 2 characters and walk the code
// byte by byte; at each position, consult the bucket keyed on code[i..i+2] and
// try-match each candidate literal. Buckets keep the per-position work small
// even when the literal set is large. Pre-existing single-pass implementations
// (Aho-Corasick) would be faster on pathological inputs but materially harder
// to read for a ~200x speedup that's already plenty.

// Shortest literal length caps prefix size; anything shorter than the prefix
// is handled by a one-shot findOccurrences (never bucketed).
const SCAN_PREFIX_LEN = 2;

// PERF (MEASURED 2026-06): the single-pass walk pays a FIXED O(code.length)
// cost — ~200ms on a 15MB bundle — that only amortizes when there are many
// literals to find in that one walk. But the runner verifies each mutating
// patch in its own snapshot group (see runner.mjs flushPendingVerify PERF2),
// so most groups carry just 1–2 literals; for those, the walk is ~34x slower
// than letting V8's native indexOf find each literal directly. At or below
// FAST_PATH_MAX, record positions per-literal via findOccurrences (the
// kernel itself).
const SCAN_FAST_PATH_MAX = 64;

/**
 * Build the union literal index used by the bucketed scan.
 *
 * Buckets are keyed by a numeric 2-char prefix
 * (charCodeAt(0)*65536+charCodeAt(1)) to avoid allocating a 2-char substring
 * per byte during the scan. The *65536 stride (not *256) keeps the key
 * injective for the full 16-bit code-unit range: with *256, prefixes like
 * (0,256) and (1,0) collide, which would over-populate a bucket for
 * non-Latin-1 literals and degrade the scan. (Correctness never depended on
 * the key — the walk re-verifies every char — but a clean key keeps buckets
 * tight.)
 */
function buildLiteralIndex(literals) {
  const bucketsByPrefix = new Map();
  const shortLits = [];
  for (const lit of literals) {
    if (lit.length < SCAN_PREFIX_LEN) { shortLits.push(lit); continue; }
    const key = lit.charCodeAt(0) * 65536 + lit.charCodeAt(1);
    let arr = bucketsByPrefix.get(key);
    if (!arr) { arr = []; bucketsByPrefix.set(key, arr); }
    arr.push(lit);
  }
  return { bucketsByPrefix, shortLits };
}

/**
 * Multi-literal form of the kernel: scan `code` once and record every
 * NON-OVERLAPPING occurrence offset of each literal — for every literal,
 * `scanOccurrences(code, lits).get(lit)` is deepEqual to
 * `findOccurrences(code, lit)`. Duplicate/empty literals are tolerated
 * (deduped; empty maps to []).
 *
 * @param {string} code
 * @param {Iterable<string>} literals
 * @returns {Map<string, number[]>}
 */
export function scanOccurrences(code, literals) {
  const uniq = [];
  const positions = new Map();
  for (const lit of literals) {
    if (typeof lit !== 'string' || positions.has(lit)) continue;
    positions.set(lit, []);
    if (lit.length > 0) uniq.push(lit);
  }

  // Small literal sets (the common per-snapshot case): per-literal indexOf via
  // the kernel directly — V8's vectorised indexOf beats the fixed-cost walk.
  if (uniq.length <= SCAN_FAST_PATH_MAX) {
    for (const lit of uniq) positions.set(lit, findOccurrences(code, lit));
    return positions;
  }

  const { bucketsByPrefix, shortLits } = buildLiteralIndex(uniq);
  // Short literals (< SCAN_PREFIX_LEN) are uncommon; handle with the kernel.
  for (const lit of shortLits) positions.set(lit, findOccurrences(code, lit));

  // Main single-pass walk for large literal sets: one linear scan amortized
  // across all literals via the 2-char prefix buckets.
  const n = code.length;
  const last = n - SCAN_PREFIX_LEN;
  for (let i = 0; i <= last; i++) {
    // Numeric 2-char prefix key — same keying as buildLiteralIndex, no slice alloc.
    const key = code.charCodeAt(i) * 65536 + code.charCodeAt(i + 1);
    const bucket = bucketsByPrefix.get(key);
    if (!bucket) continue;
    for (const lit of bucket) {
      // Inline startsWith to avoid the slice allocation cost in hot path.
      const L = lit.length;
      if (i + L > n) continue;
      let ok = true;
      // Full char compare from 0: the prefix key only confirms the first two
      // chars, so we re-verify the whole literal to keep matches byte-identical.
      // (The *65536 stride makes the 2-char key itself collision-free, but the
      // full compare is still required for chars 2..L.)
      for (let j = 0; j < L; j++) {
        if (code.charCodeAt(i + j) !== lit.charCodeAt(j)) { ok = false; break; }
      }
      if (ok) {
        // Non-overlapping gate: `i` ascends monotonically, so suppressing any
        // match that starts inside the previous recorded match's extent
        // reproduces findOccurrences' leftmost-first walk EXACTLY — keeping
        // the walk and the fast path byte-identical for every literal,
        // including self-overlapping ones.
        const list = positions.get(lit);
        if (list.length === 0 || i >= list[list.length - 1] + L) list.push(i);
      }
    }
  }
  return positions;
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
  // else fall back to a fresh kernel scan. Both record non-overlapping
  // occurrences keyed by code units, so results are identical.
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
