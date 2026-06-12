// tests/auto-pin.test.mjs — unit tests for runner/auto-pin.mjs
//
// Covers: pin-on-first-verified-build, idempotent noop on a matching pin,
// fail-loud mismatch on a disagreeing pin, the CCPATCH_NO_AUTOPIN kill switch,
// the no-marker skip, and the input-vs-marker sha binding. Synthetic inputs
// only — no real bundle.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { maybeAutoPin, isAutoPinDisabled } from '../runner/auto-pin.mjs';
import { lookupVersion } from '../runner/known-shas.mjs';

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

// Build a sandbox: an input bundle file, a registry, and (optionally) a marker.
function sandbox({ version = '9.9.9', bundleBytes = 'BUNDLE', registry = { versions: {} }, marker } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-autopin-'));
  const inputPath = path.join(dir, 'cli.cjs');
  fs.writeFileSync(inputPath, bundleBytes, 'utf8');
  const inputSha = sha256(Buffer.from(bundleBytes, 'utf8'));
  const registryPath = path.join(dir, 'known-shas.json');
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  const markerPath = path.join(dir, `tofu-pending-v${version}.json`);
  if (marker !== null) {
    const m = marker || { version, sha256: inputSha, source: 'test' };
    fs.writeFileSync(markerPath, JSON.stringify(m) + '\n', 'utf8');
  }
  return { dir, version, inputPath, inputSha, registryPath, markerPath };
}

describe('auto-pin', () => {
  it('isAutoPinDisabled honors CCPATCH_NO_AUTOPIN', () => {
    assert.equal(isAutoPinDisabled({ CCPATCH_NO_AUTOPIN: '1' }), true);
    assert.equal(isAutoPinDisabled({}), false);
  });

  it('pins on a first verified build, then consumes the marker', () => {
    const s = sandbox();
    const res = maybeAutoPin({
      version: s.version, inputPath: s.inputPath,
      markerPath: s.markerPath, registryPath: s.registryPath, env: {},
    });
    assert.equal(res.status, 'pinned');
    assert.equal(res.sha256, s.inputSha);
    // Pin recorded with the verified sha.
    assert.equal(lookupVersion(s.version, s.registryPath).cliSha256, s.inputSha);
    // Marker consumed.
    assert.equal(fs.existsSync(s.markerPath), false);
  });

  it('is a clean noop when the same sha is already pinned', () => {
    const s = sandbox({
      registry: { versions: { '9.9.9': { cliSha256: sha256(Buffer.from('BUNDLE', 'utf8')) } } },
    });
    const res = maybeAutoPin({
      version: s.version, inputPath: s.inputPath,
      markerPath: s.markerPath, registryPath: s.registryPath, env: {},
    });
    assert.equal(res.status, 'noop');
    assert.equal(fs.existsSync(s.markerPath), false);
  });

  it('FAILS LOUD on a mismatching existing pin and does NOT overwrite', () => {
    const otherSha = 'a'.repeat(64);
    const s = sandbox({ registry: { versions: { '9.9.9': { cliSha256: otherSha } } } });
    const res = maybeAutoPin({
      version: s.version, inputPath: s.inputPath,
      markerPath: s.markerPath, registryPath: s.registryPath, env: {},
    });
    assert.equal(res.status, 'mismatch');
    assert.match(res.error, /DIFFERENT sha256/);
    // The existing (different) pin is preserved — never clobbered.
    assert.equal(lookupVersion(s.version, s.registryPath).cliSha256, otherSha);
    // Marker is NOT consumed on a mismatch (left for inspection).
    assert.equal(fs.existsSync(s.markerPath), true);
  });

  it('is disabled by CCPATCH_NO_AUTOPIN=1 (marker left in place)', () => {
    const s = sandbox();
    const res = maybeAutoPin({
      version: s.version, inputPath: s.inputPath,
      markerPath: s.markerPath, registryPath: s.registryPath,
      env: { CCPATCH_NO_AUTOPIN: '1' },
    });
    assert.equal(res.status, 'skipped');
    assert.equal(lookupVersion(s.version, s.registryPath), null);
    assert.equal(fs.existsSync(s.markerPath), true);
  });

  it('skips when there is no TOFU marker', () => {
    const s = sandbox({ marker: null });
    const res = maybeAutoPin({
      version: s.version, inputPath: s.inputPath,
      markerPath: s.markerPath, registryPath: s.registryPath, env: {},
    });
    assert.equal(res.status, 'skipped');
    assert.match(res.reason, /no TOFU marker/);
  });

  it('skips when the input bundle does not match the marker sha (no blind pin)', () => {
    const s = sandbox({ marker: { version: '9.9.9', sha256: 'b'.repeat(64), source: 'test' } });
    const res = maybeAutoPin({
      version: s.version, inputPath: s.inputPath,
      markerPath: s.markerPath, registryPath: s.registryPath, env: {},
    });
    assert.equal(res.status, 'skipped');
    assert.match(res.reason, /does not match/);
    assert.equal(lookupVersion(s.version, s.registryPath), null);
  });
});
