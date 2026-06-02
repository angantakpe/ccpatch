// runner/resolvers/index.mjs
// Registry of all @At kind resolvers. Import RESOLVER_REGISTRY to dispatch
// by kind without a flat switch statement.

export { resolveHead }   from './head.mjs';
export { resolveReturn } from './return.mjs';
export { resolveInvoke } from './invoke.mjs';
export { resolveBefore } from './before.mjs';
export { resolveAfter }  from './after.mjs';

import { resolveHead }   from './head.mjs';
import { resolveReturn } from './return.mjs';
import { resolveInvoke } from './invoke.mjs';
import { resolveBefore } from './before.mjs';
import { resolveAfter }  from './after.mjs';

/**
 * Maps each @At kind string to its resolver function.
 * Each resolver has signature: (target, code, opts) → { ok, sites } | { ok, error }
 */
export const RESOLVER_REGISTRY = new Map([
  ['HEAD',   resolveHead],
  ['RETURN', resolveReturn],
  ['INVOKE', resolveInvoke],
  ['BEFORE', resolveBefore],
  ['AFTER',  resolveAfter],
]);
