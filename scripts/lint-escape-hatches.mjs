#!/usr/bin/env node
/**
 * scripts/lint-escape-hatches.mjs
 *
 * Mechanical backstop for the "Escape-hatch registry & audit policy" section
 * of THREAT_MODEL.md. Every gate bypass must be cataloged there; this lint
 * keeps the table and the code from drifting apart.
 *
 * Checks:
 *   1. Every bypass-family token found in code (--allow-*, CCPATCH_SKIP_*,
 *      CCPATCH_NO_*, CCPATCH_BEST_EFFORT, CCPATCH_ALLOW_*) has a row in the
 *      THREAT_MODEL.md registry table. ERROR if not — new hatches land in the
 *      table in the same change.
 *   2. Every registry row's token still appears somewhere in code. ERROR if
 *      not — a deleted hatch must drop its row (and vice versa).
 *   3. Bypass flags appearing in automation (Makefile, scripts/mk/*.mk,
 *      .github/workflows/*) are reported. `--allow-capabilities=<enumerated>`
 *      is the documented CI pattern and stays silent; `=all`, --allow-unacked,
 *      --allow-unverified, and CCPATCH_SKIP_SHA_CHECK=1 in automation are
 *      WARNed — routine use means the gate is miscalibrated (fix the gate,
 *      don't normalize the bypass).
 *   4. Current allowOverlapWith pairs in the patch corpus are listed (INFO)
 *      so the annual audit has the inventory in one place.
 *
 * Exit 0 if no errors; exit 1 on any registry drift.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Token families that constitute a gate bypass. CCPATCH_STRICT / _PARANOID are
// the opposite (fail-closed switches) and are deliberately not matched.
const FAMILY_RE = /--allow-[a-z][a-z-]*|CCPATCH_(?:SKIP|NO|ALLOW)_[A-Z_]+|CCPATCH_BEST_EFFORT/g;

const CODE_DIRS = ['runner', 'scripts', 'bin', 'core', 'extensions', 'tools'];
const AUTOMATION = [
  'Makefile',
  ...listFiles(join(ROOT, 'scripts', 'mk'), f => f.endsWith('.mk')),
  ...listFiles(join(ROOT, '.github', 'workflows'), f => /\.ya?ml$/.test(f)),
].map(p => (p.startsWith('/') ? p : join(ROOT, p)));

function listFiles(dir, filter) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(filter).map(f => join(dir, f));
}

function* walkMjs(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walkMjs(p);
    else if (name.endsWith('.mjs') || name.endsWith('.mk')) yield p;
  }
}

/** Run the escape-hatch registry lint. Returns the process exit code (0|1). */
export function runLint() {
// ── 1. Collect bypass tokens from code ───────────────────────────────────────

const codeHits = new Map(); // token → [file, ...]
const codeFiles = [];
for (const d of CODE_DIRS) {
  const abs = join(ROOT, d);
  if (existsSync(abs)) codeFiles.push(...walkMjs(abs));
}
codeFiles.push(join(ROOT, 'Makefile'));

for (const file of codeFiles) {
  if (!existsSync(file)) continue;
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(FAMILY_RE)) {
    const tok = m[0];
    if (!codeHits.has(tok)) codeHits.set(tok, new Set());
    codeHits.get(tok).add(relative(ROOT, file));
  }
}

// ── 2. Parse the registry table out of THREAT_MODEL.md ──────────────────────

