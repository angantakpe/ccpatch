// runner/at-selector.mjs
//
// @At selector vocabulary — declarative anchors for ccpatch patches.
//
// Inspired by Minecraft Mixin's @At annotations. A patch may declare an `at`
// manifest field describing *where* in the bundle it wants to attach; the
// runner resolves it once before calling apply(), and passes the resolved
// byte ranges via patchOptions.atSites. The patch's apply() then uses the
// helpers exported here (injectAtHead etc.) to splice its fragment.
//
// Resolver contract:
//   resolveAt(at, code, opts)
//     → { ok: true,  sites: [{ start, end, kind, label }] }
//     → { ok: false, error: string, candidates?: fuzzyMatch[] }
//
// Selector kinds:
//   HEAD    — function entry. target.function = 'NAME' | { literal: 'STR' }.
//             site.start = offset just AFTER the opening brace of the body;
//             site.end   = same (insertion point, zero-length).
//   RETURN  — every `return` statement inside the target function.
//             site.start = offset of `return` keyword;
//             site.end   = offset of the terminating `;` (or `}` for void).
//             site.kind  = 'RETURN'; site.label includes `void` for `return;`.
//   INVOKE  — call site(s). target.call = 'fnName' | { literal: 'STR' }.
//             Optional target.occurrence (1-indexed) selects the Nth call only.
//             When target.in = function spec, scan only inside that function.
//             site.start/end span the entire CallExpression (`f(args)`).
//   BEFORE  — immediately before a string literal. target.literal, occurrence?.
//             site.start === site.end === literal_offset.
//   AFTER   — immediately after a string literal. target.literal, occurrence?.
//             site.start === site.end === literal_offset + literal.length.

import { RESOLVER_REGISTRY } from './resolvers/index.mjs';

export const AT_KINDS = Object.freeze(['HEAD', 'RETURN', 'INVOKE', 'BEFORE', 'AFTER']);

/**
 * Main resolver. Dispatch on at.kind via RESOLVER_REGISTRY.
 */
export function resolveAt(at, code, opts = {}) {
  if (!at || typeof at !== 'object') return { ok: false, error: '@At: missing selector object' };
  if (!AT_KINDS.includes(at.kind)) {
    return { ok: false, error: `@At: unknown kind "${at.kind}" (allowed: ${AT_KINDS.join(', ')})` };
  }
  const fn = RESOLVER_REGISTRY.get(at.kind);
  if (!fn) return { ok: false, error: 'Unknown @At kind: ' + at.kind };
  return fn(at.target, code, opts);
}

// ───────────────────────── Helpers patches can use ─────────────────────────

/**
 * Splice `fragment` immediately after the function's opening brace.
 * Site must come from a HEAD resolution.
 */
export function injectAtHead(code, site, fragment) {
  if (!site || site.kind !== 'HEAD') throw new Error('injectAtHead: site.kind must be HEAD');
  return code.slice(0, site.start) + fragment + code.slice(site.end);
}

/**
 * For BEFORE/AFTER: simple splice at the zero-length site.
 */
export function injectAt(code, site, fragment) {
  if (!site) throw new Error('injectAt: site required');
  return code.slice(0, site.start) + fragment + code.slice(site.end);
}

/**
 * Wrap a return statement.
 *   `return X;`  →  `return (wrapFn(X));`
 *   `return;`    →  `{ voidFn(); return; }`  (when voidFn provided)
 *
 * `transform` is a function `(returnedExpression: string) => string` that
 * produces the *new* expression to return. For void returns, pass a `void`
 * option carrying the side-effect fragment.
 *
 * Sites must be processed in REVERSE order to keep offsets valid; the helper
 * does that automatically when given an array.
 */
export function injectAtReturn(code, siteOrSites, transform, options = {}) {
  const sites = Array.isArray(siteOrSites) ? [...siteOrSites] : [siteOrSites];
  for (const s of sites) {
    if (!s || s.kind !== 'RETURN') throw new Error('injectAtReturn: site.kind must be RETURN');
  }
  // Process in descending order so earlier edits don't shift later sites.
  sites.sort((a, b) => b.start - a.start);
  let out = code;
  for (const site of sites) {
    if (site.void) {
      const fragment = options.voidFragment ?? '';
      // Replace `return;` (or `return}`) with `{ fragment; return; }`.
      const original = out.slice(site.start, site.end);
      const replacement = `{${fragment};${original}}`;
      out = out.slice(0, site.start) + replacement + out.slice(site.end);
    } else {
      const argExpr = out.slice(site.argStart, site.argEnd);
      const wrapped = typeof transform === 'function' ? transform(argExpr) : `(${transform})(${argExpr})`;
      out = out.slice(0, site.argStart) + wrapped + out.slice(site.argEnd);
    }
  }
  return out;
}

/**
 * For INVOKE: wrap `f(args)` → `(before, f(args), after)`.
 * `before` and `after` are expression fragments. Either may be empty.
 */
export function injectAround(code, site, before, after) {
  if (!site || site.kind !== 'INVOKE') throw new Error('injectAround: site.kind must be INVOKE');
  const original = code.slice(site.start, site.end);
  const left = before ? `${before},` : '';
  const right = after ? `,${after}` : '';
  const wrapped = `(${left}${original}${right})`;
  return code.slice(0, site.start) + wrapped + code.slice(site.end);
}
