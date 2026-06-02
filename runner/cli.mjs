import path from 'node:path';

import { HELP, USAGE, maybePrintSubcommandHelp } from './cli/help.mjs';
import { buildCommandTable, namedSubcommands, DEFAULT_KEY } from './cli/commands.mjs';
import { extractGlobalFlags, makeLogger } from './cli/logger.mjs';
import { loadPatches } from './loader.mjs';
import { resolveProfile, classifyRisk, CAPABILITIES } from './manifest.mjs';
import { readProfiles } from './config.mjs';

// A1: per-command handlers moved out of this god-module into ./cli/. cli.mjs is
// now a THIN dispatcher: it owns argv parsing, global flags, the COMMANDS table
// wiring, and a few small commands; each large handler lives in its own file.
// Every symbol this module historically exported is re-exported below so tests
// and the rest of runner/ keep resolving their imports unchanged.
import { runBuild, parseBuildArgs } from './cli/cmd-build.mjs';
import { runRevert } from './cli/cmd-revert.mjs';
import { runDiff } from './cli/cmd-diff.mjs';
import { runDoctor, runDoctorCore } from './cli/cmd-doctor.mjs';
import { runAck, parseThreatModelTable } from './cli/cmd-ack.mjs';
import { runModuleCommand } from './cli/cmd-module.mjs';
import {
  parseAllowCapabilities,
  findGateViolations,
  findUnackedAckRequired,
  ACK_REQUIRED_CAPS,
} from './cli/capabilities.mjs';
import { runRefmap } from './cli/cmd-refmap.mjs';
import { runVersions } from './cli/cmd-versions.mjs';
import { runFallbackCapture } from './cli/cmd-fallback.mjs';
import { runReplCommand } from './cli/cmd-repl.mjs';
import { runWatch, makeWatchLoop } from './cli/cmd-watch.mjs';
import { runCoverage, tokenizeSmoke } from './cli/cmd-coverage.mjs';

// USAGE / HELP are owned by ./cli/help.mjs. Re-exported for legacy callers
// that imported the symbol off this module.
export { USAGE, HELP };

// A1: re-export every symbol moved into ./cli/* so the public surface of
// cli.mjs is unchanged (tests import these directly off '../runner/cli.mjs').
export {
  runBuild,
  parseBuildArgs,
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
  runRefmap,
  runVersions,
  runFallbackCapture,
  runReplCommand,
  runWatch,
  makeWatchLoop,
  runCoverage,
  tokenizeSmoke,
};

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
  if (options && !options.error) {
    options.json = json;
    options.jsonOutput = json;
  }
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
