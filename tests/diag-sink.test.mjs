/**
 * diag-sink.test.mjs
 *
 * Unit tests for the always-on diagnostics sink installed by the boot_banner
 * shim (runner/shims/boot-banner-v1.js.txt):
 *
 *   - __ccpDiag(tag, msg) appends one-line records to
 *     $CCPATCH_DIAG_DIR/runtime.log (or ~/.ccpatch/diagnostics/runtime.log)
 *   - ~1MB size guard rotates runtime.log → runtime.log.1
 *   - the early 'unhandledRejection' listener is LOG-ONLY and preserves
 *     Node's default semantics:
 *       * sole listener  → process still crashes (rethrow), exit != 0
 *       * other listener → that listener decides, no crash from us
 *   - 'uncaughtExceptionMonitor' logs without altering crash semantics
 *
 * Each case runs the real shim payload in a child process (written to a tmp
 * .cjs file) so process-level listeners are tested in isolation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIM = readFileSync(resolve(__dirname, '..', 'runner', 'shims', 'boot-banner-v1.js.txt'), 'utf8');

/** Write shim+driver to a tmp .cjs and run it; returns { status, stdout, stderr, dir }. */
function runChild(driver, env = {}, { keepDir = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-diag-'));
  const script = join(dir, 'driver.cjs');
  writeFileSync(script, SHIM + '\n' + driver);
  const res = spawnSync(process.execPath, [script], {
    env: { ...process.env, CCPATCH_NO_WATCHDOG: '1', CCPATCH_DIAG_DIR: dir, ...env },
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (!keepDir) {
    // Caller reads files before cleanup via the returned dir; defer rm to caller.
  }
  return { ...res, dir, logPath: join(env.CCPATCH_DIAG_DIR ?? dir, 'runtime.log') };
}

test('diag sink — __ccpDiag appends a one-line record to $CCPATCH_DIAG_DIR/runtime.log', () => {
  const r = runChild(`globalThis.__ccpDiag('test-tag', 'hello\\nmulti  line');`);
  try {
    assert.equal(r.status, 0, `child failed\nstderr: ${r.stderr}`);
    assert.ok(existsSync(r.logPath), 'runtime.log must be created');
    const log = readFileSync(r.logPath, 'utf8');
    const lines = log.trim().split('\n');
    assert.equal(lines.length, 1, 'one call → one line');
    assert.match(lines[0], /\[test-tag\] pid=\d+ hello \| multi  line$/);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T/, 'line starts with an ISO timestamp');
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('diag sink — defaults to ~/.ccpatch/diagnostics/runtime.log when CCPATCH_DIAG_DIR is unset', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ccp-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'ccp-diag-'));
  const script = join(dir, 'driver.cjs');
  writeFileSync(script, SHIM + `\nglobalThis.__ccpDiag('home', 'default location');`);
  const env = { ...process.env, CCPATCH_NO_WATCHDOG: '1', HOME: fakeHome, USERPROFILE: fakeHome };
  delete env.CCPATCH_DIAG_DIR;
  const res = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 15_000 });
  try {
    assert.equal(res.status, 0, `child failed\nstderr: ${res.stderr}`);
    const expected = join(fakeHome, '.ccpatch', 'diagnostics', 'runtime.log');
    assert.ok(existsSync(expected), `expected log at ${expected}`);
    assert.match(readFileSync(expected, 'utf8'), /\[home\] pid=\d+ default location/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('diag sink — rotates runtime.log to runtime.log.1 past ~1MB', () => {
  const diagDir = mkdtempSync(join(tmpdir(), 'ccp-rot-'));
  mkdirSync(diagDir, { recursive: true });
  const logPath = join(diagDir, 'runtime.log');
  writeFileSync(logPath, 'x'.repeat(1024 * 1024 + 64)); // over the guard
  const r = runChild(`globalThis.__ccpDiag('rot', 'after rotation');`, { CCPATCH_DIAG_DIR: diagDir });
  try {
    assert.equal(r.status, 0, `child failed\nstderr: ${r.stderr}`);
    assert.ok(existsSync(logPath + '.1'), 'oversized log must rotate to runtime.log.1');
    assert.ok(statSync(logPath + '.1').size > 1024 * 1024, 'rotated file carries the old content');
    const fresh = readFileSync(logPath, 'utf8');
    assert.ok(statSync(logPath).size < 4096, 'fresh log starts small');
    assert.match(fresh, /\[rot\] pid=\d+ after rotation/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
    rmSync(diagDir, { recursive: true, force: true });
  }
});

test('diag sink — sink failure is silent (unwritable dir does not throw)', () => {
  // A regular FILE used as the diag dir → mkdir/append fail fast with ENOTDIR.
  // (Avoid /proc paths: procfs writes can hang under WSL2.)
  const blocker = mkdtempSync(join(tmpdir(), 'ccp-block-'));
  const blockFile = join(blocker, 'not-a-dir');
  writeFileSync(blockFile, '');
  const r = runChild(
    `globalThis.__ccpDiag('nope', 'dropped'); process.stdout.write('alive');`,
    { CCPATCH_DIAG_DIR: join(blockFile, 'sub') },
  );
  try {
    assert.equal(r.status, 0, `child must not crash on sink failure\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /alive/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
    rmSync(blocker, { recursive: true, force: true });
  }
});

test('rejection observer — sole listener preserves the default crash (exit != 0) and logs the record', () => {
  const r = runChild(`
    Promise.reject(new Error('boom-sole'));
    setTimeout(() => { process.stdout.write('should-not-survive'); }, 500);
  `);
  try {
    assert.notEqual(r.status, 0, 'process must still crash like default Node');
    assert.ok(!r.stdout.includes('should-not-survive'), 'crash must happen before the keepalive fires');
    assert.match(r.stderr, /boom-sole/, 'the error must be visible on stderr');
    const log = readFileSync(r.logPath, 'utf8');
    assert.match(log, /\[unhandled-rejection\] pid=\d+ .*boom-sole/);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('rejection observer — defers to another listener (bundle handler) without altering its outcome', () => {
  const r = runChild(`
    process.on('unhandledRejection', () => { process.stdout.write('bundle-handled'); });
    Promise.reject(new Error('boom-deferred'));
    setTimeout(() => { process.stdout.write(' survived'); }, 300);
  `);
  try {
    assert.equal(r.status, 0, `bundle handler decides — no crash from us\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /bundle-handled survived/);
    const log = readFileSync(r.logPath, 'utf8');
    assert.match(log, /\[unhandled-rejection\] pid=\d+ .*boom-deferred/, 'still logged');
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('rejection observer — CCPATCH_PARANOID=1 also prints to stderr (loud contract preserved)', () => {
  const r = runChild(`
    process.on('unhandledRejection', () => {}); // keep the child alive
    Promise.reject(new Error('boom-loud'));
    setTimeout(() => {}, 200);
  `, { CCPATCH_PARANOID: '1' });
  try {
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /\[ccp:diag\]\[paranoid\] unhandledRejection: .*boom-loud/);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('exception observer — uncaughtExceptionMonitor logs without preventing the crash', () => {
  const r = runChild(`
    setTimeout(() => { throw new Error('kaboom-monitor'); }, 10);
    setTimeout(() => { process.stdout.write('should-not-survive'); }, 500);
  `);
  try {
    assert.notEqual(r.status, 0, 'monitor must not suppress the crash');
    assert.ok(!r.stdout.includes('should-not-survive'));
    assert.match(r.stderr, /kaboom-monitor/);
    const log = readFileSync(r.logPath, 'utf8');
    assert.match(log, /\[uncaught-exception\] pid=\d+ .*kaboom-monitor/);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('diag sink — idempotent: shim evaluated twice installs one listener set, logs once per call', () => {
  const r = runChild(SHIM + `
    globalThis.__ccpDiag('twice', 'only once');
    process.stdout.write('listeners=' + process.listenerCount('unhandledRejection'));
  `);
  try {
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /listeners=1/, 'second evaluation must not add a second listener');
    const log = readFileSync(r.logPath, 'utf8');
    assert.equal(log.trim().split('\n').length, 1);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});
