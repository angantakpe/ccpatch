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
 * identity cache: sequential applies share the same string reference so the
 * front slot hits 100% of the time in the common case; up to MAX_BUNDLE_SLOTS
 * interleaved bundles stay cached (see the concurrency contract below).
 *
 * No hashing at all: the previous implementation keyed a Map by a SHA1 digest
 * of the bundle (≈16 MB hashed per miss) and maintained a one-slot
 * (lastCodeRef, lastDigest) identity memo in front of it. The digest was
 * computing ~20 ms per call whenever the memo missed. In practice the runner
 * passes `nextCode = effectiveCode` directly as the next patch's `preCode`
 * (same string reference), so the identity check hits 100% within a sequential
 * apply run. The full digest + Map machinery is therefore unnecessary: a single
 * (ref, index) slot with an identity (===) guard does the same job with zero
 * hashing cost and zero retained bundle strings as Map keys.
 */

/**
 * CONCURRENCY CONTRACT: bounded move-to-front identity cache keyed on string
 * reference (===). The sequential single-bundle case (each apply() passes the
 * previous apply()'s output string onward) hits slot 0 on the first === — the
 * exact cost profile of the old single slot. Up to MAX_BUNDLE_SLOTS distinct
 * bundle strings can be live at once without thrashing, so interleaved callers
 * (e.g. a future parallelized apply pipeline, or doctor probing pristine +
 * patched bundles alternately) keep their indexes instead of degrading to
 * O(bundle) per call. The (K+1)-th live bundle evicts the least-recently-used
 * slot — correctness is preserved (a miss recomputes), and the eviction is
 * reported once per process so the degradation is never silent (the old slot
 * thrashed silently unless CCPATCH_ASSERT_SERIAL was set; that env var now
 * upgrades the once-only warning to every-eviction).
 *
 * All functions here are synchronous, so single-threaded interleaving is safe;
 * the module is still NOT shareable across worker_threads (each thread gets
 * its own module state anyway).
 */
const MAX_BUNDLE_SLOTS = 4;
/** @type {Array<{ ref: string, index: Map<string, number[]> }>} */
let _bundleSlots = [];
let _evictionWarned = false;

/**
 * Reset the cached per-bundle index. Useful for test isolation.
 * Kept exported (signature locked) for tests and any future wiring.
 */
export function resetBundleIndex() {
  _bundleSlots = [];
  _evictionWarned = false;
}

/**
 * Fetch (or lazily create) the literal→offsets map for a given `code` string.
 * Move-to-front over at most MAX_BUNDLE_SLOTS identity-keyed slots.
 */
function indexForCode(code) {
  for (let i = 0; i < _bundleSlots.length; i++) {
    if (_bundleSlots[i].ref === code) {
      if (i > 0) {
        const [slot] = _bundleSlots.splice(i, 1);
        _bundleSlots.unshift(slot);
      }
      return _bundleSlots[0].index;
    }
  }
  if (_bundleSlots.length >= MAX_BUNDLE_SLOTS) {
    _bundleSlots.pop();
    if (!_evictionWarned || process.env.CCPATCH_ASSERT_SERIAL) {
      _evictionWarned = true;
      process.stderr.write(
        `[ccpatch] WARNING: ast-anchor bundle-index cache evicting — more than ${MAX_BUNDLE_SLOTS} ` +
        'distinct bundles live at once; literal lookups on the evicted bundle degrade to full rescans.\n'
      );
    }
  }
  const index = new Map();
  _bundleSlots.unshift({ ref: code, index });
  return index;
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
 * False: the bounded identity cache makes single-threaded interleaving safe
 * (up to MAX_BUNDLE_SLOTS live bundles without degradation), but the module
 * still must not be shared across worker_threads.
 * @knipignore Documented concurrency-contract marker retained for callers/tests
 *   that assert this module's threading guarantee by name.
 */
export const AST_ANCHOR_CONCURRENCY_SAFE = false;

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
