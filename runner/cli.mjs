import fs from 'node:fs';
import path from 'node:path';

import { HELP, USAGE, maybePrintSubcommandHelp } from './cli/help.mjs';
import { buildCommandTable, namedSubcommands, DEFAULT_KEY } from './cli/commands.mjs';
import { extractGlobalFlags, makeLogger } from './cli/logger.mjs';
import { loadPatches } from './loader.mjs';
import { resolveProfile, classifyRisk, CAPABILITIES } from './manifest.mjs';
import { readProfiles, readPatchFlags } from './config.mjs';
import { resolvePatchNames } from './runner.mjs';
import { emitOverlay } from './overlay-builder.mjs';
import { PROJECT_ROOT } from './paths.mjs';
import {
  enumeratePatchNames,
  scanVariantDir,
  pickBestVariant,
} from './version-resolver.mjs';

// A1: per-command handlers moved out of this god-module into ./cli/. cli.mjs is
// now a THIN dispatcher: it owns argv parsing, global flags, the COMMANDS table
// wiring, and a few small commands; each large handler lives in its own file.
// Every symbol this module historically exported is re-exported below so tests
// and the rest of runner/ keep resolving their imports unchanged.
import { runBuild } from './cli/cmd-build.mjs';
import { runRevert } from './cli/cmd-revert.mjs';
import { runDiff } from './cli/cmd-diff.mjs';
import { runDoctor, runDoctorCore } from './cli/cmd-doctor.mjs';
import { runAck, parseThreatModelTable } from './cli/cmd-ack.mjs';
import { runModuleCommand } from './cli/cmd-module.mjs';
import { isBinaryTarget } from './cli/sidecar.mjs';
import {
  parseAllowCapabilities,
  findGateViolations,
  findUnackedAckRequired,
  ACK_REQUIRED_CAPS,
} from './cli/capabilities.mjs';

// USAGE / HELP are owned by ./cli/help.mjs. Re-exported for legacy callers
// that imported the symbol off this module.
export { USAGE, HELP };

// A1: re-export every symbol moved into ./cli/* so the public surface of
// cli.mjs is unchanged (tests import these directly off '../runner/cli.mjs').
export {
  runBuild,
  runRevert,
  runDiff,
  runDoctor,
  runDoctorCore,
  runAck,
  parseThreatModelTable,
  runModuleCommand,
  parseAllowCapabilities,
  findGateViolations,
  findUnackedAckRequired,
  ACK_REQUIRED_CAPS,
};

/**
 * Parse the default (no-subcommand) build invocation: positional
 * `<input.js> <output.js>` plus the apply flags. Lives in its own function so
 * the command table (cli/commands.mjs) can register it as the DEFAULT_KEY
 * entry. parsePatchCliArgs delegates here when args[0] is not a named
 * subcommand.
 */
export function parseBuildArgs(args) {
  if (args.length < 2) {
    return { error: USAGE };
  }

  const inputPath = path.resolve(args[0]);
  const outputPath = path.resolve(args[1]);
  const requestedPatches = [];
  let preloadPath = null;
  let profile = null;

  const patchOptions = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--patch' && args[i + 1]) {
      requestedPatches.push(args[i + 1]);
    }
    if ((args[i] === '--profile' || args[i] === '-p') && args[i + 1]) {
      profile = args[i + 1];
    }
    if ((args[i] === '--model' || args[i] === '--version') && args[i + 1]) {
      patchOptions[args[i].slice(2)] = args[i + 1];
    }
    if (args[i] === '--preload' && args[i + 1]) {
      preloadPath = path.resolve(args[i + 1]);
    }
    if (args[i] === '--strict') {
      patchOptions.strict = true;
    }
    if (args[i] === '--dry-run') {
      patchOptions.dryRun = true;
    }
    if (args[i] === '--write-on-clean') {
      patchOptions.writeOnClean = true;
    }
    if (args[i] === '--no-fallback') {
      patchOptions.disableFallback = true;
    }
    if (args[i] === '--best-effort') {
      patchOptions.bestEffort = true;
    }
    if (args[i] === '--dev') {
      patchOptions.dev = true;
    }
    if (args[i] === '--allow-capabilities' && args[i + 1]) {
      patchOptions.allowCapabilitiesRaw = args[++i];
    } else if (args[i].startsWith('--allow-capabilities=')) {
      patchOptions.allowCapabilitiesRaw = args[i].slice('--allow-capabilities='.length);
    }
    if (args[i] === '--allow-unacked') {
      patchOptions.allowUnacked = true;
    }
  }
  if (!patchOptions.strict && process.env.CCPATCH_STRICT === '1') {
    patchOptions.strict = true;
  }
  if (!patchOptions.dev && process.env.CCPATCH_DEV === '1') {
    patchOptions.dev = true;
  }
  if (!patchOptions.bestEffort && process.env.CCPATCH_BEST_EFFORT === '1') {
    patchOptions.bestEffort = true;
  }

  return { inputPath, outputPath, requestedPatches, patchOptions, preloadPath, profile };
}

