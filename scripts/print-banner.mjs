#!/usr/bin/env node
/**
 * scripts/print-banner.mjs — informational header for `make patch-claude-code`.
 *
 * Prints a responsive rounded box (shared renderer with the build/boot banners)
 * describing what ccpatch is, the handful of commands worth knowing, and the
 * safety caveats — emitted once at the very start of a build so the run is
 * self-documenting.
 *
 *   node scripts/print-banner.mjs [--version x.y.z] [--profile name]
 */

import { renderBanner } from '../runner/cli/banner.mjs';

function flag(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const version = flag('--version') || process.env.CCPATCH_CLI_VERSION || null;
const profile = flag('--profile') || process.env.PROFILE || 'standard';

const rows = [
  'Patches a local copy of Claude Code’s cli.js in place.',
  'No fork; ships no Anthropic code.',
  null,
  ['make patch-claude-code', 'apply patches → releases/<ver>/'],
  ['make start', 'run the patched CLI  (CLI_ARGS=…)'],
  ['make doctor', 'check anchor health (read-only)'],
  ['make patch-list', 'list available patches'],
  ['make clean', 'wipe releases/ + outputs (keeps archives)'],
  null,
  'Output is compact by default — add VERBOSE=1 for full per-patch detail.',
  null,
  '⚠ Unofficial — may break when Claude Code updates.',
  '⚠ --dangerously-skip-permissions skips all tool prompts.',
  '⚠ Review THREAT_MODEL.md before enabling network/env patches.',
];

const title = version ? `ccpatch v${version} · ${profile}` : `ccpatch · ${profile}`;
process.stdout.write('\n' + renderBanner({ title, rows, labelMax: 22, icon: '📦' }) + '\n\n');
