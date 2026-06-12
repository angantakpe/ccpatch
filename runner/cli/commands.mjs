// ARCH4 — declarative command table.
//
// Historically `runner/cli.mjs` dispatched subcommands through three separate
// if-ladders: one in `parsePatchCliArgs` (parse-time), one in `runPatchCli`
// (execution-time), and one in `runModuleCommand` (the `module` subdispatch).
// This module replaces the parse + execute ladders with a single table so the
// two stay in sync and `ccpatch --help` can derive its one-liners from the same
// source as the per-command HELP blocks.
//
// Each entry is:
//   {
//     name,            // subcommand token, e.g. 'revert'. The default build
//                      // path has no token; it is registered under DEFAULT_KEY.
//     parse(rest),     // produce the options object parsePatchCliArgs returns.
//                      // `rest` is args.slice(1) (the args AFTER the subcommand
//                      // token); the default entry receives the full args array.
//     resultKey,       // the discriminator key set on the parsed options object
//                      // (e.g. 'revert' → options.revert === true). The default
//                      // build path uses DEFAULT_KEY.
//     run(ctx),        // execute. ctx = { options, patches, logger }. For
//                      // commands that don't need patches loaded, `patches` is
//                      // null. Return a number (exit code) or a Promise<number>.
//     needsPatches,    // true → loadPatches() before running (apply/doctor/...).
//     helpKey,         // key into the HELP map (cli/help.mjs).
//   }
//
// The handlers are passed in from cli.mjs (which owns the run* implementations)
// to avoid a circular import; commands.mjs only owns the *structure*.

import path from 'node:path';

// U2: `explain` owns its own handler in cli/cmd-explain.mjs. Unlike the other
// run* handlers (passed in via `impl` from cli.mjs to dodge a circular import),
// cmd-explain.mjs is a leaf that only depends on config/manifest/runner, so we
// can import it directly here without creating a cycle.
import { runExplain } from './cmd-explain.mjs';
import { runDissect } from './cmd-dissect.mjs';
import { runOutputsClear } from './cmd-outputs.mjs';
import { runPin } from './cmd-pin.mjs';

export const DEFAULT_KEY = '__build__';

/**
 * Build the ordered command table. `impl` is the bag of run* handlers and the
 * default-build parser supplied by cli.mjs.
 *
 * impl = {
 *   parseBuild(args), runBuild(ctx),
 *   runRevert, runDiff, runReplCommand, runVersions, runRefmap,
 *   runFallbackCapture, runWatch, runCoverage, runDoctor, runCapabilities,
 *   runHealCommand, runAck,
 * }
 */
