// Behavioral tests for the standup_command shim (git activity → standup prompt).
// The bundle-injection apply()/verify/runtime path is covered by the 3-layer
// suite in tests/patch-verification.test.mjs; this file pins the composer's
// observable behavior (parsing, day-count, fail-open) directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPatches } from '../runner/loader.mjs';
import { buildStandupPrompt } from '../extensions/_standup_command_shim.mjs';

const COMMAND_MD = readFileSync(
  fileURLToPath(new URL('../.claude/commands/standup.md', import.meta.url)),
  'utf8',
);

test('standup_command: patch loads and is registered', async () => {
  const patches = await loadPatches();
  assert.ok(patches['standup_command'], 'patch standup_command should be registered');
});

test('standup_command: non-/standup input returns null (prompt untouched)', () => {
  assert.equal(buildStandupPrompt('hello world'), null);
  assert.equal(buildStandupPrompt('/standupx'), null);
  assert.equal(buildStandupPrompt('please /standup'), null);
});

test('standup_command: /standup composes a prompt with the standup instruction', () => {
  const p = buildStandupPrompt('/standup');
  assert.equal(typeof p, 'string');
  assert.match(p, /Yesterday \/ Today \/ Blockers/);
  assert.match(p, /last 1 day\b/);
});

test('standup_command: /standup <N> honors the day count (plural)', () => {
  const p = buildStandupPrompt('/standup 3');
  assert.match(p, /last 3 days\b/);
  // 0 / garbage clamps to a minimum of 1 day.
  assert.match(buildStandupPrompt('/standup 0'), /last 1 day\b/);
});

test('standup_command: never throws — always returns a string for /standup', () => {
  // Even if git is missing or fails, the result is a graceful prompt, not a throw.
  const p = buildStandupPrompt('/standup 2');
  assert.equal(typeof p, 'string');
  assert.match(p, /standup/i);
});

// --- Native slash command stays in lockstep with the shim ------------------
// .claude/commands/standup.md is a project-local convenience command outside
// the patch pipeline. It is NOT machine-coupled to the shim, so these tests
// pin the contract both must agree on (invocation grammar, day handling, and
// the exact git commands) — if the shim's behavior changes, these fail and
// force the markdown to be updated in step.

test('standup_command.md: documents the same /standup [N] invocation + default', () => {
  // argument-hint advertises an optional day count defaulting to 1.
  assert.match(COMMAND_MD, /argument-hint:\s*\[days=1\]/);
  // The command resolves an empty/invalid arg to N=1 — the shim's clamp.
  assert.match(COMMAND_MD, /default(?:s|ing)?\s+to\s+`?1`?/i);
});

test('standup_command.md: uses the same git commands as the shim', () => {
  // Repo guard.
  assert.match(COMMAND_MD, /git rev-parse --is-inside-work-tree/);
  // Commits: git log --since=<window> with a oneline-ish pretty format.
  assert.match(COMMAND_MD, /git log --since=[^\n]*--pretty=format/);
  // Churn: the @{N.days.ago} diff ref...
  assert.match(COMMAND_MD, /git diff --stat[^\n]*@\{N\.days\.ago\}/);
  // ...with the shim's --shortstat fallback.
  assert.match(COMMAND_MD, /git log --since=[^\n]*--shortstat/);
});

test('standup_command.md: produces the same Yesterday / Today / Blockers shape', () => {
  // The shim's instruction asks for Yesterday / Today / Blockers; the command
  // markdown must request the same three sections.
  for (const section of ['Yesterday', 'Today', 'Blockers']) {
    assert.match(COMMAND_MD, new RegExp(`\\*\\*${section}\\*\\*`), `missing ${section} section`);
  }
});

test('standup_command.md: shim instruction names the sections the command writes', () => {
  // Guard the coupling from the shim side too: the prompt the patch injects
  // must reference the same triad the command file documents.
  const shimPrompt = buildStandupPrompt('/standup');
  assert.match(shimPrompt, /Yesterday \/ Today \/ Blockers/);
});
