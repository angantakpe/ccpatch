/**
 * boot-smoke.test.mjs
 *
 * Actually launches the patched binary in a subprocess to catch breakage
 * that slips past apply()/verify-string assertions: a patch can apply
 * cleanly, the verify string can be present, and the bundle can still
 * segfault on boot because (e.g.) a shim throws at module init.
 *
 * Runs `node <patched.js> --version`, asserts:
 *   - exit code 0
 *   - version line in stdout
 *   - no uncaught-exception markers in stderr
 *
 * Skips when no patched binary exists (run `make patch-claude-code` first).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const RELEASES = resolve(ROOT, 'releases');

/** Find the newest patched binary by directory mtime. */
function findPatchedBinary() {
  if (!existsSync(RELEASES)) return null;
  const versions = readdirSync(RELEASES)
    .map(v => ({ v, path: resolve(RELEASES, v) }))
    .filter(({ path }) => statSync(path).isDirectory())
    .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
  for (const { path } of versions) {
    const bin = readdirSync(path).find(f => /^cli\.v[\d.]+\.patched\.m?js$/.test(f));
    if (bin) return resolve(path, bin);
  }
  return null;
}

const BOOT_TIMEOUT_MS = 20_000;

/** Run the patched binary with the given args; return { code, stdout, stderr, timedOut }. */
function runPatched(binPath, args, timeoutMs = BOOT_TIMEOUT_MS) {
  return new Promise((resolveFn) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Patches read env vars; give them a clean slate so user config can't
      // skew results in CI.
      env: { ...process.env, CC_DISABLE_TELEMETRY: '1' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      clearTimeout(timer);
      resolveFn({ code, stdout, stderr, timedOut });
    });
  });
}

const binPath = findPatchedBinary();

/**
 * Run the headless integration script as a child. It exits:
 *   0 — agent loop + tool dispatch round-trip verified on a daemon bundle
 *   1 — assertion failure (real breakage)
 *   2 — environment skip (no daemon-profile bundle available)
 * Returns { code, stdout, stderr, timedOut }.
 */
function runScript(scriptPath, timeoutMs) {
  return new Promise((resolveFn) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => { clearTimeout(timer); resolveFn({ code, stdout, stderr, timedOut }); });
  });
}

test('boot — patched binary --version exits 0 and prints version', async (t) => {
  if (!binPath) {
    t.skip('no patched binary found in releases/ — run `make patch-claude-code` first');
    return;
  }
  t.diagnostic(`booting: ${binPath}`);

  const { code, stdout, stderr, timedOut } = await runPatched(binPath, ['--version']);

  assert.equal(timedOut, false, `boot exceeded ${BOOT_TIMEOUT_MS}ms — likely hung on init`);
  assert.equal(code, 0, `non-zero exit ${code}\nstderr:\n${stderr.slice(0, 2000)}`);
  // Claude Code prints "X.Y.Z (Claude Code)" — anchor on the parenthesized brand
  // to avoid false matches against e.g. Node's own version output.
  assert.match(stdout, /\d+\.\d+\.\d+ \(Claude Code\)/,
    `--version output didn't match expected pattern\nstdout:\n${stdout.slice(0, 500)}`);
});

test('boot — no uncaught-exception markers in stderr during init', async (t) => {
  if (!binPath) {
    t.skip('no patched binary found in releases/');
    return;
  }

  const { stderr } = await runPatched(binPath, ['--version']);

  // Patches log status lines like "[bun_shim] ..." to stderr — that's fine.
  // What we don't want: V8 uncaught-exception frames or "ReferenceError: X is
  // not defined" at module-init time (a hallmark of a shim that referenced a
  // missing global).
  const fatalPatterns = [
    /UnhandledPromiseRejection/,
    /uncaught(?:\s+exception)?/i,
    /ReferenceError:[^\n]*is not defined/,
    /SyntaxError:/,
    /TypeError:[^\n]*Cannot (?:read|destructure) properties? of (?:undefined|null)/,
  ];
  for (const pat of fatalPatterns) {
    assert.ok(
      !pat.test(stderr),
      `stderr matched fatal pattern ${pat}\nstderr:\n${stderr.slice(0, 2000)}`,
    );
  }
});

// ── Headless agent-loop + tool-dispatch round-trip ──────────────────────────
// `--version` exits before the agent loop, tool dispatch, API client, or bridge
// ever initialize, so the boots above prove only that init doesn't throw. This
// tier drives the REAL running CLI on a daemon-profile bundle with a stubbed
// Anthropic API (no network, no credentials): it must boot, issue a query,
// dispatch a tool, feed the result back, and exit clean — so "tests pass" means
// "the patched CLI actually runs," not just "it prints its version."
//
// Delegated to tests/integration_roundtrip.mjs (also runnable via
// `npm run test:integration` / `make smoke-integration-roundtrip`). It skips
// (exit 2) when no daemon-profile bundle is present, which is the common case
// for the fast suite — build one with `make patch-daemon` to exercise it.
const INTEGRATION_TIMEOUT_MS = 150_000;
const integrationScript = resolve(__dirname, 'integration_roundtrip.mjs');

test('boot — agent loop + tool dispatch round-trip on daemon bundle (stubbed API)', async (t) => {
  if (!existsSync(integrationScript)) {
    t.skip('integration_roundtrip.mjs not found');
    return;
  }
  const { code, stdout, stderr, timedOut } = await runScript(integrationScript, INTEGRATION_TIMEOUT_MS);

  assert.equal(timedOut, false, `integration round-trip exceeded ${INTEGRATION_TIMEOUT_MS}ms\nstdout:\n${stdout.slice(0, 1000)}\nstderr:\n${stderr.slice(0, 2000)}`);
  if (code === 2) {
    // No daemon-profile bundle available — clean skip, like the --version tier.
    t.skip((stderr.match(/INTEGRATION SKIP:[^\n]*/) || ['no daemon bundle'])[0]);
    return;
  }
  assert.equal(code, 0, `integration round-trip failed (exit ${code})\nstdout:\n${stdout.slice(0, 1000)}\nstderr:\n${stderr.slice(0, 3000)}`);
  assert.match(stdout, /ran the agent loop \+ dispatched a tool/, `unexpected success output:\n${stdout.slice(0, 1000)}`);
});
