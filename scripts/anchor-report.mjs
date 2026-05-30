#!/usr/bin/env node
/**
 * anchor-report — print each enabled patch's anchor RESOLUTION TIER.
 *
 * Companion to scripts/lint-anchors.mjs. Where the lint GATES on brittle
 * anchors, this report makes anchoring STRATEGY visible at a glance: for every
 * enabled patch it classifies how that patch finds its spot in the bundle, so
 * you can see — without a real cli.js — which patches ride the resilient
 * literal/AST path and which still lean on raw regex.
 *
 * Tiers (descending resilience, mirroring docs/anchors.md):
 *   literal — pivots on a stable string the minifier can't rename:
 *             findFunctionByLiteral / resolveAnchorLiteral / forceFeatureFlag,
 *             an `at:{ … literal }` selector, or a declared `anchor.literal`.
 *   refmap  — resolves a runner/anchors.mjs registry id via resolveAnchor(),
 *             which prefers the per-version refmap before its default regex.
 *   regex   — inline RegExp / .match / .replace anchored on a stable literal
 *             (acceptable per §2; the literal lives inside the pattern).
 *   fuzzy   — leans on fuzzyMatch() for near-miss recovery.
 *   none    — no regex/literal anchor: pure string includes/replace, or a
 *             declarative kind whose anchor is resolved by the runner.
 *
 * This is a heuristic, source-level classifier (it reads patch source, not a
 * bundle), so a patch that mixes strategies is reported at its MOST resilient
 * tier. Disabled patches (manifest `enabled:false` or turned off in ccpatch.yml)
 * are listed but dimmed.
 *
 * Usage:
 *   node scripts/anchor-report.mjs            # all patches
 *   node scripts/anchor-report.mjs --enabled  # only enabled patches
 *   node scripts/anchor-report.mjs --json
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadPatches } from '../runner/loader.mjs';
import { readPatchFlags } from '../runner/config.mjs';
import { extractPatterns } from './lint-anchors.mjs';

const TIER_ORDER = ['literal', 'refmap', 'regex', 'fuzzy', 'none'];

/**
 * Classify a patch's anchor resolution tier from its source.
 *
 * `patterns` (the RegExp sources Acorn extracted from the file) is what makes
 * the `regex` tier accurate — text-scanning the source for `/…/` would trip on
 * comments and division (e.g. a `/dev/null` mention). The literal/refmap/fuzzy
 * tiers are detected by the resolver calls the patch makes, which are
 * unambiguous identifiers.
 *
 * @param {string} src        - patch module source
 * @param {string[]} patterns - RegExp pattern sources from extractPatterns(src)
 * @returns {'literal'|'refmap'|'regex'|'fuzzy'|'none'}
 */
export function classifyTier(src, patterns = []) {
  if (typeof src !== 'string') return 'none';
  // literal/AST path — the enforced default.
  if (/\b(findFunctionByLiteral|resolveAnchorLiteral|forceFeatureFlag)\b/.test(src)) return 'literal';
  // `at:` selector targeting a stable literal (function/literal target).
  if (/\bat\s*:/.test(src) && /literal\s*:/.test(src)) return 'literal';
  // A declared `anchor: { literal: … }` manifest field.
  if (/\banchor\s*:[\s\S]{0,80}?literal\s*:/.test(src)) return 'literal';
  // registry resolution — resolveAnchor() walks version/refmap/tier/default.
  if (/\bresolveAnchor(?:Matching)?\s*\(/.test(src)) return 'refmap';
  // explicit fuzzy recovery.
  if (/\bfuzzyMatch\s*\(/.test(src)) return 'fuzzy';
  // inline regex anchoring — only when Acorn actually found a RegExp.
  if (patterns.length > 0) return 'regex';
  return 'none';
}

/**
 * Build a name → absolute-source-path map by scanning core/ and extensions/.
 * Handles per-version variant directories by preferring the default `<name>.mjs`
 * for the static report (variant bodies share the same anchor strategy by
 * convention; the report is about strategy, not the exact picked file).
 *
 * @param {string} root
 * @returns {Map<string,string>}
 */
function sourcePathsByName(root) {
  const map = new Map();
  for (const dir of ['core', 'extensions']) {
    const abs = path.join(root, dir);
    let entries;
    try { entries = readdirSync(abs); } catch { continue; }
    for (const e of entries) {
      const full = path.join(abs, e);
      if (e.endsWith('.mjs')) {
        map.set(e.slice(0, -4), full);
      } else if (!map.has(e)) {
        // variant dir <name>/: prefer a default-ish member for classification.
        try {
          if (!statSync(full).isDirectory()) continue;
          const members = readdirSync(full).filter((f) => f.endsWith('.mjs'));
          if (members.length === 0) continue;
          // Prefer a non-version stem; else the first member.
          const def = members.find((f) => !/^[<>=\d]/.test(f)) ?? members[0];
          map.set(e, path.join(full, def));
        } catch { /* skip unreadable dir */ }
      }
    }
  }
  return map;
}

/**
 * Produce the report rows: { name, enabled, tier } for every patch.
 * @param {string} root
 * @returns {Promise<{name:string,enabled:boolean,tier:string}[]>}
 */
export async function buildReport(root) {
  const patches = await loadPatches({});
  const flags = readPatchFlags(path.join(root, 'ccpatch.yml')) ?? {};
  const srcByName = sourcePathsByName(root);

  const rows = [];
  for (const [name, mod] of Object.entries(patches)) {
    // enabled state mirrors the runner: manifest `enabled !== false`, then any
    // ccpatch.yml override wins.
    let enabled = mod?.enabled !== false;
    if (Object.prototype.hasOwnProperty.call(flags, name)) enabled = flags[name];

    const srcPath = srcByName.get(name);
    let tier = 'none';
    if (srcPath) {
      try {
        const fileSrc = readFileSync(srcPath, 'utf8');
        tier = classifyTier(fileSrc, extractPatterns(fileSrc));
      } catch { tier = 'none'; }
    }
    rows.push({ name, enabled, tier });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const enabledOnly = args.includes('--enabled');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..');

  buildReport(root).then((all) => {
    const rows = enabledOnly ? all.filter((r) => r.enabled) : all;

    if (jsonOut) {
      const byTier = Object.fromEntries(TIER_ORDER.map((t) => [t, 0]));
      for (const r of rows) byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;
      console.log(JSON.stringify({ rows, summary: byTier }, null, 2));
      return;
    }

    const width = Math.max(...rows.map((r) => r.name.length), 5);
    console.log();
    console.log(`  ${'patch'.padEnd(width)}  tier      state`);
    console.log(`  ${'-'.repeat(width)}  --------  --------`);
    const counts = Object.fromEntries(TIER_ORDER.map((t) => [t, 0]));
    for (const r of rows) {
      counts[r.tier] = (counts[r.tier] ?? 0) + 1;
      const state = r.enabled ? 'enabled' : 'disabled';
      console.log(`  ${r.name.padEnd(width)}  ${r.tier.padEnd(8)}  ${state}`);
    }
    console.log();
    const summary = TIER_ORDER.map((t) => `${t}=${counts[t] ?? 0}`).join('  ');
    console.log(`  [anchor-report] ${rows.length} patch(es)  |  ${summary}`);
  }).catch((err) => {
    console.error(`[anchor-report] ${err?.stack || err}`);
    process.exit(1);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
