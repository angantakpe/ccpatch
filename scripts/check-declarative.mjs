#!/usr/bin/env node
/**
 * check-declarative.mjs — scan extensions/ + core/ and warn about
 * free-form patches that could be expressed in declarative kind form
 * (kind: 'prefix' | 'postfix' | 'transpiler').
 *
 * Heuristic candidates (one warning per build, listing all hits):
 *
 *   1. Pattern A — single-fn override using findFunctionByLiteral():
 *      `code = code.slice(0, fn.start) + 'function ' + fn.name + '(){return !0}' + …`
 *      → maps to kind: 'prefix' with `code: 'return !0;'` and
 *        `target: { function: { literal: 'STR' } }`.
 *
 *   2. Pattern B — apply() that only does `code.includes(...) && string.replace(...)`
 *      with a single regex/string substitution. Often expressible as
 *      kind: 'transpiler' scoped to the enclosing function.
 *
 * ENFORCING: this gate exits non-zero when any candidate is found, so
 * `npm run lint` fails on it. The tree is currently at 0 findings (Lane C
 * migrated the candidates); a NEW free-form patch that maps cleanly onto a
 * declarative kind fails lint until it migrates — or is restructured so it no
 * longer matches the heuristic (e.g. event_bus, which legitimately needs free
 * form and does not match either pattern).
 *
 * Usage:
 *   node scripts/check-declarative.mjs            # gate: exit 1 if candidates found
 *   node scripts/check-declarative.mjs --json     # machine-readable list (always exit 0)
 *   node scripts/check-declarative.mjs --quiet    # suppress output, still exit 1 on findings
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIRS = ['extensions', 'core'].map(d => resolve(ROOT, d));

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const quiet = args.has('--quiet');

/** Return a short reason if `src` looks like a candidate for declarative form. */
function classify(src) {
  // Skip if patch is already declarative.
  if (/\bkind\s*:\s*['"](prefix|postfix|transpiler)['"]/.test(src)) return null;
  // Skip if no apply() (preload-only or runtime).
  if (!/\bapply\s*[:(]/.test(src)) return null;

  // Pattern A — function override via findFunctionByLiteral + slice/concat.
  if (
    /findFunctionByLiteral\s*\(/.test(src)
    && /code\.slice\(0,\s*[A-Za-z_$][\w$]*\.start\)/.test(src)
    && /'function '\s*\+\s*[A-Za-z_$][\w$]*\.name/.test(src)
  ) {
    return 'function-override-via-slice → kind:"prefix" or kind:"transpiler"';
  }

  // Pattern B — single-shot string/regex replace anchored on a quoted literal.
  // (Roughly: one `code.replace(…)` call, no loops.)
  const replaceCount = (src.match(/code\s*=\s*code\.replace\(/g) || []).length;
  const literalAnchor = /code\.includes\(['"][^'"]{6,}['"]\)/.test(src);
  if (replaceCount === 1 && literalAnchor && !src.includes('for (')) {
    return 'single-replace with literal anchor → consider kind:"transpiler"';
  }

  return null;
}

const findings = [];
for (const dir of DIRS) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.mjs') || f.startsWith('_')) continue;
    const path = resolve(dir, f);
    const src = readFileSync(path, 'utf8');
    const reason = classify(src);
    if (reason) findings.push({ name: f.replace(/\.mjs$/, ''), path, reason });
  }
}

if (asJson) {
  process.stdout.write(JSON.stringify({ findings }, null, 2) + '\n');
  process.exit(0);
}

if (findings.length === 0) {
  if (!quiet) console.log('check-declarative: no candidates — all free-form patches look intentional.');
  process.exit(0);
}

if (!quiet) {
  // Print the header ONCE, then a flat list. This is the "only printed once
  // per build, not per patch" contract from the expert review. Routed to stderr
  // since this is now a failing gate, not informational stdout.
  console.error(
    `[ccpatch] ${findings.length} free-form patch(es) could be declarative ` +
    `(kind: prefix | postfix | transpiler). See docs/authoring-patches.md "Declarative kinds".`
  );
  for (const { name, reason } of findings) {
    console.error(`  - ${name}: ${reason}`);
  }
  console.error(`  Codemod: node scripts/codemod-declarative.mjs <patch-name>`);
}
// Enforcing: fail the build when any candidate is found so `npm run lint` gates.
process.exit(findings.length > 0 ? 1 : 0);
