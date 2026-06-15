/**
 * tests/fixtures/registry.mjs
 *
 * Per-patch synthetic fixture registry — keyed by patch name.
 *
 * When tests/patch-verification.test.mjs runs without a real Claude Code
 * bundle, it falls back to these hand-written fixtures. Each entry exports
 * a function that returns a minimal code fragment containing the anchor(s)
 * the patch targets. Returning `null` means "no synthetic fixture available
 * — skip this patch when no real bundle is present".
 *
 * Scaffolder integration:
 *   bin/scaffold-patch.mjs appends a stub entry here whenever a new patch
 *   is created. The stub returns `null` by default; the author fills in a
 *   minimal anchor-bearing fragment so Layer 1/2 verification can run
 *   without a real bundle.
 *
 *   ── BEGIN FIXTURES (scaffolder appends below this marker) ──
 */

/** Standard shebang-prefixed body builder. */
export function shebang(body = '') {
  return `#!/usr/bin/env node\n${body}`;
}

/**
 * Minimal bundle fragment containing the message-stream anchor used by
 * loop_dynamic, plan_mode_interview, and similar stream-rewriting patches.
 */
export function streamAnchor() {
  // Matches the anchorRe used by message-stream patches.
  // Variable names must be single-char to match the regex \w+.
  return shebang(`
for await(let u of Z){if(u.message){if(yield u.message,u.message.type==="progress"&&u.message.toolUseID){v=u.message.toolUseID,n++
`);
}

// ── Registry ────────────────────────────────────────────────────────────────
//
// Map: patch name → () => string | null
//
// Patches absent from this map fall through to the heuristic default in the
// test runner. Returning `null` is an explicit "skip without real bundle".

export const FIXTURES = {
  // Stream-anchor patches — share one fixture.
  loop_dynamic: streamAnchor,
  plan_mode_interview: streamAnchor,
  // standup_command targets the React submit useCallback shape
  //   let <v>=<R>.useCallback(async(<a>)=>{await <inner>({helpers:{ ... )
  // Provide a minimal fragment carrying that exact anchor so Layer 1/2/3 run
  // without a real bundle. The callback body is trivial but paren-balanced so
  // the patch's paren-counter can find the matching close.
  standup_command: () =>
    shebang(
      'let Sx8=R8.useCallback(async(v$)=>{await Hi8({helpers:{x:1},queuedCommands:v$})},[a,b]);',
    ),
  // ── scaffold-patch.mjs inserts new entries here ──
};

/**
 * Pick the best fixture for a patch.
 *   1. explicit registry entry
 *   2. heuristic: stream-anchor for patches that reference 'for await' / 'toolUseID'
 *   3. plain shebang stub
 *
 * `readSrc` is a callback so the registry doesn't have to know how to read
 * patch files — the test runner injects it.
 */
export function pickFixture(name, readSrc) {
  if (Object.prototype.hasOwnProperty.call(FIXTURES, name)) {
    const fn = FIXTURES[name];
    return typeof fn === 'function' ? fn() : null;
  }
  const src = readSrc(name);
  if (src && (src.includes('for await') || src.includes('toolUseID'))) {
    return streamAnchor();
  }
  return shebang('/* stub */');
}