const tm = readFileSync(join(ROOT, 'THREAT_MODEL.md'), 'utf8');
const sectionMatch = tm.match(
  /## Escape-hatch registry & audit policy[\s\S]*?(?=\n## |\n*$)/,
);
if (!sectionMatch) {
  console.error('ERROR: THREAT_MODEL.md has no "Escape-hatch registry & audit policy" section');
  return 1;
}
const registryTokens = new Set();
for (const row of sectionMatch[0].matchAll(/^\|\s*`([^`]+)`/gm)) {
  // Row tokens like "CCPATCH_SKIP_SHA_CHECK=1" or "--allow-capabilities=<list>"
  // normalize to the bare flag/env name for comparison.
  const bare = row[1].replace(/=.*$/, '').replace(/\s.*$/, '');
  if (bare === 'Escape') continue; // header row
  registryTokens.add(bare);
}

// ── 3. Drift checks ──────────────────────────────────────────────────────────

let hasErrors = false;

// 3a. Token in code but not in the table.
for (const [tok, files] of codeHits) {
  if (!registryTokens.has(tok)) {
    console.error(
      `ERROR: bypass token '${tok}' (${[...files].slice(0, 3).join(', ')}) ` +
      `has no row in the THREAT_MODEL.md escape-hatch registry`,
    );
    hasErrors = true;
  }
}

// 3b. Table row whose token no longer exists anywhere in code.
const allCode = codeFiles
  .filter(existsSync)
  .map(f => readFileSync(f, 'utf8'))
  .join('\n');
for (const tok of registryTokens) {
  // Manifest fields (allowOverlapWith) and subcommand flags (--force) are
  // checked by plain substring; family tokens were already collected above.
  const present = codeHits.has(tok) || allCode.includes(tok);
  if (!present) {
    console.error(
      `ERROR: registry row '${tok}' in THREAT_MODEL.md matches nothing in code — ` +
      `delete the row or restore the hatch`,
    );
    hasErrors = true;
  }
}

// ── 4. Routine-use warnings in automation ────────────────────────────────────

const RISKY_IN_AUTOMATION = [
  /--allow-capabilities[= ]all\b/,
  /--allow-unacked\b/,
  /--allow-unverified\b/,
  /CCPATCH_SKIP_SHA_CHECK=1/,
  /CCPATCH_SKIP_LAUNCH_VERIFY=1/,
];
for (const file of AUTOMATION) {
  if (!existsSync(file)) continue;
  const src = readFileSync(file, 'utf8');
  src.split('\n').forEach((line, i) => {
    // Comments and echo'd help/warning text mention flags without using them.
    if (/^\s*#/.test(line) || /\becho\b/.test(line)) return;
    for (const re of RISKY_IN_AUTOMATION) {
      if (re.test(line)) {
        console.warn(
          `WARN: ${relative(ROOT, file)}:${i + 1} uses '${line.trim().slice(0, 80)}' — ` +
          `routine bypass in automation means the gate is miscalibrated`,
        );
      }
    }
  });
}

// ── 4b. verify.weak ratchet (shrink-only escape hatch) ───────────────────────
//
// `verify.weak: true` is a real gate bypass: it lets a patch ship a present-only
// verify that CANNOT detect wrong-location apply or double-apply (see
// manifest-validators.validateVerify). The corpus is currently at ZERO real
// patches using it; this is a ratchet that keeps it there. To legitimately add a
// weak verify, add the patch stem to WEAK_VERIFY_ALLOWLIST below in the same
// change and justify it — the list may only shrink over time.
//
// `_`-prefixed files (extensions/_*.mjs) are examples/templates, not shipped
// patches, and are exempt.
const WEAK_VERIFY_ALLOWLIST = new Set([
  // (empty — keep it that way; prefer verify.count or verify.absent)
]);

for (const dir of ['core', 'extensions']) {
  for (const file of walkMjs(join(ROOT, dir))) {
    const stem = file.split('/').pop().replace(/\.mjs$/, '');
    if (stem.startsWith('_')) continue; // examples/templates exempt
    const src = readFileSync(file, 'utf8');
    if (/\bweak:\s*true\b/.test(src) && !WEAK_VERIFY_ALLOWLIST.has(stem)) {
      console.error(
        `ERROR: ${relative(ROOT, file)} declares verify.weak: true but is not in ` +
        `WEAK_VERIFY_ALLOWLIST (scripts/lint-escape-hatches.mjs). A present-only ` +
        `verify cannot detect wrong-location/double apply — switch to verify.count ` +
        `or verify.absent, or register the stem with justification.`,
      );
      hasErrors = true;
    }
  }
}

// ── 5. allowOverlapWith inventory (INFO) ─────────────────────────────────────

const pairs = [];
for (const dir of ['core', 'extensions']) {
  for (const file of walkMjs(join(ROOT, dir))) {
    const src = readFileSync(file, 'utf8');
    const m = src.match(/allowOverlapWith:\s*\[([^\]]*)\]/);
    if (m) pairs.push(`${relative(ROOT, file)} ↔ [${m[1].trim()}]`);
  }
}
if (pairs.length) {
  console.log(`INFO: ${pairs.length} allowOverlapWith pair(s) in the corpus:`);
  for (const p of pairs) console.log(`  ${p}`);
}

// ── 6. Exit ──────────────────────────────────────────────────────────────────

if (hasErrors) {
  return 1;
}
console.log(`OK: ${registryTokens.size} registered escape hatches, no registry drift`);
return 0;
}

// Run as a gate only when invoked directly (not when imported by the umbrella/tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runLint());
}