/**
 * The declarative command table (ARCH4). Bundles each subcommand's parser and
 * executor in one place so the parse-time and execution-time dispatch stay in
 * sync. The run* handlers are threaded in here (some are hoisted function
 * declarations later in this module; others are imported from ./cli/*) to avoid
 * a circular import with cli/commands.mjs, which owns only the *structure* of
 * the table.
 *
 * `parseBuild`/`runBuild` cover the default (no-subcommand) positional build
 * invocation; everything else maps a subcommand token → { parse, run }.
 */
const COMMANDS = buildCommandTable({
  parseBuild: parseBuildArgs,
  runBuild,
  runRevert,
  runDiff,
  runReplCommand,
  runVersions,
  runRefmap,
  runFallbackCapture,
  runWatch,
  runCoverage,
  runDoctor,
  runCapabilities,
  runHealCommand,
  runAck,
});

const NAMED_SUBCOMMANDS = new Set(namedSubcommands(COMMANDS));

/**
 * Parse argv into an options object carrying a discriminator key (e.g.
 * `revert: true`, or the default build shape). Dispatch is generated from the
 * command table: if args[0] names a subcommand, its parser handles args.slice(1);
 * otherwise the default build parser handles the full args array.
 *
 * Exported and exercised directly by tests — the returned shapes are a locked
 * contract (e.g. parsePatchCliArgs(['repl','x']) === { repl: true, patchedPath }).
 */
export function parsePatchCliArgs(args) {
  if (args.includes('--list')) {
    return { list: true };
  }
  const head = args[0];
  if (head && NAMED_SUBCOMMANDS.has(head)) {
    return COMMANDS.byName.get(head).parse(args.slice(1));
  }
  return COMMANDS.byName.get(DEFAULT_KEY).parse(args);
}

export async function runPatchCli(args, logger = console) {
  // Pull off global flags (--log-level, --quiet, --json) before any
  // subcommand-specific parsing. We re-wrap `logger` with a leveled logger so
  // every downstream call honors --quiet / --log-level. The default `console`
  // sink preserves legacy behavior when no flag is passed.
  const { level, json, args: cleanedArgs } = extractGlobalFlags(args);
  const leveled = (logger === console)
    ? makeLogger({ level, sink: console, json })
    : logger;
  // Alias so every existing `logger.log(...)` in this function uses the leveled
  // sink without us having to touch each call site.
  logger = leveled;
  args = cleanedArgs;

  // Per-subcommand --help. `ccpatch <cmd> --help` (or `-h`) renders just that
  // subcommand's usage block; falls back to the global banner otherwise.
  if (maybePrintSubcommandHelp(args, leveled)) return 0;

  // `module` keeps its own subdispatch (runModuleCommand) — it has nested
  // subcommands rather than fitting the flat parse/run table.
  if (args[0] === 'module') {
    return await runModuleCommand(args.slice(1), leveled);
  }

  const options = parsePatchCliArgs(args);
  // Surface --json downstream (build path) so the result can be serialized.
  if (options && !options.error) options.json = json;
  if (options.error) {
    logger.log(options.error);
    return 1;
  }

  // `--list` is a flag, not a table subcommand: it still needs patches loaded.
  if (options.list) {
    const patches = await loadPatches({ version: pickLoadVersion(options) });
    for (const name of Object.keys(patches).sort()) {
      const desc = patches[name].description ?? '';
      logger.log(`${name.padEnd(32)} ${desc}`);
    }
    return 0;
  }

  // Table-generated dispatch (ARCH4). The discriminator key set by the parser
  // (options.revert, options.doctor, …) selects the matching command; the
  // default build invocation maps to DEFAULT_KEY.
  let cmd = null;
  for (const c of COMMANDS.table) {
    if (c.resultKey === DEFAULT_KEY) continue;
    if (options[c.resultKey]) { cmd = c; break; }
  }
  if (!cmd) cmd = COMMANDS.byName.get(DEFAULT_KEY);

  // Commands that touch the patch registry load it (with the target version so
  // the correct variant is selected before validateManifest runs); the rest
  // run without loading patches.
  const patches = cmd.needsPatches
    ? await loadPatches({ version: pickLoadVersion(options) })
    : null;

  return await cmd.run({ options, patches, logger });
}

