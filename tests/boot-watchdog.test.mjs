/**
 * boot-watchdog.test.mjs
 *
 * Unit tests for the boot watchdog beacon installed by the boot_banner shim
 * (runner/shims/boot-banner-v1.js.txt). The watchdog arms an unref'd one-shot
 * timer; if cumulative stdout bytes stay under the render threshold when it
 * fires, ONE diagnostic block is written to stderr.
 *
 * Test hooks exercised here:
 *   CCPATCH_WATCHDOG_FORCE=1     — bypass the TTY/argv interactivity gate
 *   CCPATCH_WATCHDOG_MS          — shrink the 15s delay for tests
 *   CCPATCH_WATCHDOG_THRESHOLD   — render-byte threshold (default 512)
 *   CCPATCH_NO_WATCHDOG=1        — opt out entirely
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIM = readFileSync(resolve(__dirname, '..', 'runner', 'shims', 'boot-banner-v1.js.txt'), 'utf8');

const BEACON = /\[ccpatch\] boot watchdog: still no substantive UI output/;

function runChild(driver, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-wd-'));
  const script = join(dir, 'driver.cjs');
  writeFileSync(script, SHIM + '\n' + driver);
  // The watchdog hint reports the live CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN
  // value, and the suite itself may run inside a Claude Code session that
  // exports it — strip it from the inherited env so the "<unset>" assertion
  // holds everywhere; tests that care set it explicitly via `env`.
  const baseEnv = { ...process.env, CCPATCH_DIAG_DIR: dir };
  delete baseEnv.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN;
  const res = spawnSync(process.execPath, [script], {
    env: { ...baseEnv, ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { ...res, dir, logPath: join(dir, 'runtime.log') };
}

test('watchdog — fires one beacon when stdout stays under the threshold (simulated hang)', () => {
  const r = runChild(
    `setTimeout(() => {}, 1200); // simulate a hung boot that holds the loop open`,
    { CCPATCH_WATCHDOG_FORCE: '1', CCPATCH_WATCHDOG_MS: '300' },
  );
  try {
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stderr, BEACON);
    assert.match(r.stderr, /stdout bytes since boot: \d+ \(render threshold: 512\)/);
    assert.match(r.stderr, /active handles: /);
    assert.match(r.stderr, /active requests: /);
    assert.match(r.stderr, /child processes: \d+/);
    assert.match(r.stderr, /running under Node: fullscreen TUI unavailable — CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN should be set \(currently: <unset>\)/);
    assert.match(r.stderr, /CCPATCH_PARANOID=1/);
    assert.match(r.stderr, /CCPATCH_NO_WATCHDOG=1/);
    // Note: modern Node does not surface individual timers in
    // _getActiveHandles, so the tally only lists Socket/ChildProcess/etc.
    // Exactly ONE beacon.
    assert.equal((r.stderr.match(/boot watchdog: still no substantive/g) || []).length, 1);
    // The beacon is also recorded in the diagnostics log.
    assert.match(readFileSync(r.logPath, 'utf8'), /\[watchdog\] pid=\d+ beacon fired: stdout bytes=\d+/);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('watchdog — reports the current CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN value in the hint', () => {
  const r = runChild(
    `setTimeout(() => {}, 900);`,
    { CCPATCH_WATCHDOG_FORCE: '1', CCPATCH_WATCHDOG_MS: '300', CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '0' },
  );
  try {
    assert.match(r.stderr, /CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN should be set \(currently: "0"\)/);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('watchdog — does not prescribe CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN when it is already enabling', () => {
  // Regression: the hint used to read "should be set (currently: \"1\")",
  // telling the user to set what was already set. When the var is already
  // enabling ("1"/"true"), the hint must report state, not prescribe it.
  for (const val of ['1', 'true', 'TRUE']) {
    const r = runChild(
      `setTimeout(() => {}, 900);`,
      { CCPATCH_WATCHDOG_FORCE: '1', CCPATCH_WATCHDOG_MS: '300', CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: val },
    );
    try {
      assert.match(r.stderr, BEACON, `beacon should still fire (forced)\nstderr: ${r.stderr}`);
      assert.ok(!/should be set/.test(r.stderr),
        `must not prescribe an already-set var (val=${val})\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /alt-screen already disabled; a static single-frame render is normal/);
      assert.match(r.stderr, new RegExp(`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=${JSON.stringify(val)}`));
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  }
});

test('watchdog — stays silent when stdout crosses the threshold (healthy render)', () => {
  const r = runChild(`
    // A healthy interactive boot paints frames well past 4KB.
    process.stdout.write('F'.repeat(8192));
    setTimeout(() => { process.stdout.write('END'); }, 900);
  `, { CCPATCH_WATCHDOG_FORCE: '1', CCPATCH_WATCHDOG_MS: '300' });
  try {
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!BEACON.test(r.stderr), `beacon must not fire on a healthy render\nstderr: ${r.stderr}`);
    // Passthrough integrity: every byte written reached the parent.
    assert.equal(r.stdout, 'F'.repeat(8192) + 'END');
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('watchdog — restores process.stdout.write once the threshold is crossed', () => {
  const r = runChild(`
    const wrappedRef = process.stdout.write; // wrap installed by the shim above
    process.stdout.write('F'.repeat(8192));  // cross the threshold → stand down
    setImmediate(() => {
      process.stdout.write('|restored=' + (process.stdout.write !== wrappedRef));
    });
  `, { CCPATCH_WATCHDOG_FORCE: '1', CCPATCH_WATCHDOG_MS: '5000' });
  try {
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /\|restored=true/);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('watchdog — CCPATCH_NO_WATCHDOG=1 opts out entirely', () => {
  const r = runChild(
    `setTimeout(() => {}, 900);`,
    { CCPATCH_WATCHDOG_FORCE: '1', CCPATCH_WATCHDOG_MS: '300', CCPATCH_NO_WATCHDOG: '1' },
  );
  try {
    assert.equal(r.status, 0);
    assert.ok(!BEACON.test(r.stderr), `opt-out must suppress the beacon\nstderr: ${r.stderr}`);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('watchdog — timer is unref\'d: never keeps a finished process alive', () => {
  const started = Date.now();
  const r = runChild(
    `/* exit immediately — the armed 10s timer must not hold the loop */`,
    { CCPATCH_WATCHDOG_FORCE: '1', CCPATCH_WATCHDOG_MS: '10000' },
  );
  const elapsed = Date.now() - started;
  try {
    assert.equal(r.status, 0);
    assert.ok(elapsed < 5_000, `process should exit immediately, took ${elapsed}ms`);
    assert.ok(!BEACON.test(r.stderr));
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('watchdog — does not arm for non-interactive runs (piped stdout, no force)', () => {
  // stdout is a pipe under spawnSync → !isTTY → the gate must refuse to arm
  // even though the run is "hung" longer than the timer.
  const r = runChild(
    `setTimeout(() => {}, 900);`,
    { CCPATCH_WATCHDOG_MS: '300' },
  );
  try {
    assert.equal(r.status, 0);
    assert.ok(!BEACON.test(r.stderr), `non-TTY stdout must not arm the watchdog\nstderr: ${r.stderr}`);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});
