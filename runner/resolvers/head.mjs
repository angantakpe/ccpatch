// runner/resolvers/head.mjs
// Resolver for @At HEAD — function entry insertion point.

import { findFunctionByLiteral, firstOffsetOf } from '../ast-anchor.mjs';
import { fuzzyMatch } from '../anchors.mjs';
import { findClosingBrace } from '../brace-walker.mjs';

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
 * Resolve a HEAD selector to a single zero-length insertion site after the
 * function's opening brace.
 *
 * @param {object} target  - at.target from the patch manifest
 * @param {string} code    - full bundle text
 * @param {object} _opts   - reserved
 * @returns {{ ok: true, sites: Array } | { ok: false, error: string, candidates?: Array }}
 */
export function resolveHead(target, code, _opts = {}) {
  const fn = resolveFunction(target?.function, code);
  if (!fn) {
    const lit = typeof target?.function === 'object' ? target.function.literal : null;
    return {
      ok: false,
      error: `HEAD: function not found (${describeFnSpec(target?.function)})`,
      candidates: lit ? fuzzyCandidatesForLiteral(code, lit) : [],
    };
  }
  return {
    ok: true,
    sites: [{
      start: fn.bodyStart,
      end: fn.bodyStart,
      kind: 'HEAD',
      label: `HEAD ${fn.name ?? '<anon>'}`,
    }],
  };
}