/**
 * Resolve the Claude Code version used to load patch variants: explicit
 * --version wins, else CCPATCH_CLI_VERSION. Returns undefined when neither is
 * set (loadPatches then uses defaults). Shared by --list and the table.
 */
function pickLoadVersion(options) {
  if (options.patchOptions?.version) return options.patchOptions.version;
  if (process.env.CCPATCH_CLI_VERSION) return process.env.CCPATCH_CLI_VERSION;
  return undefined;
}

/**
 * `ccpatch fallback-capture <patched.js> --against <unpatched.js> [--patch <name>]`
 *
 * Print a unified diff (unpatched → patched) suitable for pasting into a
 * patch module's `fallbackDiff.patch` field. One-shot tool: does NOT modify
 * any patch file on disk.
 */
export async function runFallbackCapture(options, logger = console) {
  const { patchedPath, againstPath, patchName } = options;
  if (!fs.existsSync(patchedPath)) {
    logger.error(`Error: patched bundle not found: ${patchedPath}`);
    return 1;
  }
  if (!fs.existsSync(againstPath)) {
    logger.error(`Error: unpatched bundle not found: ${againstPath}`);
    return 1;
  }
  const unpatched = fs.readFileSync(againstPath, 'utf8');
  const patched = fs.readFileSync(patchedPath, 'utf8');
  const { createPatch } = await import('diff');
  const label = patchName || path.basename(patchedPath);
  const diffOutput = createPatch(label, unpatched, patched, 'unpatched', 'patched');
  process.stdout.write(diffOutput);
  return 0;
}

async function runRefmap(options, logger) {
  const { buildRefmap, defaultRefmapPath, refmapsEqual } = await import('../tools/build-refmap.mjs');
  if (!fs.existsSync(options.bundlePath)) {
    logger.error(`Error: bundle not found: ${options.bundlePath}`);
    return 2;
  }
  const code = fs.readFileSync(options.bundlePath, 'utf8');
  const refmap = buildRefmap(code, { ccVersion: options.ccVersion });
  const outPath = options.outPath || defaultRefmapPath(options.ccVersion, refmap.bundleSha256);

  if (options.check) {
    if (!fs.existsSync(outPath)) {
      logger.error(`Error: --check expected refmap at ${outPath}; not found.`);
      return 1;
    }
    let existing;
    try { existing = JSON.parse(fs.readFileSync(outPath, 'utf8')); }
    catch (err) {
      logger.error(`Error: existing refmap at ${outPath} is not valid JSON: ${err.message}`);
      return 1;
    }
    if (!refmapsEqual(existing, refmap)) {
      logger.error(`Refmap drift detected at ${outPath}. Regenerate with: ccpatch refmap ${options.bundlePath}${options.ccVersion ? ` --cc-version ${options.ccVersion}` : ''}`);
      return 1;
    }
    logger.log(`Refmap matches on-disk file: ${outPath}`);
    return 0;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(refmap, null, 2) + '\n', 'utf8');
  logger.log(`Wrote refmap: ${outPath}`);
  logger.log(`  ccVersion:   ${refmap.ccVersion ?? '(unset)'}`);
  logger.log(`  bundleSha:   ${refmap.bundleSha256.slice(0, 16)}…`);
  logger.log(`  resolved:    ${Object.keys(refmap.anchors).length}`);
  logger.log(`  misses:      ${refmap.misses.length}${refmap.misses.length ? ` (${refmap.misses.join(', ')})` : ''}`);
  return 0;
}

