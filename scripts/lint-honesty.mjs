#!/usr/bin/env node
/**
 * scripts/lint-honesty.mjs — umbrella for the "honesty" lint family.
 *
 * ccpatch's honesty checks all answer one question: "does a patch's DECLARED
 * surface match what it actually does?" They were four separate entry points
 * (lint:capabilities, lint:contracts, lint:escape-hatches, lint:ordering), which
 * meant four things to wire into CI, the Makefile, package.json, and a
 * contributor's mental model. This umbrella is the single place to reason about
 * — and run — the whole family:
 *
 *   • capabilities    — declared `capabilities` vs syscall-shaped source.
 *   • contracts       — every cross-patch __ccp* global is __ccpProvide'd.
 *   • escape-hatches  — every gate bypass is cataloged in THREAT_MODEL.md.
 *   • ordering        — no bootInject+priority runtime-ordering misuse.
 *
 * It does NOT reimplement any detection logic: each sub-lint still owns its
 * checks and exports `runLint()`, and each still runs standalone (e.g.
 * `npm run lint:capabilities`) for targeted iteration. The umbrella imports those
 * functions and aggregates their exit codes. It always runs EVERY sub-lint
 * (never short-circuits) so a contributor sees all honesty findings in one pass.
 *
 * Exit 0 when all sub-lints pass; exit 1 if any fails. Sub-lints that throw are
 * treated as failures (fail-closed), not silently skipped.
 */

import { runLint as capabilities } from './lint-capabilities.mjs';
import { runLint as contracts } from './lint-contracts.mjs';
import { runLint as escapeHatches } from './lint-escape-hatches.mjs';
import { runLint as ordering } from './lint-ordering.mjs';

const SUBLINTS = [
  ['capabilities',   capabilities],
  ['contracts',      contracts],
  ['escape-hatches', escapeHatches],
  ['ordering',       ordering],
];

export async function runLint() {
  let failed = 0;
  const failures = [];
  for (const [name, fn] of SUBLINTS) {
    console.log(`\n── lint:${name} ──`);
    let code;
    try {
      code = await fn();
    } catch (err) {
      // A sub-lint that throws is a failure, not a skip — fail closed.
      console.error(`ERROR: lint:${name} threw: ${err?.stack || err?.message || err}`);
      code = 1;
    }
    if (code !== 0) {
      failed++;
      failures.push(name);
    }
  }

  console.log('\n── honesty summary ──');
  if (failed > 0) {
    console.error(`lint-honesty: ${failed}/${SUBLINTS.length} sub-lint(s) failed: ${failures.join(', ')}`);
    return 1;
  }
  console.log(`OK: all ${SUBLINTS.length} honesty lints passed (capabilities, contracts, escape-hatches, ordering).`);
  return 0;
}

// Run as a gate only when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await runLint());
}
