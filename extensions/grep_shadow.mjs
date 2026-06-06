import { ccpLog } from '../runner/cli/style.mjs';

export default {
  category: 'fix',

  description: 'Disable Claude Code grep/find shadow injection — prevents ugrep flag incompatibility in agent bash subshells',
  capabilities: [],
  verify: { absent: '"--ignore-files"' },
  apply: (code) => {
    // Claude Code writes a grep shell function into every bash snapshot that reroutes
    // grep calls through the claude binary as "ugrep" with flags like -G, --ignore-files,
    // --hidden, -I, --exclude-dir=... These flags are ugrep-native and cause:
    //   ugrep: bad option: -G
    //   ugrep: bad option: --ignore-files
    // when the real ugrep binary is present and picks up these args differently, or when
    // any subprocess reads the injected shell function via the snapshot.
    //
    // Fix: make PN_() (the function that generates the grep/find shadow snippet) return null,
    // which causes ZN_() to skip the entire "Shadow find/grep with embedded bfs/ugrep" block.
    //
    // Anchor: xJ6("grep","ugrep",["-G","--ignore-files" — appears exactly once in the bundle.
    // The function starts with: function {name}(){if(!gX())return null;return["unalias find...
    // We match the return statement up to the unique --ignore-files string and replace the
    // entire return body with `return null`.
    //
    // We leave the function declaration intact (minified name is fine — PN_() is the only
    // caller site, via `let A=PN_()` in ZN_(), which already handles null).

    const anchor = /"--ignore-files"/;
    if (!anchor.test(code)) {
      console.warn('  [!] grep_shadow: anchor "--ignore-files" not found — skipping');
      return code;
    }

    // The function that generates grep/find shell shadows has this structure:
    //   function PN_(){if(!gX())return null;return["unalias find ...","unalias grep ...",
    //     xJ6("find","bfs",[...]),xJ6("grep","ugrep",["-G","--ignore-files",...])]
    //     .join(`\n`)}
    //
    // The .join() call spans two lines (template literal with a real newline inside).
    // We match the return array starting at "unalias find" through the .join close.
    // [\s\S]*? is used to safely cross the line boundary inside the template literal.
    //
    // The result: the function now returns null unconditionally, so ZN_() skips
    // the "Shadow find/grep with embedded bfs/ugrep" block entirely.
    const returnPattern = /return\["unalias find[^"]*","unalias grep[^"]*",\w+\([\s\S]*?"--ignore-files"[\s\S]*?\]\.join\(`[\s\S]*?`\)/;
    const match = code.match(returnPattern);
    if (!match) {
      console.warn('  [!] grep_shadow: return pattern not matched — skipping');
      return code;
    }

    const patched = code.replace(match[0], 'return null');
    ccpLog('  [grep_shadow] PN_() patched to return null — grep/find shadow injection disabled');
    return patched;
  },
};