export function buildCommandTable(impl) {
  /** @type {Array<object>} */
  const table = [
    {
      name: 'revert',
      resultKey: 'revert',
      helpKey: 'revert',
      needsPatches: false,
      parse(rest) {
        if (rest.length < 1) {
          return { error: 'Usage: node patch-cli.mjs revert <patched.js> [--output <restored.js>]' };
        }
        const patchedPath = path.resolve(rest[0]);
        let outputPath = null;
        for (let i = 1; i < rest.length; i++) {
          if ((rest[i] === '--output' || rest[i] === '-o') && rest[i + 1]) outputPath = path.resolve(rest[++i]);
        }
        return { revert: true, patchedPath, outputPath };
      },
      run: (ctx) => impl.runRevert(ctx.options, ctx.logger),
    },
    {
      name: 'diff',
      resultKey: 'diff',
      helpKey: 'diff',
      needsPatches: false,
      parse(rest) {
        if (rest.length < 1) {
          return { error: 'Usage: node patch-cli.mjs diff <patched.js>' };
        }
        return { diff: true, patchedPath: path.resolve(rest[0]) };
      },
      run: (ctx) => impl.runDiff(ctx.options, ctx.logger),
    },
    {
      name: 'repl',
      resultKey: 'repl',
      helpKey: 'repl',
      needsPatches: false,
      parse(rest) {
        if (rest.length < 1) {
          return { error: 'Usage: node patch-cli.mjs repl <patched.js>' };
        }
        return { repl: true, patchedPath: path.resolve(rest[0]) };
      },
      run: (ctx) => impl.runReplCommand(ctx.options, ctx.logger),
    },
    {
      name: 'versions',
      resultKey: 'versions',
      helpKey: 'versions',
      needsPatches: false,
      parse(rest) {
        let targetVersion = null;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--target-version' && rest[i + 1]) targetVersion = rest[++i];
        }
        if (!targetVersion && process.env.CCPATCH_CLI_VERSION) {
          targetVersion = process.env.CCPATCH_CLI_VERSION;
        }
        return { versions: true, targetVersion };
      },
      run: (ctx) => impl.runVersions(ctx.options, ctx.logger),
    },
    {
      name: 'capabilities',
      resultKey: 'capabilities',
      helpKey: 'capabilities',
      needsPatches: true,
      parse(rest) {
        let profile = null;
        let json = false;
        for (let i = 0; i < rest.length; i++) {
          if ((rest[i] === '--profile' || rest[i] === '-p') && rest[i + 1]) profile = rest[++i];
          else if (rest[i] === '--json') json = true;
        }
        return { capabilities: true, profile, json };
      },
      run: (ctx) => impl.runCapabilities(ctx.options, ctx.patches, ctx.logger),
    },
    {
      name: 'refmap',
      resultKey: 'refmap',
      helpKey: 'refmap',
      needsPatches: false,
      parse(rest) {
        if (rest.length < 1) {
          return { error: 'Usage: node patch-cli.mjs refmap <bundle.js> [--out <path>] [--cc-version X.Y.Z] [--check]' };
        }
        const bundlePath = path.resolve(rest[0]);
        let outPath = null;
        let ccVersion = null;
        let check = false;
        for (let i = 1; i < rest.length; i++) {
          if (rest[i] === '--out' && rest[i + 1]) outPath = path.resolve(rest[++i]);
          else if (rest[i] === '--cc-version' && rest[i + 1]) ccVersion = rest[++i];
          else if (rest[i] === '--check') check = true;
        }
        if (!ccVersion && process.env.CCPATCH_CLI_VERSION) ccVersion = process.env.CCPATCH_CLI_VERSION;
        return { refmap: true, bundlePath, outPath, ccVersion, check };
      },
      run: (ctx) => impl.runRefmap(ctx.options, ctx.logger),
    },
    {
      name: 'fallback-capture',
      resultKey: 'fallbackCapture',
      helpKey: 'fallback-capture',
      needsPatches: false,
      parse(rest) {
        if (rest.length < 1) {
          return { error: 'Usage: node patch-cli.mjs fallback-capture <patched.js> --against <unpatched.js> --patch <name>' };
        }
        const patchedPath = path.resolve(rest[0]);
        let againstPath = null;
        let patchName = null;
        for (let i = 1; i < rest.length; i++) {
          if (rest[i] === '--against' && rest[i + 1]) againstPath = path.resolve(rest[++i]);
          else if (rest[i] === '--patch' && rest[i + 1]) patchName = rest[++i];
        }
        if (!againstPath) {
          return { error: 'fallback-capture: --against <unpatched.js> is required' };
        }
        return { fallbackCapture: true, patchedPath, againstPath, patchName };
      },
      run: (ctx) => impl.runFallbackCapture(ctx.options, ctx.logger),
    },
    {
      name: 'watch',
      resultKey: 'watch',
      helpKey: 'watch',
      needsPatches: false,
      parse(rest) {
        if (rest.length < 2) {
          return { error: 'Usage: node patch-cli.mjs watch <input.js> <output.js> [--patch <name>] [--profile <name>] [--debounce <ms>]' };
        }
        const inputPath = path.resolve(rest[0]);
        const outputPath = path.resolve(rest[1]);
        let profile = null;
        let debounceMs = 200;
        const requestedPatches = [];
        for (let i = 2; i < rest.length; i++) {
          if (rest[i] === '--patch' && rest[i + 1]) requestedPatches.push(rest[++i]);
          else if ((rest[i] === '--profile' || rest[i] === '-p') && rest[i + 1]) profile = rest[++i];
          else if (rest[i] === '--debounce' && rest[i + 1]) debounceMs = parseInt(rest[++i], 10) || 200;
        }
        return { watch: true, inputPath, outputPath, requestedPatches, profile, debounceMs };
      },
      run: (ctx) => impl.runWatch(ctx.options, ctx.logger),
    },
    {
      name: 'coverage',
      resultKey: 'coverage',
      helpKey: 'coverage',
      needsPatches: false,
      parse(rest) {
        if (rest.length < 1) {
          return { error: 'Usage: node patch-cli.mjs coverage <patched-bundle> [--smoke <cmd>] [--out <report.json>] [--cc-version X.Y.Z]' };
        }
        const bundlePath = path.resolve(rest[0]);
        let smoke = null;
        let outPath = null;
        let ccVersion = null;
        for (let i = 1; i < rest.length; i++) {
          if (rest[i] === '--smoke' && rest[i + 1]) smoke = rest[++i];
          else if (rest[i] === '--out' && rest[i + 1]) outPath = path.resolve(rest[++i]);
          else if (rest[i] === '--cc-version' && rest[i + 1]) ccVersion = rest[++i];
        }
        if (!ccVersion && process.env.CCPATCH_CLI_VERSION) ccVersion = process.env.CCPATCH_CLI_VERSION;
        return { coverage: true, bundlePath, smoke, outPath, ccVersion };
      },
      run: (ctx) => impl.runCoverage(ctx.options, ctx.logger),
    },
    {
      name: 'doctor',
      resultKey: 'doctor',
      helpKey: 'doctor',
      needsPatches: true,
      parse(rest) {
        if (rest.length < 1) {
          return { error: 'Usage: node patch-cli.mjs doctor <input.js> [--profile <name>] [--strict]' };
        }
        const inputPath = path.resolve(rest[0]);
        let profile = null;
        let strict = false;
        let suggest = false;
        for (let i = 1; i < rest.length; i++) {
          if ((rest[i] === '--profile' || rest[i] === '-p') && rest[i + 1]) profile = rest[++i];
          else if (rest[i] === '--strict') strict = true;
          else if (rest[i] === '--suggest') suggest = true;
        }
        if (!strict && process.env.CCPATCH_STRICT === '1') strict = true;
        return { doctor: true, inputPath, profile, strict, suggest };
      },
      run: (ctx) => impl.runDoctor(ctx),
    },
    {
      name: 'heal',
      resultKey: 'heal',
      helpKey: 'heal',
      needsPatches: false,
      parse(rest) {
        let write = false;
        let driftPath = null;
        let anchorsPath = null;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--write') write = true;
          else if (rest[i] === '--drift' && rest[i + 1]) driftPath = path.resolve(rest[++i]);
          else if (rest[i] === '--anchors' && rest[i + 1]) anchorsPath = path.resolve(rest[++i]);
        }
        return { heal: true, write, driftPath, anchorsPath };
      },
      run: (ctx) => impl.runHealCommand(ctx),
    },
    {
      name: 'ack',
      resultKey: 'ack',
      helpKey: 'ack',
      needsPatches: true,
      parse(rest) {
        if (rest.length < 1 || rest[0].startsWith('-')) {
          return { error: 'Usage: node patch-cli.mjs ack <patch> [--all-caps] [--dry-run]' };
        }
        const ackPatch = rest[0];
        let ackAllCaps = false;
        let ackDryRun = false;
        for (let i = 1; i < rest.length; i++) {
          if (rest[i] === '--all-caps') ackAllCaps = true;
          else if (rest[i] === '--dry-run') ackDryRun = true;
        }
        return { ack: true, ackPatch, ackAllCaps, ackDryRun };
      },
      run: (ctx) => impl.runAck(ctx),
    },
    {
      name: 'explain',
      resultKey: 'explain',
      helpKey: 'explain',
      needsPatches: true,
      parse(rest) {
        let profile = null;
        let json = false;
        let noRequired = false;
        const requestedPatches = [];
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--patch' && rest[i + 1]) requestedPatches.push(rest[++i]);
          else if ((rest[i] === '--profile' || rest[i] === '-p') && rest[i + 1]) profile = rest[++i];
          else if (rest[i] === '--json') json = true;
          else if (rest[i] === '--no-required') noRequired = true;
        }
        return { explain: true, requestedPatches, profile, json, noRequired };
      },
      run: (ctx) => runExplain(ctx),
    },
    {
      name: 'dissect',
      resultKey: 'dissect',
      helpKey: 'dissect',
      // Read-only structural analysis. --ownership greps core/extensions source
      // itself, so no loaded patch objects are needed.
      needsPatches: false,
      parse(rest) {
        if (rest.length < 1 || rest[0].startsWith('-')) {
          return { error: 'Usage: ccpatch dissect <cli.js> [--against <other.js>] [--native] [--ownership] [--context <N>] [--cc-version X.Y.Z] [--json]' };
        }
        const inputPath = path.resolve(rest[0]);
        let againstPath = null;
        let native = false;
        let ownership = false;
        let context = 0;
        let ccVersion = null;
        let json = false;
        for (let i = 1; i < rest.length; i++) {
          if (rest[i] === '--against' && rest[i + 1]) againstPath = path.resolve(rest[++i]);
          else if (rest[i] === '--native') native = true;
          else if (rest[i] === '--ownership') ownership = true;
          else if (rest[i] === '--context' && rest[i + 1]) context = parseInt(rest[++i], 10) || 0;
          else if (rest[i] === '--cc-version' && rest[i + 1]) ccVersion = rest[++i];
          else if (rest[i] === '--json') json = true;
        }
        if (!ccVersion && process.env.CCPATCH_CLI_VERSION) ccVersion = process.env.CCPATCH_CLI_VERSION;
        return { dissect: true, inputPath, againstPath, native, ownership, context, ccVersion, json };
      },
      run: (ctx) => runDissect(ctx),
    },
    {
      name: 'pin',
      resultKey: 'pin',
      helpKey: 'pin',
      needsPatches: false,
      parse(rest) {
        if (rest.length < 1 || rest[0].startsWith('-')) {
          return { error: 'Usage: ccpatch pin <version> [--source "<desc>"] [--force] [--input <path>] [--verbose]' };
        }
        const pinVersion = rest[0];
        let pinSource = null;
        let pinForce = false;
        let pinInput = null;
        let pinVerbose = false;
        for (let i = 1; i < rest.length; i++) {
          if ((rest[i] === '--source' || rest[i] === '-s') && rest[i + 1]) pinSource = rest[++i];
          else if (rest[i] === '--force' || rest[i] === '-f') pinForce = true;
          else if (rest[i] === '--input' && rest[i + 1]) pinInput = rest[++i];
          else if (rest[i] === '--verbose' || rest[i] === '-v') pinVerbose = true;
        }
        return { pin: true, pinVersion, pinSource, pinForce, pinInput, pinVerbose };
      },
      run: (ctx) => runPin(ctx),
    },
    {
      name: 'outputs',
      resultKey: 'outputs',
      helpKey: 'outputs',
      needsPatches: false,
      parse(rest) {
        // Expect: outputs clear [--force] [--rotate <N>]
        const sub = rest[0];
        if (sub !== 'clear') {
          return { error: 'Usage: node patch-cli.mjs outputs clear [--force] [--rotate <KB>]' };
        }
        let force = false;
        let rotateKb = null;
        let outputsDir = null;
        for (let i = 1; i < rest.length; i++) {
          if (rest[i] === '--force') force = true;
          else if (rest[i] === '--rotate' && rest[i + 1]) rotateKb = parseFloat(rest[++i]);
          else if (rest[i] === '--outputs-dir' && rest[i + 1]) outputsDir = rest[++i];
        }
        return { outputs: true, outputsSub: sub, force, rotateKb, outputsDir };
      },
      run: (ctx) => runOutputsClear(ctx),
    },
    {
      // The default build path is NOT a named subcommand: it takes positional
      // <input.js> <output.js>. Registered under DEFAULT_KEY so the dispatcher
      // can fall back to it when args[0] is not a known subcommand token.
      name: DEFAULT_KEY,
      resultKey: DEFAULT_KEY,
      helpKey: 'build',
      needsPatches: true,
      // The default parser sees the FULL args array (it reads positionals at
      // index 0/1), not args.slice(1).
      parse: (args) => impl.parseBuild(args),
      run: (ctx) => impl.runBuild(ctx),
    },
  ];

  const byName = new Map();
  const byResultKey = new Map();
  for (const cmd of table) {
    byName.set(cmd.name, cmd);
    byResultKey.set(cmd.resultKey, cmd);
  }

  return { table, byName, byResultKey };
}

/**
 * Subcommand tokens that the parse-time dispatcher recognizes (everything
 * except the default build entry). Used to decide whether args[0] selects a
 * named subcommand or falls through to the positional build path.
 */
export function namedSubcommands(commandTable) {
  return commandTable.table
    .filter(c => c.name !== DEFAULT_KEY)
    .map(c => c.name);
}
