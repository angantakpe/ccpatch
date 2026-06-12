// Per-subcommand help text. Centralized here so each subcommand owns its own
// usage block and the top-level cli.mjs stays small. Keep entries
// alphabetically sorted by command name.
//
// Each value is the full block that should be printed for
// `ccpatch <cmd> --help`. The top-level USAGE composes one-line excerpts for
// the bare `ccpatch --help` listing.

export const HELP = Object.freeze({
  ack:
    'Usage: ccpatch ack <patch> [--all-caps] [--dry-run]\n' +
    '\n' +
    'Show the THREAT_MODEL.md row and declared capabilities for a patch, then\n' +
    'write (or update) its `ack:` entry in ccpatch.yml. Acknowledging confirms\n' +
    'you have read the threat model for the capabilities the patch claims.\n' +
    '\n' +
    'By default only the acknowledgement-required capabilities (network / exec /\n' +
    'env) are written — these are the ones the default-strict build gate checks.\n' +
    '\n' +
    'Options:\n' +
    '  --all-caps   Acknowledge every declared capability, not just network/exec/env\n' +
    '  --dry-run    Print what would be written without modifying ccpatch.yml',

  build:
    'Usage: ccpatch <input.js> <output.js> [options]\n' +
    '\n' +
    'Apply enabled patches from ccpatch.yml (or --patch / --profile) to an\n' +
    'unminified Claude Code bundle and write the patched output.\n' +
    '\n' +
    'Options:\n' +
    '  --patch <name[,name…]>   Apply just this patch (repeatable; comma-separated list ok). "all" = every patch.\n' +
    '                           Required infra patches are auto-included unless --no-required is set.\n' +
    '  --profile <name>         Profile from ccpatch.yml: bare | minimal | standard | power | native\n' +
    '  --no-required            With an explicit --patch list: do NOT auto-include required:true\n' +
    '                           infra patches (bisection floor — prints a LOUD warning; skipped\n' +
    '                           infra means subscriber-based patches silently no-op). See docs/BISECTING.md.\n' +
    '  --preload <path.mjs>     Emit a Node --require preload helper to this path\n' +
    '  --strict                 Fail on weak verify, anchor drift, or unacked caps\n' +
    '  --dry-run                Print the unified diff + shadow report, don\'t write\n' +
    '                           (diff skipped when stdout is not a TTY; use --output-diff to force)\n' +
    '  --output-diff            With --dry-run: always emit the unified diff even when stdout is piped\n' +
    '  --write-on-clean         With --dry-run: write only if shadow report is clean\n' +
    '  --no-fallback            Skip fallback diff application on anchor miss\n' +
    '  --best-effort            Downgrade verify.present no-ops from fatal to warn (env: CCPATCH_BEST_EFFORT=1)\n' +
    '  --dev                    Emit hot-reload shim layout under ccpatch-overlay-shims/\n' +
    '  --version <x.y.z>        Pin to a specific Claude Code release\n' +
    '  --model <id>             Override default model for patches that consult it\n' +
    '  --allow-capabilities <l> Comma-list, "all", or "none". Acks high-risk caps.\n' +
    '  --allow-unacked          Warn-instead-of-fail for unacked network/exec/env caps\n' +
    '  --json                   Emit a single JSON build report to stdout\n' +
    '  --log-level <lvl>        silent | error | warn | info | debug (default: info)\n' +
    '  --quiet                  Alias for --log-level=error\n' +
    '  --verbose, -v            Full detail: per-patch + per-shim sub-chatter\n' +
    '                           (alias for --log-level=debug; default is compact)\n' +
    '  --help                   Show this message\n' +
    '\n' +
    'Profiles: --profile=native auto-excludes esm_compat + bun_shim so the\n' +
    'output can be repacked into a Bun single-executable. --profile=bare is the\n' +
    'bisection floor (react_singleton + esm_compat + bun_shim only — boots under\n' +
    'Node but skips ALL required infra; see docs/BISECTING.md).',

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

  dissect:
    'Usage: ccpatch dissect <cli.js> [--against <other.js>] [--native]\n' +
    '                       [--ownership] [--context <N>] [--cc-version X.Y.Z] [--json]\n' +
    '\n' +
    'Read-only structural analysis of an UNPATCHED bundle: every registry anchor\n' +
    'with its resolved symbol, byte offset, line, and status. Shares the\n' +
    'analyzeBundle() model that `refmap` projects from, so the two cannot drift.\n' +
    '\n' +
    'Modes (all read-only):\n' +
    '  (default)           anchor table (symbol / offset:line / status)\n' +
    '  --context <N>       capture ±N chars of source around each resolved anchor\n' +
    '  --ownership         join each anchor to its owning patch and core/ext shim;\n' +
    '                      flags orphan anchors no patch references\n' +
    '  --against <old.js>  cross-version diff: stable/moved/renamed/vanished/\n' +
    '                      appeared per anchor (exit 3 if any moved/renamed/vanished)\n' +
    '  --native            decode a Bun-compiled `claude` binary: extract the cli.js\n' +
    '                      module from the SEA graph, then run the anchor pass on it\n' +
    '  --json              machine-readable output for any of the above',

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

  explain:
    'Usage: ccpatch explain [--profile <name>] [--patch <name>] [--no-required] [--json]\n' +
    '\n' +
    'Print the FINAL resolved patch set and, for every known patch, WHY it is\n' +
    'in or out (e.g. "in: profile=standard", "in: required infra",\n' +
    '"out: disabled in ccpatch.yml", "out: not in profile", "excluded:\n' +
    'native-incompatible"). Uses the SAME resolution the default build path\n' +
    'applies, so it never drifts from what `ccpatch <in> <out>` would select.\n' +
    '\n' +
    'Options:\n' +
    '  --profile <name>  Resolve as if building with this profile from ccpatch.yml\n' +
    '  --patch <name>    Resolve an explicit --patch list (repeatable, bypasses YAML)\n' +
    '  --no-required     With --patch: skip the required-infra auto-include (mirrors\n' +
    '                    the build flag; see docs/BISECTING.md)\n' +
    '  --json            Emit the resolution as JSON instead of a table',

  'fallback-capture':
    'Usage: ccpatch fallback-capture <patched.js> --against <unpatched.js> [--patch <name>]\n' +
    '\n' +
    'Print a unified diff suitable for a patch module\'s fallbackDiff.patch field.',

  heal:
    'Usage: ccpatch heal [--write] [--drift <path>] [--anchors <path>]\n' +
    '\n' +
    'Read storage/outputs/anchor-drift.jsonl, group by patch, take the top-\n' +
    'scoring candidate per drifted anchor, and propose a rewritten\n' +
    'runner/anchors.mjs registry entry as a unified diff on stdout.\n' +
    '\n' +
    'Options:\n' +
    '  --write           Apply the proposed registry edits in place\n' +
    '  --drift <path>    Override the anchor-drift.jsonl source\n' +
    '  --anchors <path>  Override the runner/anchors.mjs target',

  outputs:
    'Usage: ccpatch outputs clear [--force] [--rotate <KB>]\n' +
    '\n' +
    'Inspect and manage the JSONL/JSON files written to storage/outputs/ by\n' +
    'the runner, doctor, and CI drift sweep.\n' +
    '\n' +
    'Without --force: lists files and their sizes, then exits 0.\n' +
    '\n' +
    'Options:\n' +
    '  --force          Delete (or rotate) the listed files.\n' +
    '  --rotate <KB>    Keep only the last KB kilobytes per file instead of\n' +
    '                   deleting. For JSONL files: oldest lines are dropped\n' +
    '                   until the retained content fits. For plain JSON files\n' +
    '                   that exceed the limit: deleted (no line-level trim).',

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
  '  node patch-cli.mjs <input.js> <output.js> [--patch <name>] [--no-required] [--profile <name>] [--preload <preload.mjs>] [--strict] [--paranoid] [--allow-unverified] [--dry-run] [--write-on-clean] [--allow-capabilities <list>] [--allow-unacked] [--dev]\n' +
  '  node patch-cli.mjs watch <input.js> <output.js> [--patch <name>] [--profile <name>] [--debounce <ms>]\n' +
  '  node patch-cli.mjs doctor <input.js> [--profile <name>] [--strict] [--suggest]\n' +
  '  node patch-cli.mjs heal [--write] [--drift <path>] [--anchors <path>]\n' +
  '  node patch-cli.mjs revert <patched.js> [--output <restored.js>]\n' +
  '  node patch-cli.mjs diff <patched.js>\n' +
  '  node patch-cli.mjs repl <patched.js>\n' +
  '  node patch-cli.mjs versions [--target-version <x.y.z>]\n' +
  '  node patch-cli.mjs capabilities [--profile <name>] [--json]\n' +
  '  node patch-cli.mjs explain [--profile <name>] [--patch <name>] [--no-required] [--json]\n' +
  '  node patch-cli.mjs dissect <cli.js> [--against <other.js>] [--native] [--ownership] [--context <N>] [--json]\n' +
  '  node patch-cli.mjs ack <patch> [--all-caps] [--dry-run]\n' +
  '  node patch-cli.mjs refmap <bundle.js> [--out <path>] [--cc-version X.Y.Z] [--check]\n' +
  '  node patch-cli.mjs fallback-capture <patched.js> --against <unpatched.js> [--patch <name>]\n' +
  '  node patch-cli.mjs coverage <patched.js> [--smoke <cmd>] [--out <report.json>] [--cc-version X.Y.Z]\n' +
  '  node patch-cli.mjs module install <path-or-url> [--strict] [--allow-capabilities <list>] [--force]\n' +
  '  node patch-cli.mjs module list\n' +
  '  node patch-cli.mjs module remove <name>\n' +
  '  node patch-cli.mjs module verify <name>\n' +
  '  node patch-cli.mjs module update <name>\n' +
  '  node patch-cli.mjs outputs clear [--force] [--rotate <KB>]\n' +
  '  node patch-cli.mjs --list [--verbose]   (catalog of ALL patches; --verbose groups by category, adds capabilities + required/disabled tags)\n' +
  '  node patch-cli.mjs --applied --version <ver>   (only patches that applied to the last build of <ver>, grouped by category)\n' +
  '\n' +
  'Global options: --log-level=silent|error|warn|info|debug   --quiet   --verbose   --json   --help\n' +
  '  --paranoid          Strict mode: surface normally-swallowed fetch-subscriber errors loudly\n' +
  '                      (sets CCPATCH_PARANOID=1) and force fail-closed native repack (any\n' +
  '                      grow-path degradation becomes a hard build failure).\n' +
  '  --allow-unverified  Opt OUT of the fail-closed native repack default (local dev only):\n' +
  '                      a missing post-repack smoke check or Bun-version drift warns instead\n' +
  '                      of failing. Ignored under --paranoid.\n' +
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
