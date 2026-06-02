// runner/ast-anchor.mjs
import { createHash } from 'node:crypto';
import { findClosingBrace } from './brace-walker.mjs';
import { getAst } from './ast-cache.mjs';

/**
 * Per-bundle literal→offset index.
 *
 * findFunctionByLiteral() previously called code.indexOf(needle, 0) on every
 * invocation. For a 16 MB bundle and 30+ declarative patches each searching
 * for multiple literals, that's a lot of redundant scans. We lazily build a
 * literal→offsets[] index keyed by the bundle's `code` string and reuse it
 * for the lifetime of that bundle.
 *
 * The original implementation kept a single (bundleIndexCode, bundleIndexMap)
 * pair: a 1-entry process-global. When two bundles were processed in an
 * interleaved fashion (e.g. concurrent applyNamedPatches calls, or a verify
 * pass against pre/post snapshots), every cross-bundle call thrashed the
 * single slot — discarding a freshly-built index and rebuilding from scratch.
 *
 * We now keep a real per-code cache. The spec calls for a
 * `WeakMap<code, Map<literal, number[]>>`, but JS WeakMap keys MUST be objects
 * (or symbols) — a raw string primitive is rejected. Since findFunctionByLiteral
 * takes a raw string and its signature is locked, we use the practical
 * equivalent: a plain Map keyed by a short content DIGEST of the bundle, bounded
 * by a small LRU so distinct interleaved bundles coexist without evicting each
 * other. resetBundleIndex() clears the whole cache for test isolation.
 *
 * Why a digest key (not the raw `code` string):
 *   Keying a Map directly on the full ~16 MB bundle string is subtle and costly.
 *   It relies on V8 lazily caching each string's hash to avoid an O(n) rehash on
 *   every Map probe, and — more importantly — it pins up to MAX_CACHED_BUNDLES
 *   *entire* 16 MB bundle strings alive as Map keys (≈128 MB of retained source).
 *   Replacing the key with a fixed-width sha1 hex digest keeps only the small
 *   digest strings as keys; the bundle source itself can be GC'd as soon as the
 *   caller drops it. sha1 (not a fast non-crypto hash) is deliberate: a key
 *   collision here would return another bundle's literal→offset map and corrupt
 *   the patch, so we want a real cryptographic digest's collision resistance.
 *
 * Digest cost / memoization tradeoff:
 *   Hashing 16 MB is itself an O(n) scan, so naively digesting on every call
 *   would erase the win (findFunctionByLiteral is called many times per bundle).
 *   A WeakMap<code, digest> would be ideal but string keys are illegal there.
 *   Instead we memoize the SINGLE most-recent (codeRef, digest) pair via an
 *   identity (===) check: consecutive calls within the same bundle reuse the
 *   cached digest and never rehash. The common access pattern is exactly that —
 *   one bundle string processed by a burst of calls — so this one-slot identity
 *   cache eliminates essentially all redundant hashing. Interleaving two bundles
 *   would defeat the memo and rehash on each switch; that is rare and still
 *   correct, just O(n) on the switch.
 */
const MAX_CACHED_BUNDLES = 8;
const bundleIndexCache = new Map(); // Map<digest, Map<literal, number[]>>, insertion-ordered LRU

// One-slot identity memo for the last hashed bundle, so repeated calls with the
// SAME string object skip the O(n) rehash. Identity (===) only — a different
// string object with identical content correctly rehashes (and yields the same
// digest, hence the same cache entry).
let lastCodeRef = null;
let lastDigest = null;

function digestOf(code) {
  if (code === lastCodeRef) return lastDigest;
  const digest = createHash('sha1').update(code).digest('hex');
  lastCodeRef = code;
  lastDigest = digest;
  return digest;
}

/**
 * Reset the cached per-bundle index. Useful for test isolation; clears every
 * cached bundle. Note: there are currently no in-repo runner callers — the
 * per-code keying above already prevents cross-bundle thrash without an
 * explicit reset. Kept exported (signature locked) for tests and any future
 * wiring.
 */
export function resetBundleIndex() {
  bundleIndexCache.clear();
  // Drop the identity memo too, so a post-reset call recomputes cleanly.
  lastCodeRef = null;
  lastDigest = null;
}

