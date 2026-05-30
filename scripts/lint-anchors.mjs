#!/usr/bin/env node
/**
 * lint-anchors — enforce the resilient-anchor path across the registry.
 *
 * Each entry in runner/anchors.mjs may resolve via several precedence tiers
 * (see the resolveAnchor() docs atop that file):
 *   1. version-specific regex   2. refmap   3. anchors[] tier chain   4. default
 *
 * An entry that carries ONLY a `default` regex — an exact minified shape — is
 * brittle: a single upstream whitespace/arg change breaks it with no fallback.
 * The resilience infrastructure (a stable `literal` for AST resolution, or a
 * multi-tier `anchors:[]` chain) exists, but is useless on entries that don't
 * adopt it.
 *
 * This gate flags every entry that has a `default` but NEITHER a `literal` NOR
 * a non-empty `anchors:[]` tier chain, and exits non-zero so `npm run lint`
 * fails on it. Fix by adding the stable string the regex already references as
 * the entry's `literal` (giving it the AST-literal fallback path), or by
 * declaring an `anchors:[]` tier chain.
 *
 * Usage:
 *   node scripts/lint-anchors.mjs
 */

import { anchors } from '../runner/anchors.mjs';

/** Does the entry declare a usable, non-empty anchors[] tier chain? */
function hasTierChain(entry) {
  return Array.isArray(entry.anchors)
    && entry.anchors.some((t) => t && t.pattern instanceof RegExp);
}

/**
 * Is this entry brittle — a `default` regex with no resilient fallback path?
 * Resilient means it carries a stable `literal` (AST resolution) OR a non-empty
 * `anchors:[]` tier chain. Entries with no `default` are not brittle (nothing to
 * harden).
 *
 * @param {object} entry
 * @returns {boolean}
 */
export function isBrittle(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!(entry.default instanceof RegExp)) return false;
  const hasLiteral = typeof entry.literal === 'string' && entry.literal.length > 0;
  return !(hasLiteral || hasTierChain(entry));
}

/** Return the ids of every brittle entry in a registry object. */
export function findOffenders(registry) {
  return Object.entries(registry)
    .filter(([, entry]) => isBrittle(entry))
    .map(([id]) => id);
}

/** Report offenders for `registry`; returns the process exit code (0 clean, 1 brittle). */
export function report(registry) {
  const offenders = findOffenders(registry);
  if (offenders.length === 0) {
    console.log(`lint-anchors: clean (${Object.keys(registry).length} entries, 0 brittle)`);
    return 0;
  }
  console.error(
    `lint-anchors: ${offenders.length} brittle entr${offenders.length === 1 ? 'y' : 'ies'} ` +
    `(default regex with no \`literal\` and no \`anchors:[]\` fallback chain)\n`
  );
  for (const id of offenders) {
    console.error(`  - ${id}: only a \`default\` regex — add the stable string it already`);
    console.error(`      references as \`literal\`, or declare an \`anchors:[]\` tier chain.`);
  }
  console.error(`\n  See the resolveAnchor() precedence docs atop runner/anchors.mjs.`);
  return 1;
}

// Run as a gate only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(report(anchors));
}
