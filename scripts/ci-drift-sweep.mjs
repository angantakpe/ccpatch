#!/usr/bin/env node
// A3: Proactive anchor-drift early-warning helper for CI.
//
// Today version-coupling drift is discovered REACTIVELY — a user's build fails
// on a freshly published Claude Code release because an anchor moved. This
// helper turns that into a PROACTIVE signal: it locates one or more
// claude-code `cli.js` bundles and shells `node bin/patch-cli.mjs doctor` at
// each, so anchor drift surfaces in scheduled CI BEFORE a user hits it.
//
// It sweeps two classes of target:
//
//   1. The globally installed `@anthropic-ai/claude-code` bundle (the
//      "@latest" leading indicator — install it before invoking this script).
//   2. Every "known refmap'd version" — each `refmaps/<version>.json` whose
//      matching bundle is already present under
//      `storage/archives/claude-code-v<version>/`. These are the versions we
//      have hand-resolved anchors for; re-checking them guards against silent
//      regressions in the refmap loader / anchor registry.
//
// CRITICAL difference from the lagging PR guard (`version-matrix.yml`): the
// raw `doctor` command exits non-zero ONLY on MISSING (or strict UNVERIFIED) —
// plain DRIFT returns 0 there because drift is a "re-anchor at your leisure"
// signal on a PR. For the nightly early-warning we want DRIFT to be loud too,
// so this script parses doctor's stdout and fails the sweep on DRIFT *or*
// MISSING. That is the intended distinction the A3 finding calls for.
//
// Relationship to `revisit.until` (see runner/manifest.mjs + runner/runner.mjs):
// `revisit.until` is the per-patch, runtime nudge that fires when a forensic
// patch is applied at/after the version it was meant to be re-evaluated by.
// This sweep is the complementary *fleet-wide, build-time* radar — it does not
// apply patches, it only probes anchors. Together: revisit.until reminds you
// about a patch you KNOW is temporary; the drift sweep catches anchors that
// moved when you DIDN'T expect them to.
//
// Self-contained: no secrets, no network beyond whatever the caller already
// installed. Locates bundles on disk and shells the existing CLI.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(PROJECT_ROOT, 'bin', 'patch-cli.mjs');

// --- arg parsing -----------------------------------------------------------
// Usage:
//   node scripts/ci-drift-sweep.mjs [--latest <cli.js>] [--latest-version <v>]
//                                   [--no-refmaps] [--strict]
//
// --latest          Explicit path to the @latest bundle's cli.js. When omitted
//                   the script auto-discovers the globally installed bundle.
// --latest-version  Version string to pass through to doctor for the @latest
//                   target (drives the anchor-drift.jsonl `version` field).
// --no-refmaps      Skip the known-refmap'd-version portion of the sweep.
// --strict          Forward --strict to doctor (UNVERIFIED becomes a failure).
function parseArgs(argv) {
  const out = { latest: null, latestVersion: null, refmaps: true, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--latest') out.latest = argv[++i];
    else if (a === '--latest-version') out.latestVersion = argv[++i];
    else if (a === '--no-refmaps') out.refmaps = false;
    else if (a === '--strict') out.strict = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else console.error(`[drift-sweep] ignoring unknown arg: ${a}`);
  }
  return out;
}

// Resolve the globally installed claude-code bundle. Mirrors the
// drift-check.yml "Locate installed claude-code bundle" step: prefer the
// shipped cli.js/cli.mjs, fall back to the version-tagged .cjs extracted into
// storage/archives. Returns { bundle, version } or null when nothing is found.
function resolveInstalledLatest(explicitPath, explicitVersion) {
  // Honour an explicit path first (CI may already know where it is).
  if (explicitPath) {
    if (fs.existsSync(explicitPath)) {
      return { bundle: explicitPath, version: explicitVersion ?? readGlobalCcVersion() };
    }
    console.error(`[drift-sweep] --latest path does not exist: ${explicitPath}`);
    return null;
  }
  const npmRoot = npmRootGlobal();
  if (!npmRoot) return null;
  const ccDir = path.join(npmRoot, '@anthropic-ai', 'claude-code');
  for (const name of ['cli.js', 'cli.mjs']) {
    const p = path.join(ccDir, name);
    if (fs.existsSync(p)) {
      return { bundle: p, version: explicitVersion ?? readGlobalCcVersion(ccDir) };
    }
  }
  console.error(`[drift-sweep] no cli.js/cli.mjs under ${ccDir}`);
  return null;
}

function npmRootGlobal() {
  const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) {
    console.error('[drift-sweep] `npm root -g` failed; cannot locate global bundle');
    return null;
  }
  return r.stdout.trim();
}