/**
 * Fetch (or lazily create) the literal→offsets map for a given `code` string,
 * touching it as most-recently-used and evicting the oldest bundle when the
 * cache exceeds MAX_CACHED_BUNDLES. Keyed by the bundle's content digest (see
 * the digestOf memo above) rather than the raw 16 MB string.
 */
function indexForCode(code) {
  const key = digestOf(code);
  let litMap = bundleIndexCache.get(key);
  if (litMap === undefined) {
    litMap = new Map();
    bundleIndexCache.set(key, litMap);
    if (bundleIndexCache.size > MAX_CACHED_BUNDLES) {
      // Evict the least-recently-used (oldest insertion) bundle.
      const oldestKey = bundleIndexCache.keys().next().value;
      bundleIndexCache.delete(oldestKey);
    }
  } else {
    // Mark as most-recently-used: re-insert to move to the end of the order.
    bundleIndexCache.delete(key);
    bundleIndexCache.set(key, litMap);
  }
  return litMap;
}

function indexOfAll(code, needle, cap = 64) {
  // Bounded: most literals appear a handful of times. Cap guards against
  // pathological literals (e.g. very short tokens) blowing memory.
  const out = [];
  let from = 0;
  while (out.length < cap) {
    const idx = code.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + 1;
  }
  return out;
}

function offsetsFor(code, needle) {
  const litMap = indexForCode(code);
  let hits = litMap.get(needle);
  if (hits === undefined) {
    hits = indexOfAll(code, needle);
    litMap.set(needle, hits);
  }
  return hits;
}

/**
 * Memoized equivalent of `code.indexOf(needle)`: returns the first offset of
 * `needle` in `code`, or -1 if absent. Routes through the same per-code
 * offset index that findFunctionByLiteral uses, so repeated lookups for the
 * same (code, needle) — e.g. at-selector's named-function resolveFunction and
 * resolveInvoke both resolving the same `function NAME(` — never rescan the
 * full bundle. indexOfAll caps recorded hits but always captures hit[0] first,
 * so hits[0] is exactly code.indexOf(needle).
 */
export function firstOffsetOf(code, needle) {
  const hits = offsetsFor(code, needle);
  return hits.length > 0 ? hits[0] : -1;
}

/**
 * Find the `function ` keyword (start offset) of the INNERMOST function whose
 * body encloses `litIdx`.
 *
 * Why this replaces the old fixed 400-byte backward window: the old code did
 * `windowStart = litIdx - 400; back.lastIndexOf('function ')` and took the
 * single nearest keyword. 400 bytes was chosen as a cheap cap to (a) avoid
 * scanning the whole 16 MB bundle backward and (b) avoid false matches from
 * far-away `function ` keywords. But it is a CORRECTNESS ceiling, not a perf
 * knob: a literal genuinely inside a large (e.g. minified) function whose
 * `function ` keyword sits >400 bytes earlier would silently fail to resolve →
 * no-op → drift.
 *
 * Robust approach: enumerate candidate `function ` keyword starts BEFORE the
 * literal (nearest first) and use the existing brace-walker to verify which one
 * actually ENCLOSES the literal — i.e. litIdx lies between the body's opening
 * brace and its matching close. The FIRST (nearest) such keyword is the
 * innermost enclosing function. We grow the backward window adaptively (so we
 * stay cheap for the common small-function case) and only keep expanding while
 * we have not yet found an enclosing function, up to a sane cap. A literal that
 * is not inside ANY function still resolves to null.
 *
 * @param {string} code    - Full bundle source
 * @param {number} litIdx  - Offset of the anchor inside `code`
 * @returns {{ fnStart: number, openBrace: number, closePos: number } | null}
 */
