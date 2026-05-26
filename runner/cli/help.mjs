// Per-subcommand help text. Centralized here so each subcommand owns its own
// usage block and the top-level cli.mjs stays small. Keep entries
// alphabetically sorted by command name.
//
// Each value is the full block that should be printed for
// `ccpatch <cmd> --help`. The top-level USAGE composes one-line excerpts for
// the bare `ccpatch --help` listing.

export const HELP = Object.freeze({
  build:
    'Usage: ccpatch <input.js> <output.js> [options]\n' +
    '\n' +
    'Apply enabled patches from ccpatch.yml (or --patch / --profile) to an\n' +
    'unminified Claude Code bundle and write the patched output.\n' +
    '\n' +
    'Options:\n' +
    '  --patch <name>           Apply just this patch (repeatable). "all" = every patch.\n' +
    '  --profile <name>         Profile from ccpatch.yml: minimal | standard | power | native\n' +
    '  --preload <path.mjs>     Emit a Node --require preload helper to this path\n' +
    '  --strict                 Fail on weak verify, anchor drift, or unacked caps\n' +
    '  --dry-run                Print the unified diff + shadow report, don\'t write\n' +
    '  --write-on-clean         With --dry-run: write only if shadow report is clean\n' +
    '  --no-fallback            Skip fallback diff application on anchor miss\n' +
    '  --dev                    Emit hot-reload shim layout under ccpatch-overlay-shims/\n' +
    '  --version <x.y.z>        Pin to a specific Claude Code release\n' +
    '  --model <id>             Override default model for patches that consult it\n' +
    '  --allow-capabilities <l> Comma-list, "all", or "none". Acks high-risk caps.\n' +
    '  --allow-unacked          Warn-instead-of-fail for unacked network/exec/env caps\n' +
    '  --json                   Emit a single JSON build report to stdout\n' +
    '  --log-level <lvl>        silent | error | warn | info | debug (default: info)\n' +
    '  --quiet                  Alias for --log-level=error\n' +
    '  --help                   Show this message\n' +
    '\n' +
    'Profiles: --profile=native auto-excludes esm_compat + fix_bun_shim so the\n' +
    'output can be repacked into a Bun single-executable.',

  capabilities:
    'Usage: ccpatch capabilities [--profile <name>] [--json]\n' +
    '\n' +
    'List every loaded patch alongside its declared capabilities and risk class.',

  coverage:
    'Usage: ccpatch coverage <patched.js> [--smoke <cmd>] [--out <report.json>] [--cc-version X.Y.Z]\n' +
    '\n' +
    'Cross-reference apply-time coverage with runtime hits from coverage_kernel.\n' +
    'Exits non-zero when any applied patch is DEAD (never executed).',

  diff:
    'Usage: ccpatch diff <patched.js>\n' +
    '\n' +
    'Summarize the reverse-diff sidecar produced at apply time.',

  doctor:
    'Usage: ccpatch doctor <input.js> [--profile <name>] [--strict] [--suggest]\n' +
    '\n' +
    'Probe every enabled patch\'s anchor against an unpatched bundle and report\n' +
    'OK / DRIFT / MISSING / UNVERIFIED. Writes anchor-drift.jsonl on drift.\n' +
    '\n' +
    'Options:\n' +
    '  --profile <name>  Use this profile from ccpatch.yml\n' +
    '  --strict          Treat UNVERIFIED as failure (exit 1)\n' +
    '  --suggest         Read anchor-drift.jsonl and print top-3 fuzzy candidates\n' +
    '                    plus a copy-pasteable patch stub for each drifted patch',

  'fallback-capture':
    'Usage: ccpatch fallback-capture <patched.js> --against <unpatched.js> [--patch <name>]\n' +
    '\n' +
    'Print a unified diff suitable for a patch module\'s fallbackDiff.patch field.',

  module:
    'Usage:\n' +
    '  ccpatch module install <path-or-url> [--strict] [--allow-capabilities <list>] [--force]\n' +
    '  ccpatch module list\n' +
    '  ccpatch module remove <name>\n' +
    '  ccpatch module verify <name>\n' +
    '  ccpatch module update <name>',

  refmap:
    'Usage: ccpatch refmap <bundle.js> [--out <path>] [--cc-version X.Y.Z] [--check]\n' +
    '\n' +
    'Build (or verify with --check) the refmap JSON for a bundle. The refmap\n' +
    'is consumed by AST-anchor patches to skip costly resolution at apply time.',

  repl:
    'Usage: ccpatch repl <patched.js>\n' +
    '\n' +
    'Interactive Node REPL with the patched bundle loaded as a module.\n' +
    'JS bundles only; Bun-compiled binaries are out of scope in v1.',

  revert:
    'Usage: ccpatch revert <patched.js> [--output <restored.js>]\n' +
    '\n' +
    'Reverse every applied patch using the .ccp-revert.json sidecar.',

  versions:
    'Usage: ccpatch versions [--target-version <x.y.z>]\n' +
    '\n' +
    'List per-version patch variants and show which one would be picked for\n' +
    'the supplied target version (or CCPATCH_CLI_VERSION).',

  watch:
    'Usage: ccpatch watch <input.js> <output.js> [--patch <name>] [--profile <name>] [--debounce <ms>]\n' +
    '\n' +
    'Apply once with --dev, then watch core/ and extensions/ and re-emit the\n' +
    'overlay loader + shim files on change. Does NOT re-patch the bundle.',
});

