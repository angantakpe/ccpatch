#!/usr/bin/env node
/**
 * build-refmap.mjs — Generate a refmap for a given Claude Code bundle.
 *
 * A refmap is a JSON sidecar that maps each anchor ID (from
 * `runner/anchors.mjs`) to the *current* minified function name and byte
 * offset in a specific upstream bundle. It is the automated counterpart of
 * the manual per-version regex overrides already living in
 * `runner/anchors.mjs`.
 *
 *   refmap[id] = { fn: "Wj7", offset: 8412091 }
 *
 * Only anchors that carry a stable string `literal` are eligible for refmap
 * generation — the literal is what `findFunctionByLiteral` keys off of.
 * Anchors without a literal are listed under `misses` so contributors know
 * what was skipped.
 *
 * Usage:
 *   node tools/build-refmap.mjs <bundle.js> [--out refmaps/<version>.json]
 *                               [--cc-version X.Y.Z]
 *
 * Programmatic:
 *   import { buildRefmap } from './tools/build-refmap.mjs';
 *   const refmap = buildRefmap(code, { ccVersion: '2.1.148' });
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { anchors } from '../runner/anchors.mjs';
import { findFunctionByLiteral } from '../runner/ast-anchor.mjs';
import { PROJECT_ROOT } from '../runner/paths.mjs';

/**
 * Build a refmap object for `code`. Pure function — no I/O.
 *
 * @param {string} code
 * @param {{ ccVersion?: string|null, now?: () => Date }} [opts]
 * @returns {{
 *   ccVersion: string|null,
 *   generatedAt: string,
 *   bundleSha256: string,
 *   anchors: Record<string, { fn: string|null, offset: number }>,
 *   misses: string[]
 * }}
 */
export function buildRefmap(code, opts = {}) {
  const ccVersion = opts.ccVersion ?? null;
  const now = opts.now ? opts.now() : new Date();
  const bundleSha256 = createHash('sha256').update(code, 'utf8').digest('hex');

  const resolved = {};
  const misses = [];

  for (const [id, entry] of Object.entries(anchors)) {
    const literal = entry?.literal;
    if (!literal) {
      misses.push(id);
      continue;
    }
    const hit = findFunctionByLiteral(code, literal);
    if (!hit) {
      misses.push(id);
      continue;
    }
    resolved[id] = { fn: hit.name, offset: hit.start };
  }

  return {
    ccVersion,
    generatedAt: now.toISOString(),
    bundleSha256,
    anchors: resolved,
    misses,
  };
}

/**
 * Resolve the output path. Default is refmaps/<ccVersion>.json under
 * PROJECT_ROOT; falls back to refmaps/<bundleSha256-prefix>.json when no
 * version is supplied.
 */
export function defaultRefmapPath(ccVersion, bundleSha256, root = PROJECT_ROOT) {
  const stem = ccVersion ? ccVersion : `sha-${(bundleSha256 || '').slice(0, 12)}`;
  return path.join(root, 'refmaps', `${stem}.json`);
}

/**
 * Compare two refmaps for equality, ignoring `generatedAt`.
 */
export function refmapsEqual(a, b) {
  if (!a || !b) return false;
  if (a.ccVersion !== b.ccVersion) return false;
  if (a.bundleSha256 !== b.bundleSha256) return false;
  const ak = Object.keys(a.anchors || {}).sort();
  const bk = Object.keys(b.anchors || {}).sort();
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
  for (const k of ak) {
    const av = a.anchors[k] || {};
    const bv = b.anchors[k] || {};
    if (av.fn !== bv.fn || av.offset !== bv.offset) return false;
  }
  const am = (a.misses || []).slice().sort();
  const bm = (b.misses || []).slice().sort();
  if (am.length !== bm.length || am.some((k, i) => k !== bm[i])) return false;
  return true;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length < 1 || args[0] === '--help' || args[0] === '-h') {
    return { help: true };
  }
  const bundlePath = path.resolve(args[0]);
  let outPath = null;
  let ccVersion = null;
  let check = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) outPath = path.resolve(args[++i]);
    else if (args[i] === '--cc-version' && args[i + 1]) ccVersion = args[++i];
    else if (args[i] === '--check') check = true;
  }
  return { bundlePath, outPath, ccVersion, check };
}

const USAGE =
  'Usage: node tools/build-refmap.mjs <bundle.js> [--out <path>] [--cc-version X.Y.Z] [--check]\n' +
  '  --check  regenerate in memory and exit non-zero if it differs from the on-disk refmap';

/**
 * CLI entry point. Returns process exit code.
 */
export async function runBuildRefmapCli(argv, logger = console) {
  const opts = parseArgs(argv);
  if (opts.help) { logger.log(USAGE); return 0; }
  if (!fs.existsSync(opts.bundlePath)) {
    logger.error(`Error: bundle not found: ${opts.bundlePath}`);
    return 2;
  }
  const code = fs.readFileSync(opts.bundlePath, 'utf8');
  const refmap = buildRefmap(code, { ccVersion: opts.ccVersion });

  const outPath = opts.outPath || defaultRefmapPath(opts.ccVersion, refmap.bundleSha256);

  if (opts.check) {
    if (!fs.existsSync(outPath)) {
      logger.error(`Error: --check expected refmap at ${outPath}; not found.`);
      return 1;
    }
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch (err) {
      logger.error(`Error: existing refmap at ${outPath} is not valid JSON: ${err.message}`);
      return 1;
    }
    const drifted = !refmapsEqual(existing, refmap);
    if (drifted) {
      logger.error(`Refmap drift detected at ${outPath}. Regenerate with: node tools/build-refmap.mjs ${opts.bundlePath}${opts.ccVersion ? ` --cc-version ${opts.ccVersion}` : ''}`);
      return 1;
    }
    logger.log(`Refmap matches on-disk file: ${outPath}`);
    return 0;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(refmap, null, 2) + '\n', 'utf8');
  const resolvedCount = Object.keys(refmap.anchors).length;
  logger.log(`Wrote refmap: ${outPath}`);
  logger.log(`  ccVersion:   ${refmap.ccVersion ?? '(unset)'}`);
  logger.log(`  bundleSha:   ${refmap.bundleSha256.slice(0, 16)}…`);
  logger.log(`  resolved:    ${resolvedCount}`);
  logger.log(`  misses:      ${refmap.misses.length}${refmap.misses.length ? ` (${refmap.misses.join(', ')})` : ''}`);
  return 0;
}

// Run when executed directly (not when imported).
const invokedFromCli = (() => {
  try { return import.meta.url === new URL(`file://${path.resolve(process.argv[1] || '')}`).href; }
  catch { return false; }
})();
if (invokedFromCli) {
  runBuildRefmapCli(process.argv).then(code => process.exit(code));
}