// Read the installed claude-code version from its package.json (best-effort).
function readGlobalCcVersion(ccDir) {
  try {
    const dir = ccDir ?? path.join(npmRootGlobal() ?? '', '@anthropic-ai', 'claude-code');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

// Discover the known refmap'd versions that also have an on-disk bundle. A
// refmap with no archived bundle is silently skipped (the matrix workflow is
// responsible for downloading those; here we only probe what is already
// present, keeping the helper free of network side effects).
function discoverRefmapTargets() {
  const refmapDir = path.join(PROJECT_ROOT, 'refmaps');
  if (!fs.existsSync(refmapDir)) return [];
  const targets = [];
  for (const file of fs.readdirSync(refmapDir)) {
    if (!file.endsWith('.json')) continue;
    const version = file.replace(/\.json$/, '');
    const bundle = locateArchivedBundle(version);
    if (bundle) targets.push({ version, bundle });
    else console.error(`[drift-sweep] refmap ${version}: no archived bundle, skipping`);
  }
  return targets;
}

// Mirror the bundle-path probing the Makefile/version-matrix use for a
// version's storage/archives directory.
function locateArchivedBundle(version) {
  const dir = path.join(PROJECT_ROOT, 'storage', 'archives', `claude-code-v${version}`);
  const candidates = [
    path.join(dir, 'cli.js'),
    path.join(dir, `cli.v${version}.cjs`),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // Last resort: any cli*.cjs in the dir.
  try {
    const hit = fs.readdirSync(dir).find(f => /^cli.*\.cjs$/.test(f));
    if (hit) return path.join(dir, hit);
  } catch { /* dir absent */ }
  return null;
}

// Shell `doctor` against one bundle and classify the result. doctor exits 1 on
// MISSING/strict-UNVERIFIED but 0 on plain DRIFT, so we additionally scan its
// stdout for the "N drifted" summary line (and DRIFT/MISSING rows) to decide.
function runDoctor({ bundle, version }, strict) {
  const args = ['doctor', bundle];
  if (version) args.push('--version', version);
  if (strict) args.push('--strict');
  console.error(`\n[drift-sweep] doctor ${bundle}${version ? ` (v${version})` : ''}`);
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  process.stdout.write(out);

  // Summary line looks like: "12 ok, 1 drifted, 0 unverified, 2 missing".
  let drift = 0, missing = 0;
  const m = out.match(/(\d+)\s+ok,\s*(\d+)\s+drifted,\s*(\d+)\s+unverified,\s*(\d+)\s+missing/);
  if (m) {
    drift = Number(m[2]);
    missing = Number(m[4]);
  } else {
    // Fall back to counting rows if the summary format ever changes.
    drift = (out.match(/^\s*DRIFT\b/gm) || []).length;
    missing = (out.match(/^\s*MISSING\b/gm) || []).length;
  }
  const exit = r.status ?? 1;
  return { drift, missing, exit, version, bundle };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/ci-drift-sweep.mjs [--latest <cli.js>] ' +
      '[--latest-version <v>] [--no-refmaps] [--strict]');
    return 0;
  }

  const results = [];

  // 1. @latest — the leading indicator.
  const latest = resolveInstalledLatest(opts.latest, opts.latestVersion);
  let refmapGateFailed = false;
  if (latest) {
    results.push(runDoctor(latest, opts.strict));

    // Refmap coverage gate: refmaps are MANDATORY for every supported
    // version, not optional augmentation — the refmap tier is what absorbs
    // minified-identifier rotation, and it only helps if it exists. A new
    // upstream release without a committed refmap keeps the nightly red
    // until one is generated.
    if (latest.version && !fs.existsSync(path.join(PROJECT_ROOT, 'refmaps', `${latest.version}.json`))) {
      console.error(
        `[drift-sweep] FAIL refmap gate — no refmaps/${latest.version}.json for @latest. ` +
        `Generate and commit one:\n` +
        `  node bin/patch-cli.mjs refmap ${latest.bundle} --cc-version ${latest.version} ` +
        `--out refmaps/${latest.version}.json`,
      );
      refmapGateFailed = true;
    }
  } else {
    console.error('[drift-sweep] could not resolve @latest bundle; skipping that target');
  }

  // 2. Known refmap'd versions present on disk.
  if (opts.refmaps) {
    for (const t of discoverRefmapTargets()) {
      results.push(runDoctor(t, opts.strict));
    }
  }

  if (results.length === 0) {
    console.error('[drift-sweep] no targets probed — nothing to report. Treating as failure.');
    return 1;
  }

  // Aggregate verdict. DRIFT or MISSING on ANY target fails the sweep.
  let failed = false;
  console.error('\n[drift-sweep] summary:');
  for (const r of results) {
    const tag = r.version ? `v${r.version}` : path.basename(r.bundle);
    const bad = r.drift > 0 || r.missing > 0;
    if (bad) failed = true;
    const label = (bad ? 'DRIFT/MISSING' : 'clean').padEnd(13);
    console.error(`  ${label} ${tag} — ` +
      `${r.drift} drifted, ${r.missing} missing (doctor exit ${r.exit})`);
  }
  if (failed) {
    console.error('[drift-sweep] FAIL — anchor drift or missing anchors detected. ' +
      'Re-anchor the affected patches (see anchor-drift.jsonl).');
    return 1;
  }
  if (refmapGateFailed) {
    console.error('[drift-sweep] FAIL — anchors clean but the refmap gate failed (see above).');
    return 1;
  }
  console.error('[drift-sweep] PASS — all probed bundles clean.');
  return 0;
}

process.exitCode = main();