/**
 * The top-level USAGE banner. Mirrors the legacy single block at the top of
 * runner/cli.mjs so external callers / docs that grep for it still match.
 */
export const USAGE =
  'Usage:\n' +
  '  node patch-cli.mjs <input.js> <output.js> [--patch <name>] [--profile <name>] [--preload <preload.mjs>] [--strict] [--dry-run] [--write-on-clean] [--allow-capabilities <list>] [--allow-unacked] [--dev]\n' +
  '  node patch-cli.mjs watch <input.js> <output.js> [--patch <name>] [--profile <name>] [--debounce <ms>]\n' +
  '  node patch-cli.mjs doctor <input.js> [--profile <name>] [--strict] [--suggest]\n' +
  '  node patch-cli.mjs revert <patched.js> [--output <restored.js>]\n' +
  '  node patch-cli.mjs diff <patched.js>\n' +
  '  node patch-cli.mjs repl <patched.js>\n' +
  '  node patch-cli.mjs versions [--target-version <x.y.z>]\n' +
  '  node patch-cli.mjs capabilities [--profile <name>] [--json]\n' +
  '  node patch-cli.mjs refmap <bundle.js> [--out <path>] [--cc-version X.Y.Z] [--check]\n' +
  '  node patch-cli.mjs fallback-capture <patched.js> --against <unpatched.js> [--patch <name>]\n' +
  '  node patch-cli.mjs coverage <patched.js> [--smoke <cmd>] [--out <report.json>] [--cc-version X.Y.Z]\n' +
  '  node patch-cli.mjs module install <path-or-url> [--strict] [--allow-capabilities <list>] [--force]\n' +
  '  node patch-cli.mjs module list\n' +
  '  node patch-cli.mjs module remove <name>\n' +
  '  node patch-cli.mjs module verify <name>\n' +
  '  node patch-cli.mjs module update <name>\n' +
  '  node patch-cli.mjs --list\n' +
  '\n' +
  'Global options: --log-level=silent|error|warn|info|debug   --quiet   --json   --help\n' +
  'Profiles (from ccpatch.yml): minimal | standard | power | native\n' +
  '\n' +
  'revert/diff: reads the <patched>.ccp-revert.json sidecar produced at apply\n' +
  '             time. Only the JS bundle (.mjs/.js) is supported in v1 — Bun\n' +
  '             binary repack reversal is out of scope.\n' +
  '\n' +
  'Run `ccpatch <command> --help` for per-command usage.';

/**
 * Detect a per-subcommand --help and print it. Returns true if help was
 * handled (the caller should exit 0).
 */
export function maybePrintSubcommandHelp(args, logger = console) {
  if (!args.includes('--help') && !args.includes('-h')) return false;
  const cmd = args[0];
  if (cmd && Object.prototype.hasOwnProperty.call(HELP, cmd)) {
    logger.log(HELP[cmd]);
    return true;
  }
  // No subcommand or unknown subcommand: fall back to the global banner +
  // the build-mode help (build is the default invocation).
  logger.log(USAGE);
  if (!cmd || (!cmd.startsWith('--') && !Object.prototype.hasOwnProperty.call(HELP, cmd))) {
    logger.log('\n' + HELP.build);
  }
  return true;
}
