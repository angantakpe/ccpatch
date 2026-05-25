import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyPatch } from 'diff';

import { applyNamedPatches } from '../runner/runner.mjs';
import { parsePatchCliArgs, runRevert, runDiff } from '../runner/cli.mjs';

const silent = { log() {}, warn() {}, error() {} };

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function mkPatch(apply, verify) {
  // Manifest requires a real verify block; default to an always-true count=0 absent.
  return { description: 't', apply, verify: verify ?? { absent: '__ccp_never_present__' } };
}

const ORIGINAL = [
  'function alpha() { return 1; }',
  'function beta()  { return 2; }',
  'function gamma() { return 3; }',
  '',
].join('\n');

describe('applyNamedPatches — reverse diff capture', () => {
  it('captures one reverse-diff entry per changed patch', async () => {
    const patches = {
      a: mkPatch((c) => c.replace('return 1;', 'return 11;')),
      b: mkPatch((c) => c.replace('return 2;', 'return 22;')),
    };
    const captureReverse = [];
    const out = await applyNamedPatches(ORIGINAL, patches, ['a', 'b'], silent, { captureReverse });
    assert.equal(captureReverse.length, 2);
    assert.equal(captureReverse[0].name, 'a');
    assert.equal(captureReverse[1].name, 'b');
    assert.equal(captureReverse[0].preSha256, sha256(ORIGINAL));
    assert.equal(captureReverse[1].postSha256, sha256(out));
  });

  it('omits no-change patches from the sidecar', async () => {
    const patches = {
      a: mkPatch((c) => c.replace('return 1;', 'return 11;')),
      noop: mkPatch((c) => c), // no change
      b: mkPatch((c) => c.replace('return 2;', 'return 22;')),
    };
    const captureReverse = [];
    await applyNamedPatches(ORIGINAL, patches, ['a', 'noop', 'b'], silent, { captureReverse });
    assert.equal(captureReverse.length, 2);
    assert.deepEqual(captureReverse.map(e => e.name), ['a', 'b']);
  });

  it('applying reverse diffs in reverse order restores byte-for-byte', async () => {
    const patches = {
      a: mkPatch((c) => c.replace('return 1;', 'return 11;')),
      b: mkPatch((c) => c.replace('return 2;', 'return 22;')),
      c: mkPatch((c) => c.replace('return 3;', 'return 33;')),
    };
    const captureReverse = [];
    const patched = await applyNamedPatches(ORIGINAL, patches, ['a', 'b', 'c'], silent, { captureReverse });
    assert.notEqual(patched, ORIGINAL);

    let current = patched;
    for (const entry of captureReverse.slice().reverse()) {
      const restored = applyPatch(current, entry.reverseDiff);
      assert.notEqual(restored, false, `reverse-diff for ${entry.name} failed to apply`);
      current = restored;
    }
    assert.equal(sha256(current), sha256(ORIGINAL));
    assert.equal(current, ORIGINAL);
  });
});

