#!/usr/bin/env node
/**
 * scan-bun-api — build-time Bun API coverage scanner.
 *
 * The bundle is Bun-compiled; ccpatch runs it under Node via the hand-written
 * polyfill in runner/shims/bun-polyfill-v1.js.txt. Several shim entries are
 * knowingly degraded (Bun.spawn is a synchronous spawnSync with a 5s cap,
 * Bun.Terminal throws by design, …). When upstream moves a boot-critical path
 * onto an API we don't (properly) shim, nothing used to notice until runtime —
 * which is how the fullscreen-TUI-on-Bun-PTY deadlock happened. This scanner
 * turns that class of incident into a loud BUILD-time report:
 *
 *   (a) used but UNSHIMMED            → error-level (fails --strict builds)
 *   (b) used and shimmed-but-degraded → warning with the shim's caveat
 *   (c) NEW vs the previous version's committed baseline → highlighted drift
 *   (d) degraded-shim DRIFT — a degraded/throwing shim gained call sites vs
 *       the committed baseline → error-level; FAILS the build by default
 *       (bypass: --allow-bun-drift, or review + --write-baseline + commit).
 *       Baseline pick: exact-version baseline when committed (rebuilds must
 *       show zero drift), else newest strictly-older version.
 *
 * ── Why a regex pass, not an AST pass ────────────────────────────────────────
 * Measured against the real v2.1.175 bundle (16.9 MB): the single-regex scan
 * finds 35 `Bun.<identifier>` sites in ~25 ms. Exactly 2 of those 35 sites sit
 * inside string literals (an upstream error-message string naming Bun.Terminal,
 * and a code-example template string naming Bun.stdin) — i.e. ~6% over-report,
 * and both name APIs that are independently real or worth surfacing anyway. A
 * full-bundle acorn parse costs multiple seconds and whole-bundle ASTs (the
 * runner's .ast-cache only windows small function texts, never the 17MB
 * program). Since the cost of a false positive here is one extra WARNING line
 * (fail-loud is the point) while the cost of a false negative is a runtime
 * deadlock, the regex pass is the right trade. Decision: regex, documented.
 *
 * Known regex blind spots (measured absent from v2.1.175, see tests):
 *   - bracket access     Bun["spawn"]      (0 sites in v2.1.175)
 *   - destructuring      const { spawn } = Bun   (0 sites in v2.1.175)
 * `globalThis.Bun.x` IS caught (\b matches after the dot).
 *
 * ── Committed artifacts (API names + counts only, never bundle code) ─────────
 *   refmaps/bun-api-coverage.json       what the polyfill shims, classified
 *                                       full | degraded (caveat) | throws
 *   refmaps/bun-api-usage.v<ver>.json   per-version usage baseline for drift
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   node scripts/scan-bun-api.mjs <bundle> [--version <x.y.z>]
 *                                 [--baseline <x.y.z>] [--write-baseline]
 *                                 [--json] [--strict]
 *
 *   --version          CC version of <bundle>; inferred from the filename
 *                      (…v2.1.175…) when omitted. Keys the baseline drift.
 *   --baseline <ver>   compare against that exact committed baseline instead
 *                      of auto-picking the latest baseline older than
 *                      --version.
 *   --write-baseline   write refmaps/bun-api-usage.v<version>.json.
 *   --json             machine-readable report on stdout.
 *   --strict           exit 1 when any used API is unshimmed (class a).
 *
 * The build pipeline (runner/cli/cmd-build.mjs) imports runBunApiScan() and
 * runs the same report during every normal build — non-fatal by default,
 * build-failing under --strict.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/ is one level below the project root.
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REFMAPS_DIR = path.join(PROJECT_ROOT, 'refmaps');
const COVERAGE_PATH = path.join(REFMAPS_DIR, 'bun-api-coverage.json');
const SHIM_PAYLOAD_PATH = path.join(PROJECT_ROOT, 'runner', 'shims', 'bun-polyfill-v1.js.txt');

/** Property accesses on the Bun global: `Bun.<identifier>`. */
export const BUN_API_RE = /\bBun\.([A-Za-z_$][\w$]*)/g;

const SCANNER_ID = 'regex-v1';

// ── (1) Bundle scan ──────────────────────────────────────────────────────────

/**
 * Scan bundle text for `Bun.<identifier>` usage sites.
 *
 * @param {string} code - bundle source text
 * @returns {{ apis: Record<string, number>, totalSites: number }}
 *   `apis` is keyed by API name in sorted order, values are occurrence counts.
 */
