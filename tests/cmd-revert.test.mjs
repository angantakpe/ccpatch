// tests/cmd-revert.test.mjs — end-to-end tests for the `ccpatch revert` command
// WIRING (runner/cli/cmd-revert.mjs). The reverse-diff splice math is unit-tested
// in tests/reversible.test.mjs; here we exercise the command end-to-end against a
// sidecar produced by a real `runBuild --emit-revert`, plus its error paths.
//
// Coverage:
//   - command-table parse() for `revert` (input + --output, missing-arg error)
//   - revert restores the byte-exact original from a build's .ccp-revert.json
//   - revert refuses a binary target (.exe) and a missing-sidecar input
//   - revert errors when the patched file does not exist

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { runRevert } from '../runner/cli/cmd-revert.mjs';
import { runBuild } from '../runner/cli/cmd-build.mjs';
import { buildCommandTable } from '../runner/cli/commands.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

function captureLogger() {
  const lines = [];
  const errs = [];
  return {
    lines, errs,
    log: (...a) => lines.push(a.join(' ')),
    warn: (...a) => lines.push('WARN ' + a.join(' ')),
    error: (...a) => errs.push(a.join(' ')),
    debug: () => {},
  };
}
function err(l) { return l.errs.join('\n'); }
function sha256(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }

const SENTINEL = '__ccp_revert_sentinel__';
const BUNDLE = '#!/usr/bin/env node\nvar head=1;\nvar middle=2;\nvar tail=3;\n';

function sentinelPatch() {
  return {
    description: 'insert a unique sentinel, strongly verified',
    capabilities: [],
    verify: { present: SENTINEL, count: { present: 1 } },
    apply: (code) => code.includes(SENTINEL)
      ? code
      : code.replace('var head=1;', `var head=1;/*${SENTINEL}*/`),
  };
}

let cwdGuard, scratchCwd;
before(() => {
  cwdGuard = process.cwd();
  scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-revert-cwd-'));
  process.chdir(scratchCwd);
});
after(() => { process.chdir(cwdGuard); });

// Produce a patched bundle + its reverse-diff sidecar via the real build path.
async function buildPatched() {
  const dir = fs.mkdtempSync(path.join(scratchCwd, 'proj-'));
  const inputPath = path.join(dir, 'cli.js');
  const outputPath = path.join(dir, 'cli.patched.js');
  fs.writeFileSync(inputPath, BUNDLE, 'utf8');
  const rc = await runBuild({
    options: {
      inputPath, outputPath, requestedPatches: ['sentinel'], profile: null,
      patchOptions: { emitRevert: true },
    },
    patches: { sentinel: sentinelPatch() },
    logger: captureLogger(),
  });
  assert.equal(rc, 0, 'fixture build must succeed');
  return { dir, inputPath, outputPath };
}

// ── command-table parse() ─────────────────────────────────────────────────────

describe('commands table — revert parse()', () => {
  const { byName } = buildCommandTable({
    parseBuild: () => ({}), runBuild: () => 0, runRevert: () => 0, runDiff: () => 0,
    runReplCommand: () => 0, runVersions: () => 0, runRefmap: () => 0,
    runFallbackCapture: () => 0, runWatch: () => 0, runCoverage: () => 0,
    runDoctor: () => 0, runCapabilities: () => 0, runHealCommand: () => 0, runAck: () => 0,
  });

  it('parses the patched path and --output', () => {
    const opts = byName.get('revert').parse(['x.patched.js', '--output', 'restored.js']);
    assert.equal(opts.revert, true);
    assert.equal(opts.patchedPath, path.resolve('x.patched.js'));
    assert.equal(opts.outputPath, path.resolve('restored.js'));
  });

  it('returns a Usage error when no path is given', () => {
    const opts = byName.get('revert').parse([]);
    assert.ok(opts.error);
    assert.match(opts.error, /Usage: node patch-cli\.mjs revert/);
  });
});

// ── round-trip restore ────────────────────────────────────────────────────────

describe('runRevert — restores byte-exact original', () => {
  it('restores the original bundle from a real build sidecar', async () => {
    const { outputPath } = await buildPatched();
    // Sanity: the patched bundle differs from the original.
    assert.notEqual(fs.readFileSync(outputPath, 'utf8'), BUNDLE);

    const restoredPath = outputPath.replace(/\.patched\.js$/, '.restored.js');
    const logger = captureLogger();
    const rc = await runRevert({ patchedPath: outputPath, outputPath: restoredPath }, logger);
    assert.equal(rc, 0, `revert failed: ${err(logger)}`);

    const restored = fs.readFileSync(restoredPath, 'utf8');
    assert.equal(restored, BUNDLE, 'restored bytes must equal the original');
    assert.equal(sha256(restored), sha256(BUNDLE));
    assert.ok(logger.lines.some(l => /reverted: sentinel/.test(l)));
  });

  it('restores in place (no --output) when only the patched path is given', async () => {
    const { outputPath } = await buildPatched();
    const logger = captureLogger();
    const rc = await runRevert({ patchedPath: outputPath, outputPath: null }, logger);
    assert.equal(rc, 0, `revert failed: ${err(logger)}`);
    assert.equal(fs.readFileSync(outputPath, 'utf8'), BUNDLE);
  });
});

// ── error paths ───────────────────────────────────────────────────────────────

describe('runRevert — error paths', () => {
  it('returns 1 when the patched file does not exist', async () => {
    const logger = captureLogger();
    const rc = await runRevert({ patchedPath: path.join(scratchCwd, 'nope.js') }, logger);
    assert.equal(rc, 1);
    assert.match(err(logger), /file not found/);
  });

  it('refuses a binary target (.exe)', async () => {
    const binPath = path.join(scratchCwd, 'cli.exe');
    fs.writeFileSync(binPath, 'mock-binary');
    const logger = captureLogger();
    const rc = await runRevert({ patchedPath: binPath }, logger);
    assert.equal(rc, 1);
    assert.match(err(logger), /JavaScript bundles/);
  });

  it('errors when the reverse-diff sidecar is missing', async () => {
    const p = path.join(scratchCwd, 'no-sidecar.mjs');
    fs.writeFileSync(p, 'var x=1;\n');
    const logger = captureLogger();
    const rc = await runRevert({ patchedPath: p }, logger);
    assert.equal(rc, 1);
    assert.match(err(logger), /No reverse-diff sidecar/);
  });
});