function runVersions(options, logger) {
  const targetVersion = options.targetVersion;
  const dirs = [
    { label: 'core', dir: path.join(PROJECT_ROOT, 'core') },
    { label: 'extensions', dir: path.join(PROJECT_ROOT, 'extensions') },
  ];

  const targetLabel = targetVersion ? `for target version ${targetVersion}` : '(no target version supplied)';
  logger.log(`Per-version patch variants ${targetLabel}:\n`);

  let anyVariants = false;
  for (const { label, dir } of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = enumeratePatchNames(dir);
    const versioned = entries.filter(e => e.hasVariantDir);
    if (versioned.length === 0) continue;
    anyVariants = true;
    logger.log(`[${label}/]`);
    for (const entry of versioned) {
      let variants = [];
      try {
        variants = scanVariantDir(entry.variantDir);
      } catch (err) {
        logger.log(`  ${entry.name.padEnd(32)} ERROR — ${err.message}`);
        continue;
      }
      const stems = variants.map(v => v.stem);
      let picked = 'default';
      if (targetVersion) {
        const best = pickBestVariant(variants, targetVersion);
        if (best) picked = best.stem;
      }
      const hasDefault = entry.hasDefault ? 'default + ' : '';
      logger.log(`  ${entry.name.padEnd(32)} variants: ${hasDefault}${stems.join(', ') || '(none)'}`);
      logger.log(`  ${''.padEnd(32)} → would pick: ${picked}`);
    }
    logger.log('');
  }
  if (!anyVariants) {
    logger.log('(no patches have per-version variant directories)');
  }
  return 0;
}

/**
 * `ccpatch heal [--write] [--drift <path>] [--anchors <path>]`
 *
 * Read the recorded anchor-drift stream (storage/outputs/anchor-drift.jsonl),
 * group by patch, take the top-scoring candidate per drifted anchor, and
 * PROPOSE a rewritten runner/anchors.mjs registry entry as a unified diff on
 * stdout. With --write, apply the edit in place. Pure logic lives in
 * runner/heal.mjs; this is thin wiring.
 * ctx = { options, logger }.
 */
export async function runHealCommand(ctx) {
  const { options, logger } = ctx;
  const { runHeal } = await import('./heal.mjs');
  const res = runHeal({
    driftPath: options.driftPath || undefined,
    anchorsPath: options.anchorsPath || undefined,
    write: !!options.write,
  });
  if (!res.ok) {
    logger.error(`Error: ${res.error}`);
    return 1;
  }
  if (res.empty) {
    if (res.driftCount === 0) {
      logger.log('[heal] no anchor-drift.jsonl entries found. Run `ccpatch doctor <bundle>` first.');
    } else {
      logger.log('[heal] no healable anchors — every drifted entry is already up to date or lacks a registry target.');
    }
    for (const s of res.skipped) {
      logger.log(`  [skip] ${s.patch} (${s.id ?? '?'}): ${s.reason}`);
    }
    return 0;
  }
  if (options.write && res.wrote) {
    for (const c of res.changes) {
      logger.log(`  [heal] ${c.patch} → anchors.${c.id}.literal = ${JSON.stringify(c.literal)}`);
    }
    for (const s of res.skipped) {
      logger.log(`  [skip] ${s.patch} (${s.id ?? '?'}): ${s.reason}`);
    }
    logger.log(`[heal] applied ${res.changes.length} registry edit(s) to runner/anchors.mjs.`);
    return 0;
  }
  // Default: propose the diff on stdout. Informational lines go to the logger
  // (stderr under --quiet/--json); the diff is the stdout payload.
  process.stdout.write(res.diff);
  logger.log(`\n[heal] proposed ${res.changes.length} registry edit(s). Re-run with --write to apply.`);
  for (const s of res.skipped) {
    logger.log(`  [skip] ${s.patch} (${s.id ?? '?'}): ${s.reason}`);
  }
  return 0;
}

/**
 * `ccpatch repl <patched.js>` — interactive REPL against a patched bundle.
 *
 * v1 supports JavaScript bundles only (.mjs/.js/.cjs). Bun-compiled binaries
 * are out of scope: they can't be `node -e`'d as a module.
 */
