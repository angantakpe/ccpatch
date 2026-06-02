// runner/resolvers/return.mjs
// Resolver for @At RETURN — every return statement inside a function.

import { findFunctionByLiteral, firstOffsetOf } from '../ast-anchor.mjs';
import { fuzzyMatch } from '../anchors.mjs';
import { findClosingBrace } from '../brace-walker.mjs';
import { getAst } from '../ast-cache.mjs';

function resolveFunction(spec, code) {
  if (typeof spec === 'string') {
    const needle = `function ${spec}(`;
    const idx = firstOffsetOf(code, needle);
    if (idx === -1) return null;
    let i = idx + needle.length;
    let depth = 1;
    while (i < code.length && depth > 0) {
      const c = code[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
      i++;
    }
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] !== '{') return null;
    const openBrace = i;
    const closeBrace = findClosingBrace(code, openBrace);
    if (closeBrace === -1) return null;
    return {
      name: spec,
      start: idx,
      end: closeBrace + 1,
      bodyStart: openBrace + 1,
      bodyEnd: closeBrace,
    };
  }
  if (spec && typeof spec === 'object' && typeof spec.literal === 'string') {
    const fn = findFunctionByLiteral(code, spec.literal);
    if (!fn) return null;
    const openBrace = code.indexOf('{', fn.start);
    if (openBrace === -1 || openBrace >= fn.end) return null;
    return {
      name: fn.name,
      start: fn.start,
      end: fn.end,
      bodyStart: openBrace + 1,
      bodyEnd: fn.end - 1,
    };
  }
  return null;
}

function describeFnSpec(spec) {
  if (typeof spec === 'string') return `name=${spec}`;
  if (spec && typeof spec === 'object' && typeof spec.literal === 'string') {
    return `literal=${JSON.stringify(spec.literal.slice(0, 40))}`;
  }
  return '<invalid>';
}

function fuzzyCandidatesForLiteral(code, literal) {
  if (typeof literal !== 'string' || literal.length < 4) return [];
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return fuzzyMatch(code, new RegExp(escaped));
}

/**
 * Walk a function body and collect every ReturnStatement.
 * Uses Acorn over the extracted function text (cheap) instead of the bundle.
 */
function collectReturns(code, fn) {
  const fnText = code.slice(fn.start, fn.end);
  let ast;
  try {
    ast = getAst(code, fn.start, fn.end, fnText);
  } catch (_) {
    return null;
  }
  const sites = [];
  // Offsets in ast are relative to the wrapped string "(" + fnText + ")".
  // Wrapper adds 1 char before fnText. Bundle offset = fn.start + (astOffset - 1).
  const toBundle = (off) => fn.start + (off - 1);
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    if (node.type === 'ReturnStatement') {
      const start = toBundle(node.start);
      const end = toBundle(node.end);
      const isVoid = node.argument == null;
      sites.push({
        start, end,
        kind: 'RETURN',
        label: isVoid ? 'RETURN void' : 'RETURN value',
        void: isVoid,
        // arg offsets help injectAtReturn rewrite `return X` precisely
        argStart: node.argument ? toBundle(node.argument.start) : null,
        argEnd: node.argument ? toBundle(node.argument.end) : null,
      });
    }
    // Do NOT recurse into nested functions — their returns belong to them.
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      // Skip nested function bodies, but visit the top-level wrapper expression.
      // The outer call passes the top-level FunctionExpression first; we walk
      // its body only.
      if (node !== walk.__root) return;
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range' || key === 'start' || key === 'end' || key === 'type') continue;
      walk(node[key]);
    }
  }
  // Locate the FunctionExpression root inside ast.body[0].expression
  const root = ast.body[0]?.expression;
  if (!root) return null;
  walk.__root = root;
  walk(root.body);
  return sites;
}

/**
 * Resolve a RETURN selector — all return statements inside the target function.
 *
 * @param {object} target  - at.target from the patch manifest
 * @param {string} code    - full bundle text
 * @param {object} _opts   - reserved
 * @returns {{ ok: true, sites: Array } | { ok: false, error: string, candidates?: Array }}
 */
export function resolveReturn(target, code, _opts = {}) {
  const fn = resolveFunction(target?.function, code);
  if (!fn) {
    const lit = typeof target?.function === 'object' ? target.function.literal : null;
    return {
      ok: false,
      error: `RETURN: function not found (${describeFnSpec(target?.function)})`,
      candidates: lit ? fuzzyCandidatesForLiteral(code, lit) : [],
    };
  }
  const sites = collectReturns(code, fn);
  if (!sites) return { ok: false, error: `RETURN: failed to parse function ${fn.name ?? '<anon>'}` };
  if (sites.length === 0) return { ok: false, error: `RETURN: no return statements in ${fn.name ?? '<anon>'}` };
  return { ok: true, sites };
}