describe('ccpatch revert / diff — CLI round-trip', () => {
  function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-rev-'));
  }

  it('parsePatchCliArgs recognises revert and diff', () => {
    const r = parsePatchCliArgs(['revert', '/tmp/x.mjs', '--output', '/tmp/y.mjs']);
    assert.equal(r.revert, true);
    assert.equal(r.patchedPath, path.resolve('/tmp/x.mjs'));
    assert.equal(r.outputPath, path.resolve('/tmp/y.mjs'));

    const d = parsePatchCliArgs(['diff', '/tmp/x.mjs']);
    assert.equal(d.diff, true);
    assert.equal(d.patchedPath, path.resolve('/tmp/x.mjs'));
  });

  it('revert restores sha256-equal original', async () => {
    const dir = tmpDir();
    const patchedPath = path.join(dir, 'patched.mjs');
    const patches = {
      a: mkPatch((c) => c.replace('return 1;', 'return 11;')),
      b: mkPatch((c) => c.replace('return 2;', 'return 22;')),
    };
    const captureReverse = [];
    const patched = await applyNamedPatches(ORIGINAL, patches, ['a', 'b'], silent, { captureReverse });
    fs.writeFileSync(patchedPath, patched, 'utf8');
    fs.writeFileSync(patchedPath + '.ccp-revert.json', JSON.stringify({
      version: 1,
      timestamp: new Date().toISOString(),
      ccVersion: '0.0.0-test',
      inputSha256: sha256(ORIGINAL),
      outputSha256: sha256(patched),
      patches: captureReverse,
    }, null, 2), 'utf8');

    const restoredPath = path.join(dir, 'restored.mjs');
    const code = await runRevert({ patchedPath, outputPath: restoredPath }, silent);
    assert.equal(code, 0);
    const restored = fs.readFileSync(restoredPath, 'utf8');
    assert.equal(sha256(restored), sha256(ORIGINAL));
    assert.equal(restored, ORIGINAL);
  });

  it('revert refuses binary targets (.exe)', async () => {
    const dir = tmpDir();
    const binPath = path.join(dir, 'cli.exe');
    fs.writeFileSync(binPath, 'mock');
    const errs = [];
    const log = { log() {}, warn() {}, error: (m) => errs.push(String(m)) };
    const code = await runRevert({ patchedPath: binPath }, log);
    assert.equal(code, 1);
    assert.ok(errs.some(e => e.includes('JavaScript bundles')), `errs: ${errs.join('|')}`);
  });

  it('diff prints per-patch +/- counts', async () => {
    const dir = tmpDir();
    const patchedPath = path.join(dir, 'patched.mjs');
    const patches = {
      a: mkPatch((c) => c.replace('return 1;', 'return 11;\nfunction added_by_a() {}')),
      b: mkPatch((c) => c.replace('return 2;', 'return 22;')),
    };
    const captureReverse = [];
    const patched = await applyNamedPatches(ORIGINAL, patches, ['a', 'b'], silent, { captureReverse });
    fs.writeFileSync(patchedPath, patched, 'utf8');
    fs.writeFileSync(patchedPath + '.ccp-revert.json', JSON.stringify({
      version: 1,
      timestamp: new Date().toISOString(),
      ccVersion: null,
      inputSha256: sha256(ORIGINAL),
      outputSha256: sha256(patched),
      patches: captureReverse,
    }, null, 2), 'utf8');

    const lines = [];
    const log = { log: (m) => lines.push(String(m)), warn() {}, error() {} };
    const code = await runDiff({ patchedPath }, log);
    assert.equal(code, 0);
    const body = lines.join('\n');
    assert.ok(/\ba\b/.test(body), 'expected patch "a" in diff output');
    assert.ok(/\bb\b/.test(body), 'expected patch "b" in diff output');
    // Patch "a" adds a line, patch "b" is a 1-for-1 replacement.
    const aLine = lines.find(l => /^\s*a\s/.test(l));
    assert.ok(aLine, 'expected a row for patch "a"');
    // Patch "a" should show more added than removed.
    const aMatch = aLine.match(/(\d+)\s+(\d+)\s*$/);
    assert.ok(aMatch, `could not parse counts from: ${aLine}`);
    const aAdded = Number(aMatch[1]);
    const aRemoved = Number(aMatch[2]);
    assert.ok(aAdded > aRemoved, `expected a.added > a.removed, got ${aAdded}/${aRemoved}`);
  });

  it('revert errors when sidecar is missing', async () => {
    const dir = tmpDir();
    const patchedPath = path.join(dir, 'no-sidecar.mjs');
    fs.writeFileSync(patchedPath, 'hello');
    const errs = [];
    const log = { log() {}, warn() {}, error: (m) => errs.push(String(m)) };
    const code = await runRevert({ patchedPath }, log);
    assert.equal(code, 1);
    assert.ok(errs.some(e => e.includes('No reverse-diff sidecar')));
  });
});