export async function runReplCommand(options, logger = console) {
  const { patchedPath } = options;
  if (!fs.existsSync(patchedPath)) {
    logger.error(`Error: file not found: ${patchedPath}`);
    return 1;
  }
  if (isBinaryTarget(patchedPath)) {
    logger.error(`Error: repl only supports JavaScript bundles (.mjs/.js/.cjs) in v1. ` +
      `Bun-compiled binaries are out of scope.`);
    return 1;
  }
  const { runRepl } = await import('../tools/repl.mjs');
  return await runRepl(patchedPath, options.replIo || {});
}

/**
 * `ccpatch capabilities [--profile NAME] [--json]`
 *
 * Print a table of every loaded patch alongside its declared capabilities
 * and computed risk class. Honors the same profile / ccpatch.yml selection
 * logic as `apply` so users see exactly what they'd enable.
 */
export async function runCapabilities(options, patches, logger) {
  const yamlPath = path.resolve(process.cwd(), 'ccpatch.yml');
  let names;
  if (options.profile) {
    const profiles = readProfiles(yamlPath);
    const { enabled } = resolveProfile(options.profile, profiles, Object.keys(patches));
    names = enabled;
  } else {
    names = Object.keys(patches).sort();
  }

  const rows = names.map(name => {
    const p = patches[name] || {};
    const caps = Array.isArray(p.capabilities) ? p.capabilities : [];
    return {
      name,
      capabilities: caps,
      risk: classifyRisk(caps),
    };
  });

  // Summary tallies per capability.
  const tally = {};
  for (const c of CAPABILITIES) tally[c] = 0;
  for (const r of rows) for (const c of r.capabilities) tally[c] = (tally[c] || 0) + 1;

  if (options.json) {
    logger.log(JSON.stringify({
      profile: options.profile || null,
      patches: rows,
      summary: tally,
    }, null, 2));
    return 0;
  }

  const nameW = Math.max(22, ...rows.map(r => r.name.length));
  const capsW = Math.max(20, ...rows.map(r => r.capabilities.join(', ').length));
  logger.log(`${'Patch'.padEnd(nameW)}  ${'Capabilities'.padEnd(capsW)}  Risk`);
  for (const r of rows) {
    logger.log(
      `${r.name.padEnd(nameW)}  ${(r.capabilities.join(', ') || '-').padEnd(capsW)}  ${r.risk}`
    );
  }
  const summaryParts = CAPABILITIES
    .filter(c => tally[c] > 0)
    .map(c => `${tally[c]} ${c}`);
  logger.log(`\nSummary: ${rows.length} patch(es)` +
    (summaryParts.length ? ` — ${summaryParts.join(', ')}` : ''));
  return 0;
}

/**
 * `ccpatch watch <input.js> <output.js>` — run the normal apply flow once
 * with --dev, then watch core/*.mjs and extensions/*.mjs for changes. On any
 * change, re-emit only the overlay loader + shim files (NOT the patched
 * bundle). A debounce window collapses rapid save bursts into a single
 * re-emit.
 *
 * Exposed for testing as `runWatch({ inputPath, outputPath, ..., once, watcher })`.
 * If `opts.once === true`, runs the initial apply and re-emit then returns
 * (no fs.watch). If `opts.watcher` is provided, uses it instead of fs.watch
 * (for test injection).
 */
