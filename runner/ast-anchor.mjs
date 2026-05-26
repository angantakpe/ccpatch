// runner/ast-anchor.mjs
import { findClosingBrace } from './brace-walker.mjs';
import { getAst } from './ast-cache.mjs';

/**
 * Per-bundle literal→offset index.
 *
 * findFunctionByLiteral() previously called code.indexOf(needle, 0) on every
 * invocation. For a 16 MB bundle and 30+ declarative patches each searching
 * for multiple literals, that's a lot of redundant scans. We lazily build a
 * literal→offsets[] index keyed by the bundle's string identity and reuse
 * it for the lifetime of that bundle. The index is intentionally scoped per
 * `code` value (WeakMap-style via identity check) — when the runner mutates
 * the bundle string a new instance is created and the index naturally
 * invalidates.
 */
let bundleIndexCode = null;
let bundleIndexMap = null;   // Map<literal, number[]>

/**
 * Reset the cached per-bundle index. Called from the runner between bundles
 * to avoid pinning stale references; not required for correctness (identity
 * check below covers it) but useful for test isolation.
 */
export function resetBundleIndex() {
  bundleIndexCode = null;
  bundleIndexMap = null;
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
  if (bundleIndexCode !== code) {
    bundleIndexCode = code;
    bundleIndexMap = new Map();
  }
  let hits = bundleIndexMap.get(needle);
  if (hits === undefined) {
    hits = indexOfAll(code, needle);
    bundleIndexMap.set(needle, hits);
  }
  return hits;
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
    // Scan backward for nearest 'function' keyword before the literal.
    const windowStart = Math.max(0, litIdx - 400);
    const back = code.slice(windowStart, litIdx);
    const relFnKw = back.lastIndexOf('function ');
    if (relFnKw === -1) continue;
    const fnStart = windowStart + relFnKw;

    // Find the opening brace of the function body (skip name + params).
    const openBrace = code.indexOf('{', fnStart + 8);
    if (openBrace === -1 || openBrace > litIdx) continue;

    // Find the matching closing brace.
    const closePos = findClosingBrace(code, openBrace);
    if (closePos === -1 || litIdx > closePos) continue;

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
