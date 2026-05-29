// runner/patch-kinds.mjs
//
// Declarative patch shapes, inspired by Harmony (.NET).
//
// A patch may declare one of four kinds:
//
//   - 'free'       (default): the patch exports a free-form `apply(code, opts) => string`.
//                  Same as before this module existed. Maximum power, maximum risk.
//
//   - 'prefix'     Inject `code` at the entry of the target function body
//                  (immediately after the opening `{`).
//
//   - 'postfix'    Wrap every `return X` inside the target function so the
//                  returned value flows through user code as `__r`:
//                    return X;          →  return (function(__r){ ...; return __r; })(X);
//                    return;             →  { ...; return; }   (void return)
//                  Arrow expression bodies `() => X` become `() => (function(__r){...; return __r;})(X)`.
//
//   - 'transpiler' Receive the target function's source text as a string,
//                  return a new string. Same flexibility as `apply()` but
//                  scoped to one function rather than the whole bundle.
//
// `compileKind(patch)` returns a synthesized `apply(code, opts)` for any
// non-free kind; the runner swaps `patch.apply` for this synthesized function
// so the rest of the pipeline (verify, no-change detection, reverse diff)
// keeps working unchanged.

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { findFunctionByLiteral, findEnclosingFunction } from './ast-anchor.mjs';
import { findClosingBrace } from './brace-walker.mjs';
import { getAst } from './ast-cache.mjs';

export const KINDS = ['free', 'prefix', 'postfix', 'transpiler'];

/**
 * Locate the target function in `code`. Returns { start, end, name } or null.
 * `target` may be:
 *   { function: { literal: 'STR' } }    — find by stable string literal in body
 *                                         (matches "STR" as a quoted string)
 *   { function: { body: 'SUBSTR' } }    — find the smallest function whose
 *                                         body contains SUBSTR verbatim
 *                                         (use this when no quoted literal
 *                                         anchors the function, e.g. property
 *                                         names like process.env.FOO).
 *   { function: 'name' } | { function: { name: 'name' } }
 *                                       — find first `function name(...) { ... }`
 */
export function locateTarget(code, target) {
  if (!target || !target.function) return null;
  const t = target.function;

  if (typeof t === 'object' && typeof t.literal === 'string') {
    return findFunctionByLiteral(code, t.literal);
  }

  if (typeof t === 'object' && typeof t.body === 'string') {
    return findFunctionByBodySubstring(code, t.body);
  }

  const name = typeof t === 'string' ? t : t.name;
  if (typeof name !== 'string' || !name) return null;

  const re = new RegExp(`function\\s+${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\(`);
  const m = code.match(re);
  if (!m) return null;
  const start = m.index;
  const openBrace = code.indexOf('{', start + m[0].length);
  if (openBrace === -1) return null;
  const end = findClosingBrace(code, openBrace);
  if (end === -1) return null;
  return { name, start, end: end + 1 };
}

/**
 * Find the innermost function whose body contains `needle` as a verbatim
 * substring (no quoting). Useful when the anchor is a property access like
 * `process.env.MAX_THINKING_TOKENS` rather than a string literal.
 */
function findFunctionByBodySubstring(code, needle) {
  let searchFrom = 0;
  while (searchFrom < code.length) {
    const hit = code.indexOf(needle, searchFrom);
    if (hit === -1) return null;

    // Use the shared adaptive enclosing-function resolver (ast-anchor.mjs)
    // instead of a fixed 400-byte backward window. The old fixed window was a
    // correctness ceiling: a substring genuinely inside a large minified
    // function whose `function ` keyword sits >400 bytes back would fail to
    // resolve → silent no-op → drift. The shared helper grows the window
    // adaptively and verifies enclosure via the brace-walker.
    const loc = findEnclosingFunction(code, hit);
    if (loc) return loc;

    // This occurrence is not inside any function; try the next occurrence.
    searchFrom = hit + 1;
  }
  return null;
}

/**
 * Rewrite every `return X;` (and void `return;`) inside `fnText` (the full
 * `function name(...) { ... }` source) so the return value flows through
 * the user-supplied `injected` code block as `__r`.
 *
 *   return X;     →  return (function(__r){ INJECTED; return __r; })(X);
 *   return;       →  { INJECTED; return; }
 *
 * Only top-level returns of the target function are rewritten; returns nested
 * inside other function expressions/declarations/arrows are left alone.
 */