export async function runWatch(options, logger = console) {
  const fsmod = await import('node:fs');
  const initial = await runPatchCli([
    options.inputPath,
    options.outputPath,
    ...options.requestedPatches.flatMap(p => ['--patch', p]),
    ...(options.profile ? ['--profile', options.profile] : []),
    '--dev',
  ], logger);
  if (initial !== 0) {
    logger.error('[watch] initial apply failed; not entering watch loop.');
    return initial;
  }

  if (options.once) return 0;

  // Re-resolve patches (same logic as apply) so re-emit picks up edits.
  const reEmit = async (reason) => {
    try {
      const patches = await loadPatches({});
      const yamlPath = path.resolve(process.cwd(), 'ccpatch.yml');
      let names;
      if (options.profile) {
        const profiles = readProfiles(yamlPath);
        const { enabled } = resolveProfile(options.profile, profiles, Object.keys(patches));
        names = enabled;
      } else if (options.requestedPatches.length > 0) {
        names = resolvePatchNames(patches, options.requestedPatches);
      } else {
        const flags = readPatchFlags(yamlPath);
        names = flags
          ? Object.keys(patches).filter(n => flags[n] === true)
          : Object.keys(patches);
      }
      const emitted = emitOverlay(patches, names, path.dirname(options.outputPath), { dev: true });
      if (emitted) {
        logger.log(`[watch] re-emitted overlay (${reason})`);
      }
    } catch (err) {
      logger.error(`[watch] re-emit failed: ${err.message}`);
    }
  };

  const debounceMs = options.debounceMs ?? 200;
  let timer = null;
  const schedule = (reason) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; reEmit(reason); }, debounceMs);
  };

  const watchDirs = [
    path.join(PROJECT_ROOT, 'core'),
    path.join(PROJECT_ROOT, 'extensions'),
  ];
  const watchers = [];
  for (const dir of watchDirs) {
    if (!fsmod.existsSync(dir)) continue;
    const w = fsmod.watch(dir, { persistent: true }, (_event, filename) => {
      if (!filename || !filename.endsWith('.mjs')) return;
      schedule(filename);
    });
    watchers.push(w);
  }
  logger.log(`[watch] watching ${watchDirs.length} directories (debounce=${debounceMs}ms). Ctrl-C to exit.`);

  return await new Promise((resolve) => {
    const cleanup = () => {
      for (const w of watchers) { try { w.close(); } catch (_) {} }
      if (timer) clearTimeout(timer);
      logger.log('\n[watch] exiting.');
      resolve(0);
    };
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
  });
}

/**
 * Helper used by tests: given `opts` with patches, names, outputDir, and
 * shimDir (created by an initial emitOverlay({dev:true}) call), spin up a
 * debounced watch loop driven by an injected event source. Returns
 * `{ trigger, drain, getReEmitCount, stop }`.
 *
 * This factors out the debounce + re-emit core from `runWatch` so tests can
 * exercise it without spawning fs.watch.
 */
export function makeWatchLoop({ patches, names, outputDir, debounceMs = 200, logger = console }) {
  let timer = null;
  let reEmits = 0;
  const reEmit = (reason) => {
    reEmits++;
    try {
      emitOverlay(patches, names, outputDir, { dev: true });
      logger.log(`[watch] re-emitted overlay (${reason})`);
    } catch (err) {
      logger.error(`[watch] re-emit failed: ${err.message}`);
    }
  };
  return {
    trigger(reason = 'change') {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; reEmit(reason); }, debounceMs);
    },
    async drain() {
      await new Promise(r => setTimeout(r, debounceMs + 50));
    },
    getReEmitCount() { return reEmits; },
    stop() { if (timer) clearTimeout(timer); },
  };
}

/**
 * `ccpatch coverage <patched-bundle> [--smoke <cmd>] [--out report.json] [--cc-version X.Y.Z]`
 *
 * Cross-reference apply-time coverage (storage/outputs/coverage-apply-v<ver>.json,
 * written by applyNamedPatches) with runtime hits captured from the bundle.
 *
 * Runtime hits are read via stdin/stdout: the coverage_kernel patch dumps the
 * map on SIGTERM and on process exit, prefixed with "__CCP_COV__". We spawn
 * the bundle (`node patched.js` by default, or the user's --smoke command),
 * scan stdout for the prefix line, and parse the JSON payload.
 *
 * Exits non-zero if any patch is DEAD (applied but never executed).
 */