export function scanBundle(code) {
  const counts = new Map();
  let m;
  BUN_API_RE.lastIndex = 0;
  while ((m = BUN_API_RE.exec(code)) !== null) {
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  const apis = {};
  for (const name of [...counts.keys()].sort()) apis[name] = counts.get(name);
  return { apis, totalSites: [...counts.values()].reduce((s, c) => s + c, 0) };
}

// ── (2) Shim coverage model ──────────────────────────────────────────────────

/** Skip a quoted string starting at payload[i]; returns index PAST the close. */
function skipString(payload, i) {
  const quote = payload[i];
  i++;
  while (i < payload.length) {
    const ch = payload[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === quote) return i + 1;
    i++;
  }
  return i;
}

/**
 * Extract the top-level keys of the `Bun = { … }` (or `globalThis.Bun = { … }`)
 * object literal from the polyfill payload. The payload is plain text (a
 * `.js.txt` shim, not an importable module), so this is a small tolerant
 * scanner: it brace-walks the object, skipping strings and comments, and
 * collects `identifier:` keys at depth 1 only. Spread/computed/getter members
 * are skipped rather than crashed on.
 *
 * @param {string} payload - full text of runner/shims/bun-polyfill-v1.js.txt
 * @returns {string[]} sorted, deduped top-level key names
 */
export function parseShimKeys(payload) {
  const open = payload.match(/(?:globalThis\.)?Bun\s*=\s*\{/);
  if (!open) {
    throw new Error('parseShimKeys: no `Bun = {` object literal found in shim payload');
  }
  let i = open.index + open[0].length;
  let depth = 1;
  let expectKey = true;
  const keys = [];
  while (i < payload.length && depth > 0) {
    const ch = payload[i];
    if (ch === '/' && payload[i + 1] === '/') {
      const nl = payload.indexOf('\n', i);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }
    if (ch === '/' && payload[i + 1] === '*') {
      const end = payload.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(payload, i); continue; }
    if (ch === '{' || ch === '(' || ch === '[') { depth++; i++; continue; }
    if (ch === '}' || ch === ')' || ch === ']') { depth--; i++; continue; }
    if (depth === 1) {
      if (ch === ',') { expectKey = true; i++; continue; }
      if (expectKey && !/\s/.test(ch)) {
        const km = /^([A-Za-z_$][\w$]*)\s*:/.exec(payload.slice(i, i + 256));
        if (km) {
          keys.push(km[1]);
          i += km[0].length;
        }
        // Not a simple `key:` member (spread, computed, shorthand) — don't
        // re-attempt until the next top-level comma.
        expectKey = false;
        continue;
      }
    }
    i++;
  }
  return [...new Set(keys)].sort();
}

/** Read shim keys from the committed polyfill payload. */
export function readShimKeys(payloadPath = SHIM_PAYLOAD_PATH) {
  return parseShimKeys(fs.readFileSync(payloadPath, 'utf8'));
}

/**
 * Load refmaps/bun-api-coverage.json: { apis: { name: { status, caveat? } } }
 * with status ∈ full | degraded | throws.
 */
export function loadCoverage(coveragePath = COVERAGE_PATH) {
  const parsed = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  if (!parsed || typeof parsed.apis !== 'object') {
    throw new Error(`loadCoverage: ${coveragePath} has no "apis" object`);
  }
  return parsed;
}

// ── (3) Baseline + drift ─────────────────────────────────────────────────────

const BASELINE_RE = /^bun-api-usage\.v(\d+\.\d+\.\d+)\.json$/;

export function baselinePathFor(version, refmapsDir = REFMAPS_DIR) {
  return path.join(refmapsDir, `bun-api-usage.v${version}.json`);
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Pick the committed baseline to drift against. Exact-version baseline first:
 * when refmaps/bun-api-usage.v<version>.json exists, drift against it (a
 * rebuild of a recorded version must show ZERO drift — non-empty means the
 * bundle changed without a baseline update). Otherwise fall back to the
 * newest strictly-older baseline (a new version drifts against its
 * predecessor until its own baseline is reviewed and committed).
 */
export function pickBaseline(version, refmapsDir = REFMAPS_DIR) {
  if (version) {
    const exact = loadBaseline(version, refmapsDir);
    if (exact) return exact;
  }
  return findPreviousBaseline(version, refmapsDir);
}

/**
 * Find the committed usage baseline to drift against: the newest
 * bun-api-usage.v*.json strictly OLDER than `version` (or the newest overall
 * when `version` is null). Returns { version, apis } or null when none exists.
 */
export function findPreviousBaseline(version, refmapsDir = REFMAPS_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(refmapsDir);
  } catch {
    return null;
  }
  const candidates = entries
    .map(name => BASELINE_RE.exec(name)?.[1])
    .filter(Boolean)
    .filter(v => (version ? compareVersions(v, version) < 0 : true))
    .sort(compareVersions);
  const prev = candidates[candidates.length - 1];
  if (!prev) return null;
  return loadBaseline(prev, refmapsDir);
}

/** Load one committed baseline by exact version. Returns null when missing. */
export function loadBaseline(version, refmapsDir = REFMAPS_DIR) {
  try {
    const parsed = JSON.parse(fs.readFileSync(baselinePathFor(version, refmapsDir), 'utf8'));
    if (!parsed || typeof parsed.apis !== 'object') return null;
    return { version, apis: parsed.apis };
  } catch {
    return null;
  }
}

/** Serialize and write the usage snapshot for `version`. Returns the path. */
export function writeBaseline({ version, usage, refmapsDir = REFMAPS_DIR }) {
  const out = {
    ccVersion: version,
    generatedAt: new Date().toISOString(),
    scanner: SCANNER_ID,
    note: 'Bun API property names + occurrence counts only; no bundle content.',
    totalSites: usage.totalSites,
    apis: usage.apis,
  };
  const p = baselinePathFor(version, refmapsDir);
  fs.mkdirSync(refmapsDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return p;
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * Classify scanned usage against the shim + coverage model + baseline.
 *
 * Ground truth for "shimmed" is the parsed payload keys, NOT the coverage
 * file: a stale coverage entry whose key vanished from the payload must still
 * classify as unshimmed.
 *
 * @param {object} args
 * @param {{ apis: Record<string,number> }} args.usage      scanBundle() output
 * @param {string[]} args.shimKeys                          parseShimKeys() output
 * @param {{ apis: Record<string,{status:string,caveat?:string}> }} args.coverage
 * @param {{ version: string, apis: Record<string,number> }|null} [args.baseline]
 * @returns {{
 *   unshimmed: Array<{name:string,count:number}>,
 *   degraded:  Array<{name:string,count:number,status:string,caveat:string}>,
 *   ok:        Array<{name:string,count:number}>,
 *   newApis:   string[]|null,
 *   degradedDrift: Array<{name:string,count:number,baselineCount:number,status:string,caveat:string}>|null,
 * }}
 */
export function classifyUsage({ usage, shimKeys, coverage, baseline = null }) {
  const shimmed = new Set(shimKeys);
  const covApis = coverage?.apis || {};
  const unshimmed = [];
  const degraded = [];
  const ok = [];
  for (const [name, count] of Object.entries(usage.apis)) {
    if (!shimmed.has(name)) {
      unshimmed.push({ name, count });
      continue;
    }
    const entry = covApis[name];
    if (entry && entry.status === 'full') {
      ok.push({ name, count });
    } else if (entry && (entry.status === 'degraded' || entry.status === 'throws')) {
      degraded.push({ name, count, status: entry.status, caveat: entry.caveat || '' });
    } else {
      // Shimmed but unclassified (or unknown status): treat as degraded so it
      // is never silently assumed healthy.
      degraded.push({
        name,
        count,
        status: 'degraded',
        caveat: 'unclassified — add an entry to refmaps/bun-api-coverage.json',
      });
    }
  }
  const newApis = baseline
    ? Object.keys(usage.apis).filter(name => !(name in baseline.apis)).sort()
    : null;
  // Drift gate input: a degraded/throwing shim with MORE call sites than the
  // baseline recorded (including previously-unused, baselineCount 0). That is
  // the "upstream moved a code path onto a shim we know is broken" scenario —
  // the one class of drift that must fail the build, not warn (the
  // fullscreen-TUI deadlock shipped through a warning).
  const degradedDrift = baseline
    ? degraded
        .map(e => ({ ...e, baselineCount: baseline.apis[e.name] || 0 }))
        .filter(e => e.count > e.baselineCount)
    : null;
  return { unshimmed, degraded, ok, newApis, degradedDrift };
}

// ── Report rendering ─────────────────────────────────────────────────────────

const sites = n => `${n} site${n === 1 ? '' : 's'}`;

/**
 * Render the sectioned text report. Every line carries the `  [bun-api]`
 * prefix to match the build log's `  [capabilities]` / `  [native]` sections.
 *
 * The per-shim degraded inventory is a known, stable list — it is the same
 * caveats on every build and adds 16+ lines of noise. In non-verbose builds it
 * collapses to a single count line; `verbose: true` (VERBOSE=1 / --verbose)
 * restores the full per-API breakdown. The genuinely actionable sections
 * (unshimmed, degraded-shim DRIFT, NEW APIs) are NEVER collapsed.
 *
 * @returns {string[]} lines ready for logger.log / console.log
 */
export function renderReport({ usage, result, baseline, bundleLabel, version, verbose = true }) {
  const lines = [];
  const apiCount = Object.keys(usage.apis).length;
  const head = `${apiCount} distinct Bun.* API${apiCount === 1 ? '' : 's'} (${sites(usage.totalSites)})`;
  lines.push(`  [bun-api] ${head} referenced by ${bundleLabel}${version ? ` (v${version})` : ''}`);

  if (result.unshimmed.length > 0) {
    lines.push(
      `  [bun-api] ❌ UNSHIMMED (${result.unshimmed.length}) — missing from the Bun polyfill, ` +
      `will throw at runtime under Node:`
    );
    for (const e of result.unshimmed) {
      lines.push(`  [bun-api]     Bun.${e.name}  (${sites(e.count)})`);
    }
  } else {
    lines.push(`  [bun-api] unshimmed: none — every referenced API exists in the polyfill`);
  }

  if (result.degraded.length > 0) {
    if (verbose) {
      lines.push(`  [bun-api] ⚠️ degraded/throwing shims in use (${result.degraded.length}):`);
      const w = Math.max(...result.degraded.map(e => e.name.length), 8);
      for (const e of result.degraded) {
        const tag = e.status === 'throws' ? '[throws] ' : '';
        lines.push(
          `  [bun-api]     Bun.${e.name.padEnd(w)} (${sites(e.count)}) — ${tag}${e.caveat}`
        );
      }
    } else {
      const throwing = result.degraded.filter(e => e.status === 'throws').length;
      const detail = throwing
        ? `${throwing} throwing` + (throwing < result.degraded.length ? ', rest return safe fallbacks' : '')
        : 'all return safe fallbacks';
      lines.push(
        `  [bun-api] ⚠️ ${result.degraded.length} degraded/throwing shim(s) in use ` +
        `(${detail}) — VERBOSE=1 for the per-API breakdown`
      );
    }
  }

  if (baseline && result.degradedDrift && result.degradedDrift.length > 0) {
    lines.push(
      `  [bun-api] ❌ DEGRADED-SHIM DRIFT vs v${baseline.version} baseline ` +
      `(${result.degradedDrift.length}) — new call site(s) on a shim that is known-broken under Node:`
    );
    for (const e of result.degradedDrift) {
      const tag = e.status === 'throws' ? '[throws] ' : '';
      lines.push(
        `  [bun-api]     Bun.${e.name}  ${e.baselineCount} → ${e.count} site(s) — ${tag}${e.caveat}`
      );
    }
  }

  if (baseline && result.newApis) {
    if (result.newApis.length > 0) {
      lines.push(
        `  [bun-api] 🆕 NEW vs v${baseline.version} baseline (${result.newApis.length}): ` +
        `${result.newApis.map(n => `Bun.${n}`).join(', ')} — upstream grew a new Bun dependency` +
        `${version ? ` in v${version}` : ''}; verify the shim before shipping`
      );
    } else {
      lines.push(`  [bun-api] drift vs v${baseline.version} baseline: none`);
    }
  } else {
    lines.push(`  [bun-api] drift: no earlier baseline in refmaps/ to compare against`);
  }
  return lines;
}

// ── One-call entry point (shared by the build pipeline and the CLI) ──────────

/**
 * Scan `code`, classify against the committed shim payload + coverage map,
 * drift against the committed baselines, and render the report.
 *
 * Never throws for "bad findings" — only for missing/corrupt repo inputs
 * (shim payload, coverage file). Callers decide severity: the build treats a
 * non-empty `unshimmed` as fatal only under --strict.
 *
 * @param {object} args
 * @param {string} args.code                 bundle text
 * @param {string} [args.bundleLabel]        display name for the report header
 * @param {string|null} [args.version]       CC version of the bundle
 * @param {string|null} [args.baselineVersion] exact baseline to drift against
 * @param {string} [args.refmapsDir]         override for tests
 * @param {string} [args.shimPayloadPath]    override for tests
 * @param {string} [args.coveragePath]       override for tests
 * @param {boolean} [args.verbose]           full per-API degraded breakdown
 *                                           (default true; build passes
 *                                           isVerbose() to collapse the stable
 *                                           inventory in non-verbose builds)
 */
export function runBunApiScan({
  code,
  bundleLabel = 'bundle',
  version = null,
  baselineVersion = null,
  refmapsDir = REFMAPS_DIR,
  shimPayloadPath = SHIM_PAYLOAD_PATH,
  coveragePath = COVERAGE_PATH,
  verbose = true,
}) {
  const usage = scanBundle(code);
  const shimKeys = readShimKeys(shimPayloadPath);
  const coverage = loadCoverage(coveragePath);
  const baseline = baselineVersion
    ? loadBaseline(baselineVersion, refmapsDir)
    : pickBaseline(version, refmapsDir);
  if (baselineVersion && !baseline) {
    throw new Error(
      `no committed baseline for --baseline ${baselineVersion} ` +
      `(expected ${baselinePathFor(baselineVersion, refmapsDir)})`
    );
  }
  const result = classifyUsage({ usage, shimKeys, coverage, baseline });
  const lines = renderReport({ usage, result, baseline, bundleLabel, version, verbose });
  return { usage, shimKeys, baseline, ...result, lines };
}

// ── Standalone CLI ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    bundle: null, version: null, baseline: null,
    writeBaseline: false, json: false, strict: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') opts.version = argv[++i] ?? null;
    else if (a === '--baseline') opts.baseline = argv[++i] ?? null;
    else if (a === '--write-baseline') opts.writeBaseline = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!a.startsWith('--') && !opts.bundle) opts.bundle = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const USAGE = `usage: node scripts/scan-bun-api.mjs <bundle> [--version <x.y.z>]
         [--baseline <x.y.z>] [--write-baseline] [--json] [--strict]

Scans <bundle> for Bun.<identifier> usage and reports:
  (a) APIs used but missing from runner/shims/bun-polyfill-v1.js.txt  [error]
  (b) APIs used whose shim is degraded/throwing (with caveat)         [warn]
  (c) APIs new vs the previous version's committed baseline           [drift]
  (d) degraded shims that GAINED call sites vs the baseline           [error]

--strict exits 1 on classes (a) and (d). --write-baseline records
refmaps/bun-api-usage.v<version>.json for future drift comparison.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.bundle) {
    console.log(USAGE);
    return opts.help ? 0 : 2;
  }
  const bundlePath = path.resolve(opts.bundle);
  const code = fs.readFileSync(bundlePath, 'utf8');
  // Infer the CC version from the filename (…v2.1.175…) when not passed.
  const version =
    opts.version ||
    /v?(\d+\.\d+\.\d+)/.exec(path.basename(bundlePath))?.[1] ||
    null;

  const scan = runBunApiScan({
    code,
    bundleLabel: path.basename(bundlePath),
    version,
    baselineVersion: opts.baseline,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      bundle: path.basename(bundlePath),
      version,
      scanner: SCANNER_ID,
      totalSites: scan.usage.totalSites,
      apis: scan.usage.apis,
      unshimmed: scan.unshimmed,
      degraded: scan.degraded,
      ok: scan.ok,
      baseline: scan.baseline ? scan.baseline.version : null,
      newApis: scan.newApis,
      degradedDrift: scan.degradedDrift,
    }, null, 2) + '\n');
  } else {
    for (const line of scan.lines) console.log(line);
  }

  if (opts.writeBaseline) {
    if (!version) {
      console.error('error: --write-baseline needs --version <x.y.z> (or a v<x.y.z> filename)');
      return 2;
    }
    const p = writeBaseline({ version, usage: scan.usage });
    console.log(`  [bun-api] baseline written: ${path.relative(process.cwd(), p)}`);
  }

  if (opts.strict && scan.unshimmed.length > 0) {
    console.error(
      `error: --strict: ${scan.unshimmed.length} Bun API(s) used by the bundle are missing ` +
      `from the polyfill: ${scan.unshimmed.map(e => `Bun.${e.name}`).join(', ')}`
    );
    return 1;
  }
  if (opts.strict && scan.degradedDrift && scan.degradedDrift.length > 0) {
    console.error(
      `error: --strict: ${scan.degradedDrift.length} degraded shim(s) gained call sites vs the ` +
      `v${scan.baseline.version} baseline: ` +
      scan.degradedDrift.map(e => `Bun.${e.name} (${e.baselineCount} → ${e.count})`).join(', ') +
      `. Verify the shim semantics, then re-record with --write-baseline.`
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (err) {
    console.error(`scan-bun-api: ${err.message}`);
    process.exitCode = 2;
  }
}
