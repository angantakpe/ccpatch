#!/usr/bin/env node
/**
 * scripts/lint-ordering.mjs — ordering-honesty lint.
 *
 * Catches the one mechanically-detectable case of the apply-order vs
 * runtime-order footgun documented at length in runner/apply-order.mjs and
 * docs/ordering.md:
 *
 *   `priority` orders the sequence in which patches' apply() transforms run
 *   over the bundle TEXT. For a `bootInject` patch that is the WRONG knob for
 *   runtime sequencing: every enabled bootInject block is collected by the boot
 *   registry (runner/boot-registry.mjs) into ONE combined splice whose internal
 *   runtime order is decided EXCLUSIVELY by each block's `bootInject.order`.
 *   A bootInject patch's `priority` therefore cannot move its boot code earlier
 *   or later at runtime — it is, at best, inert, and at worst a contributor's
 *   misunderstanding that the next maintainer has to untangle.
 *
 * RULE: a patch that declares `bootInject` must NOT also declare a numeric
 * `priority`. If you need to sequence boot-time runtime side effects, use
 * `bootInject.order` (lower runs first; gaps of 10). If you genuinely need
 * apply-order control for a NON-boot reason, that is rare enough to warrant a
 * comment — register the stem in ALLOWLIST below with justification.
 *
 * This is deliberately narrow: it does NOT try to classify the broader
 * "prepend-at-head" patch class heuristically (that is fragile and lives in the
 * doc, not the linter). It flags only the unambiguous bootInject + priority
 * combination, which is always a mistake on today's contract.
 *
 * Exit 0 when clean; exit 1 on any violation. Exposes runLint() so the honesty
 * umbrella (scripts/lint-honesty.mjs) and tests can drive it without spawning.
 */

import { readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/**
 * Patch stems permitted to set `priority` alongside `bootInject` for a
 * documented non-runtime reason. Empty today; add `'stem': 'why'` with a
 * one-line justification if a legitimate case ever appears.
 * @type {Record<string,string>}
 */
const ALLOWLIST = Object.freeze({});

function collectMjs(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => n.endsWith('.mjs') && !n.startsWith('_'))
    .map((n) => resolve(dir, n))
    .sort();
}

function rel(abs) {
  return relative(ROOT, abs).split('/').join('/');
}

/** Run the lint over core/ + extensions/. Returns the process exit code. */
export async function runLint() {
  const files = [
    ...collectMjs(resolve(ROOT, 'core')),
    ...collectMjs(resolve(ROOT, 'extensions')),
  ];

  let errorCount = 0;
  let loadFailures = 0;

  for (const abs of files) {
    const r = rel(abs);
    let patch;
    try {
      const mod = await import(pathToFileURL(abs).href);
      patch = mod?.default;
    } catch (err) {
      // A patch that won't import is a different lint's problem
      // (all-patches-validate). Don't let it mask ordering checks; note and skip.
      loadFailures++;
      console.warn(`WARN: ${r} failed to import (skipped for ordering check): ${err.message}`);
      continue;
    }
    if (!patch || typeof patch !== 'object') continue;

    const stem = r.replace(/^.*\//, '').replace(/\.mjs$/, '');
    const hasBoot = patch.bootInject != null;
    const hasNumericPriority = typeof patch.priority === 'number' && Number.isFinite(patch.priority);
    if (hasBoot && hasNumericPriority && !(stem in ALLOWLIST)) {
      errorCount++;
      console.error(
        `ERROR: ${r} declares BOTH bootInject and priority:${patch.priority}.\n` +
        `    \`priority\` orders apply() over the bundle text; it CANNOT sequence a\n` +
        `    bootInject patch's runtime boot order — that is decided solely by\n` +
        `    bootInject.order. Drop \`priority\`, and set bootInject.order:<n> instead\n` +
        `    (lower runs first; gaps of 10). See docs/ordering.md.`,
      );
    }
  }

  if (errorCount > 0) {
    console.error(`\nlint-ordering: ${errorCount} bootInject+priority misuse(s).`);
    return 1;
  }
  console.log(
    `OK: no bootInject+priority ordering misuse (${files.length} patches scanned` +
    `${loadFailures ? `, ${loadFailures} skipped on import error` : ''}).`,
  );
  return 0;
}

// Run as a gate only when invoked directly (not when imported by tests/umbrella).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await runLint());
}