export async function runCoverage(options, logger = console) {
  const { spawn } = await import('node:child_process');
  const { bundlePath, smoke, outPath, ccVersion } = options;
  if (!fs.existsSync(bundlePath)) {
    logger.error(`Error: bundle not found: ${bundlePath}`);
    return 2;
  }
  // Locate the apply-time manifest. Try versioned then 'unknown'.
  const candidates = [];
  if (ccVersion) candidates.push(`storage/outputs/coverage-apply-v${ccVersion}.json`);
  candidates.push('storage/outputs/coverage-apply-unknown.json');
  // Fall back: any coverage-apply-*.json in the outputs dir.
  try {
    const dir = 'storage/outputs';
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('coverage-apply-') && f.endsWith('.json')) {
          const full = path.join(dir, f);
          if (!candidates.includes(full)) candidates.push(full);
        }
      }
    }
  } catch (_) { /* non-fatal */ }
  let applyManifest = null;
  let applyManifestPath = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        applyManifest = JSON.parse(fs.readFileSync(c, 'utf8'));
        applyManifestPath = c;
        break;
      } catch (_) { /* skip */ }
    }
  }
  if (!applyManifest) {
    logger.error('Error: no apply-time coverage manifest found in storage/outputs/. Run apply first.');
    return 2;
  }
  logger.log(`[coverage] apply-time manifest: ${applyManifestPath}`);

  // Spawn the bundle / smoke command and capture stdout.
  let cmd, args;
  if (smoke) {
    // The smoke string is a shell-style command; split on whitespace (simple).
    const parts = smoke.match(/\S+/g) || [];
    cmd = parts[0];
    args = parts.slice(1);
    if (!cmd) {
      logger.error('Error: --smoke value is empty');
      return 2;
    }
  } else {
    cmd = process.execPath;
    args = [bundlePath, '--version'];
  }

  logger.log(`[coverage] running: ${cmd} ${args.join(' ')}`);
  const runtimeHits = await new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d.toString('utf8'); });
    child.stderr.on('data', () => { /* ignored */ });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // Find the last __CCP_COV__ payload in stdout.
      const lines = buf.split('\n');
      let payload = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        const idx = ln.indexOf('__CCP_COV__');
        if (idx !== -1) { payload = ln.slice(idx + '__CCP_COV__'.length); break; }
      }
      let parsed = {};
      if (payload) {
        try { parsed = JSON.parse(payload); } catch (_) { parsed = {}; }
      }
      resolve(parsed);
    };
    child.on('exit', finish);
    child.on('error', () => finish());
    // Hard cap so a hung bundle doesn't wedge the coverage run. Both timers
    // are unref'd so a fast-exiting child closes the event loop immediately.
    const capMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
    const t1 = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      const t2 = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {}; finish(); }, 250);
      t2.unref?.();
    }, capMs);
    t1.unref?.();
  });

  // Cross-reference and build the report.
  const rows = [];
  let deadCount = 0;
  for (const name of Object.keys(applyManifest.patches).sort()) {
    const entry = applyManifest.patches[name];
    const hits = typeof runtimeHits[entry.coverageMarker] === 'number'
      ? runtimeHits[entry.coverageMarker]
      : 0;
    const applied = !!entry.applied;
    const instrumented = !!entry.coverageMarker;
    let status;
    if (!applied) {
      status = 'SKIPPED';
    } else if (!instrumented) {
      status = 'UNINSTRUMENTED';
    } else if (hits > 0) {
      status = 'LIVE';
    } else {
      status = 'DEAD';
      deadCount++;
    }
    rows.push({ name, applied, hits, instrumented, status, marker: entry.coverageMarker ?? null });
  }

  // Print markdown table.
  const headers = ['Patch', 'Applied', 'Hit', 'Status'];
  const widths = [
    Math.max(headers[0].length, ...rows.map(r => r.name.length)),
    headers[1].length,
    headers[2].length,
    Math.max(headers[3].length, ...rows.map(r => r.status.length)),
  ];
  const cell = (s, w) => String(s).padEnd(w);
  logger.log('');
  logger.log(`${cell(headers[0], widths[0])}  ${cell(headers[1], widths[1])}  ${cell(headers[2], widths[2])}  ${cell(headers[3], widths[3])}`);
  logger.log(`${'-'.repeat(widths[0])}  ${'-'.repeat(widths[1])}  ${'-'.repeat(widths[2])}  ${'-'.repeat(widths[3])}`);
  for (const r of rows) {
    const appliedStr = r.applied ? 'yes' : 'no';
    const hitStr = r.instrumented ? (r.hits > 0 ? 'yes' : 'no') : '-';
    logger.log(`${cell(r.name, widths[0])}  ${cell(appliedStr, widths[1])}  ${cell(hitStr, widths[2])}  ${cell(r.status, widths[3])}`);
  }
  logger.log('');
  logger.log(`[coverage] ${rows.length} patches, ${deadCount} DEAD`);

  if (outPath) {
    const report = {
      ccVersion: applyManifest.ccVersion ?? null,
      bundlePath,
      runAt: new Date().toISOString(),
      runtimeHits,
      patches: rows,
      deadCount,
    };
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
      logger.log(`[coverage] report written to: ${outPath}`);
    } catch (err) {
      logger.warn(`[coverage] could not write report: ${err.message}`);
    }
  }

  return deadCount > 0 ? 1 : 0;
}
