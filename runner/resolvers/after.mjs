// runner/resolvers/after.mjs
// Resolver for @At AFTER — immediately after a string literal.

import { fuzzyMatch } from '../anchors.mjs';

function fuzzyCandidatesForLiteral(code, literal) {
  if (typeof literal !== 'string' || literal.length < 4) return [];
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return fuzzyMatch(code, new RegExp(escaped));
}

/**
 * Resolve an AFTER selector — zero-length insertion point immediately after
 * the Nth occurrence of target.literal in the bundle.
 *
 * @param {object} target  - at.target from the patch manifest
 * @param {string} code    - full bundle text
 * @param {object} _opts   - reserved
 * @returns {{ ok: true, sites: Array } | { ok: false, error: string, candidates?: Array }}
 */
export function resolveAfter(target, code, _opts = {}) {
  const lit = target?.literal;
  if (typeof lit !== 'string' || lit.length === 0) {
    return { ok: false, error: 'AFTER: target.literal (non-empty string) required' };
  }
  const occurrence = target.occurrence ?? 1;
  if (!Number.isInteger(occurrence) || occurrence < 1) {
    return { ok: false, error: 'AFTER: target.occurrence must be a positive integer' };
  }
  let idx = -1;
  let from = 0;
  for (let n = 0; n < occurrence; n++) {
    idx = code.indexOf(lit, from);
    if (idx === -1) break;
    from = idx + lit.length;
  }
  if (idx === -1) {
    return {
      ok: false,
      error: `AFTER: literal not found (${JSON.stringify(lit.slice(0, 40))})`,
      candidates: fuzzyCandidatesForLiteral(code, lit),
    };
  }
  const point = idx + lit.length;
  return {
    ok: true,
    sites: [{
      start: point,
      end: point,
      kind: 'AFTER',
      label: `AFTER ${JSON.stringify(lit.slice(0, 40))}`,
    }],
  };
}