function enclosingFunctionStarts(code, litIdx) {
  // Adaptive window: start small (covers the overwhelming common case cheaply),
  // double on each miss, cap well above any realistic single minified function.
  const INITIAL = 400;
  const CAP = 1 << 20; // 1 MiB — generous ceiling for one enclosing function.
  let window = INITIAL;

  // Each iteration we only scan the NEWLY-exposed band [windowStart, prevStart)
  // for `function ` keyword STARTS (the prior band's keywords were already
  // collected and rejected as non-enclosing). `prevStart` is the lowest keyword
  // start already considered; on the first pass it is litIdx (the original code
  // sliced [windowStart, litIdx), so a keyword had to fully fit before litIdx —
  // i.e. start <= litIdx - 9). This keeps the total scan linear in the final
  // window size instead of re-scanning the whole enlarged window from scratch
  // each miss.
  //
  // We search `code` directly (not a slice) so a `function ` keyword that
  // straddles the band's upper boundary is matched against the real bytes that
  // follow, then bound by `start < prevStart` — avoiding the slice-truncation
  // gap a `code.slice(windowStart, prevStart)` would create at prevStart-8.
  let prevStart = litIdx;
  for (;;) {
    const windowStart = Math.max(0, litIdx - window);
    // Collect every `function ` keyword start in [windowStart, prevStart), then
    // test nearest-to-literal first so the INNERMOST enclosing function wins.
    const candidates = [];
    let pos = code.indexOf('function ', windowStart);
    while (pos !== -1 && pos < prevStart) {
      candidates.push(pos);
      pos = code.indexOf('function ', pos + 1);
    }
    for (let k = candidates.length - 1; k >= 0; k--) {
      const fnStart = candidates[k];
      const openBrace = code.indexOf('{', fnStart + 8);
      if (openBrace === -1 || openBrace > litIdx) continue;
      const closePos = findClosingBrace(code, openBrace);
      if (closePos === -1 || litIdx > closePos) continue;
      return { fnStart, openBrace, closePos };
    }

    // No enclosing function in this window. Stop once we've scanned back to the
    // start of the file (whole prefix covered) or hit the cap; otherwise grow.
    if (windowStart === 0 || window >= CAP) return null;
    prevStart = windowStart;
    window *= 2;
  }
}

/**
 * Find the innermost named function in `code` whose body contains `literal`
 * as a string argument.
 *
 * Why no regex: minifiers rotate variable names but cannot rename string
 * literals. Anchoring on the literal and extracting the enclosing function
 * via brace counting + Acorn parse gives AST-level confidence without
 * parsing the full 16MB bundle.
 *
 * @param {string} code    - Full bundle source
 * @param {string} literal - Stable string literal to search for (without quotes)
 * @returns {{ name: string|null, start: number, end: number } | null}
 *   start: offset of 'function' keyword in code
 *   end:   offset after the closing '}' of that function
 */
export function findFunctionByLiteral(code, literal) {
  const needle = JSON.stringify(literal); // adds quotes + escaping
  const hits = offsetsFor(code, needle);

  for (const litIdx of hits) {
    const encl = enclosingFunctionStarts(code, litIdx);
    if (!encl) continue;
    const { fnStart, closePos } = encl;

    // Parse the extracted function text with Acorn to validate structure and get the name.
    const fnText = code.slice(fnStart, closePos + 1);
    let name = null;
    try {
      const ast = getAst(code, fnStart, closePos + 1, fnText);
      const expr = ast.body[0]?.expression;
      if (expr && (expr.type === 'FunctionExpression' || expr.type === 'FunctionDeclaration')) {
        name = expr.id?.name ?? null;
      }
      // If Acorn parsed it but it's not a function expression, skip this hit.
      if (!expr || (expr.type !== 'FunctionExpression' && expr.type !== 'FunctionDeclaration')) {
        continue;
      }
    } catch (_) {
      // Parse failed — try a quick regex fallback to extract the name.
      const nm = fnText.match(/^function\s*([\w$]+)\s*\(/);
      name = nm?.[1] ?? null;
      // If we can't even get a name, skip this hit.
      if (!name) continue;
    }

    return { name, start: fnStart, end: closePos + 1 };
  }
  return null;
}

/**
 * Shared helper: locate the innermost function whose body encloses an anchor.
 * Exported for sibling resolvers (patch-kinds.mjs findFunctionByBodySubstring)
 * so the adaptive-window logic lives in exactly one place.
 *
 * @param {string} code   - Full bundle source
 * @param {number} anchor - Offset of the anchor inside `code`
 * @returns {{ name: string|null, start: number, end: number } | null}
 */
export function findEnclosingFunction(code, anchor) {
  const encl = enclosingFunctionStarts(code, anchor);
  if (!encl) return null;
  const { fnStart, closePos } = encl;
  const fnText = code.slice(fnStart, closePos + 1);
  const nm = fnText.match(/^function\s*([\w$]+)?\s*\(/);
  const name = nm?.[1] ?? null;
  return { name, start: fnStart, end: closePos + 1 };
}
