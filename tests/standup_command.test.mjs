// Behavioral tests for the standup_command shim (git activity → standup prompt).
// The bundle-injection apply()/verify/runtime path is covered by the 3-layer
// suite in tests/patch-verification.test.mjs; this file pins the composer's
// observable behavior (parsing, day-count, fail-open) directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPatches } from '../runner/loader.mjs';
import { buildStandupPrompt } from '../extensions/_standup_command_shim.mjs';

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