export function rewriteReturns(fnText, injected, cacheKey) {
  // Wrap as `(fnText)` so Acorn parses it as an expression.
  // When the caller can supply { code, start, end } it lets us hit the shared
  // AST cache; otherwise we parse fnText directly (back-compat path used by
  // tests/patch-kinds.test.mjs).
  let ast;
  try {
    if (cacheKey && typeof cacheKey === 'object') {
      ast = getAst(cacheKey.code, cacheKey.start, cacheKey.end, fnText);
    } else {
      ast = acorn.parse(`(${fnText})`, {
        ecmaVersion: 'latest',
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
        ranges: true,
      });
    }
  } catch (err) {
    throw new Error(`postfix: could not parse target function: ${err.message}`);
  }

  const expr = ast.body[0]?.expression;
  if (!expr || (expr.type !== 'FunctionExpression' && expr.type !== 'FunctionDeclaration')) {
    throw new Error('postfix: target is not a function expression');
  }

  // Returns are reported with offsets into `(fnText)`. To map back to fnText
  // we subtract 1 (the opening `(`).
  const offset = -1;
  const edits = [];

  // We walk top-level only: descend into BlockStatement, IfStatement, etc., but
  // do NOT descend into nested functions (their returns belong to them, not us).
  walk.simple(expr.body, {
    ReturnStatement(node) {
      edits.push(node);
    },
  }, {
    ...walk.base,
    FunctionDeclaration: () => {},
    FunctionExpression: () => {},
    ArrowFunctionExpression: () => {},
  });

  if (edits.length === 0) return fnText;

  // Apply edits from end to start so offsets stay valid.
  edits.sort((a, b) => b.start - a.start);
  let out = fnText;
  for (const node of edits) {
    const s = node.start + offset;
    const e = node.end + offset;
    const slice = out.slice(s, e);
    if (node.argument) {
      // return X[;]
      const argStart = node.argument.start + offset;
      const argEnd = node.argument.end + offset;
      const argText = out.slice(argStart, argEnd);
      const trailing = out.slice(argEnd, e); // captures `;` if present
      const replacement = `return (function(__r){${injected};return __r})(${argText})${trailing.includes(';') ? ';' : ''}`;
      out = out.slice(0, s) + replacement + out.slice(e);
    } else {
      // void return
      const replacement = `{${injected};return${slice.endsWith(';') ? ';' : ''}}`;
      out = out.slice(0, s) + replacement + out.slice(e);
    }
  }

  return out;
}

/**
 * For an arrow function with an expression body — `(args) => X` — we need
 * special handling: there's no `return` token to rewrite, but the implicit
 * return still needs to flow through the postfix.
 *
 *   (args) => X    →  (args) => (function(__r){INJECTED;return __r})(X)
 *
 * `arrowText` is the full arrow source (including params). Returns the
 * rewritten text, or null if the input wasn't an expression-bodied arrow.
 */
export function rewriteArrowExpressionBody(arrowText, injected) {
  let ast;
  try {
    ast = acorn.parse(`(${arrowText})`, { ecmaVersion: 'latest', ranges: true });
  } catch {
    return null;
  }
  const expr = ast.body[0]?.expression;
  if (!expr || expr.type !== 'ArrowFunctionExpression') return null;
  if (expr.body.type === 'BlockStatement') return null; // not an expression body
  const bodyStart = expr.body.start - 1;
  const bodyEnd = expr.body.end - 1;
  const bodyText = arrowText.slice(bodyStart, bodyEnd);
  return arrowText.slice(0, bodyStart) +
    `(function(__r){${injected};return __r})(${bodyText})` +
    arrowText.slice(bodyEnd);
}

/**
 * Given a validated patch module with `kind`, return a synthesized
 * `apply(code, opts) => string`. For 'free' (or undefined), returns the
 * patch's own `apply`.
 */
export function compileKind(patch) {
  const kind = patch.kind ?? 'free';
  if (kind === 'free') return patch.apply;

  if (kind === 'prefix') {
    return function apply(code /*, opts */) {
      const loc = locateTarget(code, patch.target);
      if (!loc) return code;
      const openBrace = code.indexOf('{', loc.start);
      if (openBrace === -1 || openBrace >= loc.end) return code;
      return code.slice(0, openBrace + 1) + patch.code + code.slice(openBrace + 1);
    };
  }

  if (kind === 'postfix') {
    return function apply(code /*, opts */) {
      const loc = locateTarget(code, patch.target);
      if (!loc) return code;
      const fnText = code.slice(loc.start, loc.end);
      const rewritten = rewriteReturns(fnText, patch.code, { code, start: loc.start, end: loc.end });
      if (rewritten === fnText) return code;
      return code.slice(0, loc.start) + rewritten + code.slice(loc.end);
    };
  }

  if (kind === 'transpiler') {
    return function apply(code, opts) {
      const loc = locateTarget(code, patch.target);
      if (!loc) return code;
      const fnText = code.slice(loc.start, loc.end);
      const out = patch.transform(fnText, opts);
      if (typeof out !== 'string') {
        throw new Error(`transpiler: transform() must return a string, got ${typeof out}`);
      }
      if (out === fnText) return code;
      return code.slice(0, loc.start) + out + code.slice(loc.end);
    };
  }

  throw new Error(`unknown patch kind: ${kind}`);
}
