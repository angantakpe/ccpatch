// runner/ast-anchor.mjs
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
 * equivalent: a plain `Map<code, Map<literal, number[]>>` bounded by a small
 * LRU so distinct interleaved bundles coexist without evicting each other,
 * while still letting old bundle strings be GC'd once they age out of the LRU.
 * resetBundleIndex() clears the whole cache for test isolation.
 */
const MAX_CACHED_BUNDLES = 8;
const bundleIndexCache = new Map(); // Map<code, Map<literal, number[]>>, insertion-ordered LRU

/**
 * Reset the cached per-bundle index. Useful for test isolation; clears every
 * cached bundle. Note: there are currently no in-repo runner callers — the
 * per-code keying above already prevents cross-bundle thrash without an
 * explicit reset. Kept exported (signature locked) for tests and any future
 * wiring.
 */
export function resetBundleIndex() {
  bundleIndexCache.clear();
}

/**
 * Fetch (or lazily create) the literal→offsets map for a given `code` string,
 * touching it as most-recently-used and evicting the oldest bundle when the
 * cache exceeds MAX_CACHED_BUNDLES.
 */
function indexForCode(code) {
  let litMap = bundleIndexCache.get(code);
  if (litMap === undefined) {
    litMap = new Map();
    bundleIndexCache.set(code, litMap);
    if (bundleIndexCache.size > MAX_CACHED_BUNDLES) {
      // Evict the least-recently-used (oldest insertion) bundle.
      const oldestKey = bundleIndexCache.keys().next().value;
      bundleIndexCache.delete(oldestKey);
    }
  } else {
    // Mark as most-recently-used: re-insert to move to the end of the order.
    bundleIndexCache.delete(code);
    bundleIndexCache.set(code, litMap);
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

  for (;;) {
    const windowStart = Math.max(0, litIdx - window);
    const back = code.slice(windowStart, litIdx);
    // Collect every `function ` keyword offset in this slice, then test
    // nearest-to-literal first so the INNERMOST enclosing function wins.
    const candidates = [];
    let rel = back.indexOf('function ');
    while (rel !== -1) {
      candidates.push(windowStart + rel);
      rel = back.indexOf('function ', rel + 1);
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
