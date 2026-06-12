import fs from 'node:fs';
import path from 'node:path';

import { HELP, USAGE, maybePrintSubcommandHelp } from './cli/help.mjs';
import { buildCommandTable, namedSubcommands, DEFAULT_KEY } from './cli/commands.mjs';
import { extractGlobalFlags, makeLogger } from './cli/logger.mjs';
import { setVerbose, isVerbose, style } from './cli/style.mjs';
import { loadPatches } from './loader.mjs';
import { resolveProfile, classifyRisk, CAPABILITIES } from './manifest.mjs';
import { readProfiles, readPatchFlags } from './config.mjs';
import { resolvePatchNames } from './runner.mjs';
import { emitOverlay } from './overlay-builder.mjs';
import { PROJECT_ROOT } from './paths.mjs';

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
import { runVersions as runVersionsCmd } from './cli/cmd-versions.mjs';
import { runCoverage as runCoverageCmd, tokenizeSmoke as tokenizeSmokeCmd } from './cli/cmd-coverage.mjs';

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

  // Guard: the first two positionals are <input> <output>. A flag landing in
  // either slot means the author omitted a positional (a flag is being silently
  // swallowed as a filename — e.g. `patch-cli.mjs bundle.js --patch foo` writes a
  // file literally named "--patch"). Reject with a pointed message instead.
  if (args[0].startsWith('--')) {
    return { error: `Error: expected <input> <output>; got flag '${args[0]}' in input position — did you omit the input path?\n${USAGE}` };
  }
  if (args[1].startsWith('--')) {
    return { error: `Error: expected <input> <output>; got flag '${args[1]}' in output position — did you omit the output path?\n${USAGE}` };
  }

  const inputPath = path.resolve(args[0]);
  const outputPath = path.resolve(args[1]);
  const requestedPatches = [];
  let preloadPath = null;
  let profile = null;

  const patchOptions = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--patch' && args[i + 1]) {
      const names = args[i + 1].split(',').map(s => s.trim()).filter(Boolean);
      requestedPatches.push(...names);
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
    if (args[i] === '--output-diff') {
      patchOptions.outputDiff = true;
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
    // --allow-bun-drift: audited one-off bypass of the degraded-shim drift
    // gate (bunApiScanGate class d). The durable path is reviewing the shim
    // and committing an updated refmaps/bun-api-usage.v<ver>.json baseline.
    if (args[i] === '--allow-bun-drift') {
      patchOptions.allowBunDrift = true;
    }
    // Runtime coverage gate: --coverage forces the post-build headless boot +
    // marker check in non-strict builds; --no-coverage opts a --strict build
    // out of it (e.g. cross-building a bundle this host cannot execute).
    if (args[i] === '--coverage') {
      patchOptions.coverage = true;
    }
    if (args[i] === '--no-coverage') {
      patchOptions.noCoverage = true;
    }
    // --no-required: do NOT auto-include `required: true` infra patches when an
    // explicit --patch list is given. This is the patch-bisection escape hatch
    // (see docs/BISECTING.md): without it the minimum buildable set is the
    // requested patches + every required patch, so bugs in the required infra
    // layer itself cannot be isolated. Emits a LOUD one-line warning naming the
    // skipped patches — subscriber/hook-based patches will silently no-op.
    if (args[i] === '--no-required') {
      patchOptions.noRequired = true;
    }
    // WS6 Item 5: --paranoid / strict mode. At build time it forces fail-closed
    // repack (never pass --allow-unverified to WS1's repacker, treat any
    // [repack:skip] degradation as a build FAILURE) and documents the loud
    // CCPATCH_PARANOID runtime toggle for the injected fetch_interceptor.
    if (args[i] === '--paranoid') {
      patchOptions.paranoid = true;
    }
    // --allow-unverified: explicit opt-out of WS1's now-required post-repack
    // smoke check. Only threaded through to repack when the user passes it AND
    // paranoid mode is off (paranoid forces fail-closed and ignores this).
    if (args[i] === '--allow-unverified') {
      patchOptions.allowUnverified = true;
    }
    // Sidecar / verify controls (shared with the Makefile targets). Reverse-diff
    // capture is OPT-IN: the ~16MB sha256 per changed patch is the dominant build
    // cost, so it only runs when --emit-revert is set (the release target passes
    // it). --no-sidecar skips ALL sidecar writes (.sha256 + .ccp-revert.json) and
    // --no-verify skips the verify literal scan; both are used by `make dev` to
    // keep the inner edit loop fast.
    if (args[i] === '--emit-revert') {
      patchOptions.emitRevert = true;
    }
    if (args[i] === '--no-sidecar') {
      patchOptions.noSidecar = true;
    }
    if (args[i] === '--no-verify') {
      patchOptions.noVerify = true;
    }
  }
  if (!patchOptions.strict && process.env.CCPATCH_STRICT === '1') {
    patchOptions.strict = true;
  }
  if (!patchOptions.paranoid && process.env.CCPATCH_PARANOID === '1') {
    patchOptions.paranoid = true;
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
  if (args.includes('--applied')) {
    const vi = args.indexOf('--version');
    const version = vi !== -1 ? args[vi + 1] : undefined;
    return { applied: true, version };
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
  // Sync the per-patch / per-shim sub-chatter tier (ccpLog) and any spawned
  // sub-process (the doctor pre-pass) to the resolved level: chatter is on only
  // at debug, off otherwise. Exporting CCPATCH_LOG_LEVEL is the carrier so a
  // child Node process re-derives the SAME answer instead of falling back to its
  // own stdout.isTTY. Skipped when the host passed a custom logger (tests).
  if (logger === console) {
    process.env.CCPATCH_LOG_LEVEL = level;
    setVerbose(level === 'debug');
  }
  const leveled = (logger === console)
    ? makeLogger({ level, sink: console, json })
    : logger;
  // Alias so every existing `logger.log(...)` in this function uses the leveled
  // sink without us having to touch each call site.
  logger = leveled;
  args = cleanedArgs;

  // WS6 Item 5: --paranoid is a GLOBAL flag (applies to build, doctor, etc.).
  // Lift it out of argv here — once, before any subcommand parser runs — and
  // export it to the process env as CCPATCH_PARANOID=1. Two reasons env is the
  // carrier rather than a threaded option:
  //   1. doctor's flag parsing lives in cli/commands.mjs (which this workstream
  //      does not own); reading the env keeps the toggle uniform across every
  //      subcommand without editing each parser.
  //   2. The injected fetch_interceptor hook runs inside the PATCHED CLI at
  //      runtime, not in this patcher process. It reads CCPATCH_PARANOID from
  //      its own env. Exporting it here means anything the build spawns (e.g.
  //      WS1's repacker, or a smoke run of the bundle) inherits the loud toggle.
  // The per-build parseBuildArgs ALSO records options.patchOptions.paranoid (so
  // the build path can act on it directly + honor a pre-set env); this is the
  // global strip so `ccpatch doctor <in> --paranoid` and friends see it too.
  if (args.includes('--paranoid')) {
    args = args.filter(a => a !== '--paranoid');
    process.env.CCPATCH_PARANOID = '1';
  }

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
  // Compact (default): one `name  description` line per patch. Verbose
  // (--verbose / -v / VERBOSE=1 / --log-level=debug): a category-grouped roll-up
  // that also surfaces the metadata you'd otherwise have to open each patch file
  // to see — capabilities, and required/disabled status — so the listing matches
  // the per-patch detail the build prints under VERBOSE.
  if (options.list) {
    const patches = await loadPatches({ version: pickLoadVersion(options) });
    const names = Object.keys(patches).sort();
    if (!isVerbose()) {
      for (const name of names) {
        const desc = patches[name].description ?? '';
        logger.log(`${name.padEnd(32)} ${desc}`);
      }
      return 0;
    }
    // Verbose: group by category so the listing reads like the patch catalog.
    const byCategory = new Map();
    for (const name of names) {
      const cat = patches[name].category ?? 'uncategorized';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(name);
    }
    logger.log(`${style.bold(`${names.length} patches`)} ${style.dim(`· ${byCategory.size} categories`)}`);
    for (const cat of [...byCategory.keys()].sort()) {
      const group = byCategory.get(cat);
      logger.log('');
      logger.log(`${style.cyan(cat)} ${style.dim(`(${group.length})`)}`);
      for (const name of group) {
        const p = patches[name];
        const tags = [];
        if (p.required) tags.push('required');
        if (p.enabled === false) tags.push('disabled');
        const caps = Array.isArray(p.capabilities) ? p.capabilities : [];
        if (caps.length) tags.push(caps.join('+'));
        const meta = tags.length ? ` ${style.dim(`[${tags.join(' · ')}]`)}` : '';
        logger.log(`  ${style.green(name)}${meta}`);
        if (p.description) logger.log(`    ${style.dim(p.description)}`);
      }
    }
    return 0;
  }

  // `--applied`: unlike `--list` (which enumerates the whole catalog), this
  // reads the per-build results JSON that writeApplyArtifacts() emitted for the
  // most recent build of this version and reports ONLY the patches that actually
  // applied — joined back to catalog metadata (category, capabilities, status)
  // and grouped like the verbose listing. Answers "what's in this bundle", not
  // "what patches exist". Requires a prior build (the results JSON to exist).
  if (options.applied) {
    const version = options.version || process.env.CCPATCH_CLI_VERSION || undefined;
    if (!version) {
      logger.log('--applied needs a version: pass --version x.y.z or set CCPATCH_CLI_VERSION (it selects which patch-results-v<ver>.json to read).');
      return 1;
    }
    const resultsPath = path.join(PROJECT_ROOT, 'storage', 'outputs', `patch-results-v${version}.json`);
    if (!fs.existsSync(resultsPath)) {
      logger.log(`No build results for v${version} at ${resultsPath} — run \`make patch-claude-code\` first.`);
      return 1;
    }
    let results;
    try {
      results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    } catch (err) {
      logger.log(`Could not parse ${resultsPath}: ${err.message} — re-run \`make patch-claude-code\` to regenerate it.`);
      return 1;
    }
    if (!results.patches || typeof results.patches !== 'object') {
      logger.log(`${resultsPath} is missing a "patches" object (stale or hand-edited format) — re-run \`make patch-claude-code\`.`);
      return 1;
    }
    const patches = await loadPatches({ version });
    // Applied = status applied / applied-fallback / no-change-ok (same liveness
    // test writeApplyArtifacts uses for the coverage manifest).
    const isApplied = (s) => s === 'applied' || s === 'applied-fallback' || s === 'no-change-ok';
    const names = Object.keys(results.patches)
      .filter((n) => isApplied(results.patches[n].status))
      .sort();
    const byCategory = new Map();
    for (const name of names) {
      const cat = patches[name]?.category ?? 'uncategorized';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(name);
    }
    logger.log(`${style.bold(`${names.length} patches applied`)} ${style.dim(`· v${version} · ${byCategory.size} categories`)}`);
    for (const cat of [...byCategory.keys()].sort()) {
      const group = byCategory.get(cat);
      logger.log('');
      logger.log(`${style.cyan(cat)} ${style.dim(`(${group.length})`)}`);
      for (const name of group) {
        const p = patches[name];
        const tags = [];
        if (p?.required) tags.push('required');
        const caps = Array.isArray(p?.capabilities) ? p.capabilities : [];
        if (caps.length) tags.push(caps.join('+'));
        const variant = results.patches[name].resolvedVariant;
        if (variant && variant !== 'default') tags.push(`variant:${variant}`);
        const meta = tags.length ? ` ${style.dim(`[${tags.join(' · ')}]`)}` : '';
        logger.log(`  ${style.green(name)}${meta}`);
        if (p?.description) logger.log(`    ${style.dim(p.description)}`);
      }
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
  return runVersionsCmd(options, logger);
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
    if (res.nextLine) logger.log(res.nextLine);
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
    if (res.nextLine) logger.log(res.nextLine);
    return 0;
  }
  // Default: propose the diff on stdout. Informational lines go to the logger
  // (stderr under --quiet/--json); the diff is the stdout payload.
  process.stdout.write(res.diff);
  logger.log(`\n[heal] proposed ${res.changes.length} registry edit(s). Re-run with --write to apply.`);
  for (const s of res.skipped) {
    logger.log(`  [skip] ${s.patch} (${s.id ?? '?'}): ${s.reason}`);
  }
  if (res.nextLine) logger.log(res.nextLine);
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

// #13: tokenizeSmoke and runCoverage are now canonical in ./cli/cmd-coverage.mjs.
// Re-export them for any callers that import off this module.
export { tokenizeSmokeCmd as tokenizeSmoke };

export async function runCoverage(options, logger = console) {
  return runCoverageCmd(options, logger);
}
