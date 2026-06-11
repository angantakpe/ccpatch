// tests/known-shas.test.mjs — unit tests for runner/known-shas.mjs
//
// Tests cover:
//   - loadKnownShas: reads an existing registry, handles missing file
//   - lookupVersion: finds / misses a version
//   - writePin: new version, idempotent noop, refuse on mismatch, force override
//   - assertValidSha256: validation

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  loadKnownShas,
  lookupVersion,
  writePin,
  assertValidSha256,
  sha256OfFile,
} from '../runner/known-shas.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

const VALID_SHA = 'a'.repeat(64);
const VALID_SHA2 = 'b'.repeat(64);

function makeTmpRegistry(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-sha-test-'));
  const p = path.join(dir, 'known-shas.json');
  if (content !== undefined) fs.writeFileSync(p, JSON.stringify(content, null, 2) + '\n', 'utf8');
  return { dir, p };
}

function readRegistry(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ── assertValidSha256 ─────────────────────────────────────────────────────────

describe('assertValidSha256', () => {
  it('accepts a valid 64-char hex sha', () => {
    assert.doesNotThrow(() => assertValidSha256(VALID_SHA));
    assert.doesNotThrow(() => assertValidSha256('A'.repeat(64))); // uppercase OK
  });

  it('rejects non-hex characters', () => {
    assert.throws(() => assertValidSha256('z'.repeat(64)), /Invalid sha256/);
  });

  it('rejects wrong length', () => {
    assert.throws(() => assertValidSha256('a'.repeat(63)), /Invalid sha256/);
    assert.throws(() => assertValidSha256('a'.repeat(65)), /Invalid sha256/);
  });

  it('rejects non-string', () => {
    assert.throws(() => assertValidSha256(null), /Invalid sha256/);
    assert.throws(() => assertValidSha256(12345), /Invalid sha256/);
  });
});

// ── sha256OfFile ──────────────────────────────────────────────────────────────

describe('sha256OfFile', () => {
  it('returns the correct hex sha256 of a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-sha-file-'));
    const f = path.join(dir, 'data.bin');
    const content = Buffer.from('hello world');
    fs.writeFileSync(f, content);
    const expected = createHash('sha256').update(content).digest('hex');
    assert.equal(sha256OfFile(f), expected);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── loadKnownShas ─────────────────────────────────────────────────────────────

describe('loadKnownShas', () => {
  it('returns empty versions when the file does not exist', () => {
    const { p } = makeTmpRegistry(); // file not written
    // Use a path that cannot exist
    const result = loadKnownShas(p + '.nonexistent');
    assert.deepEqual(result.versions, {});
  });

  it('parses versions, _comment, and _format from a valid registry', () => {
    const { p } = makeTmpRegistry({
      _comment: 'test comment',
      _format: { '<v>': { cliSha256: 'hex' } },
      versions: {
        '1.0.0': { cliSha256: VALID_SHA, sizeBytes: 100, source: 'npm' },
      },
    });
    const reg = loadKnownShas(p);
    assert.equal(reg._comment, 'test comment');
    assert.ok(reg._format);
    assert.equal(reg.versions['1.0.0'].cliSha256, VALID_SHA);
    assert.equal(reg._path, p);
  });

  it('throws on invalid JSON', () => {
    const { p } = makeTmpRegistry();
    fs.writeFileSync(p, '{ not valid json }');
    assert.throws(() => loadKnownShas(p), /not valid JSON/);
  });
});

// ── lookupVersion ─────────────────────────────────────────────────────────────

describe('lookupVersion', () => {
  it('returns null for a version not in the registry', () => {
    const { p } = makeTmpRegistry({ versions: {} });
    assert.equal(lookupVersion('9.9.9', p), null);
  });

  it('returns the entry for a known version', () => {
    const { p } = makeTmpRegistry({
      versions: {
        '2.0.0': { cliSha256: VALID_SHA, sizeBytes: 42, source: 'npm' },
      },
    });
    const entry = lookupVersion('2.0.0', p);
    assert.ok(entry);
    assert.equal(entry.cliSha256, VALID_SHA);
  });
});

// ── writePin — new version ────────────────────────────────────────────────────

describe('writePin — new version', () => {
  it('adds the entry and returns status=pinned', () => {
    const { p } = makeTmpRegistry({
      _comment: 'test',
      versions: {},
    });
    const result = writePin({ version: '3.0.0', cliSha256: VALID_SHA, sizeBytes: 999, source: 'test', registryPath: p });
    assert.equal(result.status, 'pinned');
    const written = readRegistry(p);
    assert.ok(written.versions['3.0.0']);
    assert.equal(written.versions['3.0.0'].cliSha256, VALID_SHA);
    assert.equal(written.versions['3.0.0'].sizeBytes, 999);
    assert.equal(written.versions['3.0.0'].source, 'test');
  });

  it('preserves _comment and _format in the output', () => {
    const { p } = makeTmpRegistry({
      _comment: 'my comment',
      _format: { key: 'value' },
      versions: {},
    });
    writePin({ version: '3.0.0', cliSha256: VALID_SHA, registryPath: p });
    const written = readRegistry(p);
    assert.equal(written._comment, 'my comment');
    assert.deepEqual(written._format, { key: 'value' });
  });

  it('normalises sha256 to lowercase', () => {
    const { p } = makeTmpRegistry({ versions: {} });
    writePin({ version: '3.1.0', cliSha256: VALID_SHA.toUpperCase(), registryPath: p });
    const written = readRegistry(p);
    assert.equal(written.versions['3.1.0'].cliSha256, VALID_SHA.toLowerCase());
  });

  it('omits sizeBytes and source when not provided', () => {
    const { p } = makeTmpRegistry({ versions: {} });
    writePin({ version: '3.2.0', cliSha256: VALID_SHA, registryPath: p });
    const written = readRegistry(p);
    const entry = written.versions['3.2.0'];
    assert.ok(!('sizeBytes' in entry));
    assert.ok(!('source' in entry));
  });

  it('creates the registry file if it does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-sha-new-'));
    const p = path.join(dir, 'known-shas.json');
    assert.ok(!fs.existsSync(p));
    writePin({ version: '1.0.0', cliSha256: VALID_SHA, registryPath: p });
    assert.ok(fs.existsSync(p));
    const written = readRegistry(p);
    assert.ok(written.versions['1.0.0']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── writePin — idempotent noop ────────────────────────────────────────────────

describe('writePin — idempotent noop', () => {
  it('returns status=noop when same version + same sha already pinned', () => {
    const { p } = makeTmpRegistry({
      versions: {
        '2.1.0': { cliSha256: VALID_SHA, sizeBytes: 100, source: 'npm' },
      },
    });
    const before = fs.readFileSync(p, 'utf8');
    const result = writePin({ version: '2.1.0', cliSha256: VALID_SHA, registryPath: p });
    const after = fs.readFileSync(p, 'utf8');
    assert.equal(result.status, 'noop');
    // File must not be modified for a noop.
    assert.equal(before, after);
  });

  it('noop is case-insensitive (uppercase sha vs lowercase stored)', () => {
    const { p } = makeTmpRegistry({
      versions: {
        '2.1.1': { cliSha256: VALID_SHA, sizeBytes: 100, source: 'npm' },
      },
    });
    const result = writePin({ version: '2.1.1', cliSha256: VALID_SHA.toUpperCase(), registryPath: p });
    assert.equal(result.status, 'noop');
  });
});

// ── writePin — refuse on mismatch (fail-closed) ───────────────────────────────

describe('writePin — refuse on mismatch', () => {
  it('throws when a different sha is provided for a known version', () => {
    const { p } = makeTmpRegistry({
      versions: {
        '2.1.0': { cliSha256: VALID_SHA, sizeBytes: 100, source: 'npm' },
      },
    });
    assert.throws(
      () => writePin({ version: '2.1.0', cliSha256: VALID_SHA2, registryPath: p }),
      /SECURITY.*different sha256/i
    );
  });

  it('does NOT modify the file on a refused mismatch', () => {
    const { p } = makeTmpRegistry({
      versions: {
        '2.1.0': { cliSha256: VALID_SHA, sizeBytes: 100, source: 'npm' },
      },
    });
    const before = fs.readFileSync(p, 'utf8');
    try {
      writePin({ version: '2.1.0', cliSha256: VALID_SHA2, registryPath: p });
    } catch (_) { /* expected */ }
    const after = fs.readFileSync(p, 'utf8');
    assert.equal(before, after);
  });

  it('allows overwrite when force=true', () => {
    const { p } = makeTmpRegistry({
      versions: {
        '2.1.0': { cliSha256: VALID_SHA, sizeBytes: 100, source: 'npm' },
      },
    });
    const result = writePin({ version: '2.1.0', cliSha256: VALID_SHA2, force: true, registryPath: p });
    assert.equal(result.status, 'pinned');
    const written = readRegistry(p);
    assert.equal(written.versions['2.1.0'].cliSha256, VALID_SHA2);
  });
});

// ── writePin — validation ─────────────────────────────────────────────────────

describe('writePin — input validation', () => {
  it('throws on invalid sha256', () => {
    const { p } = makeTmpRegistry({ versions: {} });
    assert.throws(
      () => writePin({ version: '1.0.0', cliSha256: 'not-a-sha', registryPath: p }),
      /Invalid sha256/
    );
  });

  it('throws when version is missing', () => {
    const { p } = makeTmpRegistry({ versions: {} });
    assert.throws(
      () => writePin({ cliSha256: VALID_SHA, registryPath: p }),
      /version must be a non-empty string/
    );
  });
});
