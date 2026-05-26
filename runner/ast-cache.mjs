// runner/ast-cache.mjs
//
// Tiny AST cache shared by ast-anchor.mjs, patch-kinds.mjs, and at-selector.mjs.
//
// Without this, the same windowed function text is re-parsed by Acorn up to
// four times per declarative patch (literal probe → locateTarget → postfix
// rewrite → resolveAt collectReturns). For a 60-line minified function the
// parse is cheap individually but multiplied across 30+ patches it dominates
// per-bundle apply time.
//
// Keying:
//   The cache is a WeakMap keyed by the bundle `code` string's identity, with
//   each entry mapping `${start}:${end}` to the parsed AST. When the runner
//   replaces the bundle string, GC drops the entry automatically and we don't
//   risk returning a stale AST for mutated source.
//
// Note: V8 only stores strings as WeakMap keys when wrapped — strings are
// primitives. We work around this by keeping a single per-process Map keyed
// by a sentinel object plus identity check, but since we can't take a weak
// ref to a string in standard JS, we fall back to: cache the LAST `code` we
// saw plus a per-`code` Map. When `code` changes, drop the prior Map.

import * as acorn from 'acorn';

let cachedCode = null;
let cachedAstByRange = null; // Map<`${start}:${end}`, AST>

/**
 * Get (or compute and cache) the Acorn AST for the function text at
 * code.slice(start, end). The text MUST be `(${fnText})` parseable as a
 * top-level expression — every caller in ccpatch wraps that way already.
 *
 * @param {string} code     - Bundle source. Used as the cache identity key.
 * @param {number} start    - Start offset of the function text in `code`.
 * @param {number} end      - End offset (exclusive) of the function text.
 * @param {string} [fnText] - Optional pre-sliced text; defaults to code.slice.
 * @returns {object} Acorn Program node from parsing `(${fnText})`.
 */
export function getAst(code, start, end, fnText) {
  if (cachedCode !== code) {
    cachedCode = code;
    cachedAstByRange = new Map();
  }
  const key = `${start}:${end}`;
  let ast = cachedAstByRange.get(key);
  if (ast !== undefined) return ast;
  const text = fnText !== undefined ? fnText : code.slice(start, end);
  ast = acorn.parse(`(${text})`, {
    ecmaVersion: 'latest',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: true,
  });
  cachedAstByRange.set(key, ast);
  return ast;
}

/**
 * Clear the AST cache. Useful for test isolation; not required for
 * correctness in production since the identity check above invalidates
 * automatically when the bundle string changes.
 */
export function resetAstCache() {
  cachedCode = null;
  cachedAstByRange = null;
}
