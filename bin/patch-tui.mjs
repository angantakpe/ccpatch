#!/usr/bin/env node
// ccpatch TUI — interactive dashboard for patch state, capability acks, and drift.
//
// Usage:
//   node bin/patch-tui.mjs            # launch the TUI (requires a real terminal)
//   node bin/patch-tui.mjs --help     # print usage and exit
//
// Read-only: this tool never mutates ccpatch.yml or any patch files. It loads
// patches via runner/loader.mjs, reads enabled/ack maps via runner/config.mjs,
// and tails storage/outputs/anchor-drift.jsonl for the latest drift per patch.
//
// Keybindings:
//   ↑/↓ (or j/k)  move selection
//   Enter         toggle expanded JSON view for selected patch
//   f             cycle filter (all → enabled → disabled → drifted → acked → unacked)
//   r             reload patches, flags, acks, and drift log
//   q (or Ctrl+C) quit

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    [
      'ccpatch TUI — patch dashboard',
      '',
      'Usage:',
      '  node bin/patch-tui.mjs            launch the TUI',
      '  node bin/patch-tui.mjs --help     print this help',
      '',
      'Keybindings:',
      '  up/down (j/k)  select   Enter  expand   f  filter   r  reload   q  quit',
      '',
      'Data sources:',
      '  - core/ and extensions/ patches loaded via runner/loader.mjs',
      '  - enabled/ack maps from ccpatch.yml in cwd',
      '  - storage/outputs/anchor-drift.jsonl for latest drift per patch',
      '',
    ].join('\n')
  );
  process.exit(0);
}

if (!process.stdout.isTTY) {
  process.stderr.write(
    'ccpatch TUI: stdout is not a TTY — the TUI requires an interactive terminal.\n' +
      'Run from a real terminal, or use `node bin/patch-tui.mjs --help`.\n'
  );
  process.exit(2);
}

const [{ render }, React, { App }] = await Promise.all([
  import('ink'),
  import('react'),
  import('../runner/tui/App.mjs'),
]);

const h = React.default.createElement;
const { waitUntilExit } = render(h(App));
await waitUntilExit();
