// tests/cmd-pin.test.mjs — unit tests for runner/cli/cmd-pin.mjs
//
// Tests cover:
//   - CLI option parsing via the commands table (registered subcommand shape)
//   - exit code 2 when version is missing
//   - exit code 1 when --input bundle does not exist
//   - writePin integration: pin / noop / refuse-on-mismatch / force

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPin } from '../runner/cli/cmd-pin.mjs';
import { writePin } from '../runner/known-shas.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

function captureLogger() {
  const lines = [];
  const errs = [];
  return {
    lines,
    errs,
    log: (...a) => lines.push(a.join(' ')),
    warn: (...a) => lines.push('WARN ' + a.join(' ')),
    error: (...a) => errs.push(a.join(' ')),
  };
}

function errsJoin(logger) { return logger.errs.join('\n'); }

function tmpReg(content = { versions: {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-pin-cmd-'));
  const p = path.join(dir, 'known-shas.json');
  fs.writeFileSync(p, JSON.stringify(content, null, 2) + '\n', 'utf8');
  return p;
}

// ── commands table: registration ──────────────────────────────────────────────

describe('commands table — pin subcommand registration', () => {
  it('is registered as a named subcommand', async () => {
    const { buildCommandTable, namedSubcommands } = await import('../runner/cli/commands.mjs');
    const impl = {
      parseBuild: () => ({}), runBuild: () => 0,
      runRevert: () => 0, runDiff: () => 0, runReplCommand: () => 0,
      runVersions: () => 0, runRefmap: () => 0, runFallbackCapture: () => 0,
      runWatch: () => 0, runCoverage: () => 0, runDoctor: () => 0,
      runCapabilities: () => 0, runHealCommand: () => 0, runAck: () => 0,
    };
    const cmdTable = buildCommandTable(impl);
    const names = namedSubcommands(cmdTable);
    assert.ok(names.includes('pin'), `expected "pin" in subcommands, got: ${names.join(', ')}`);
  });

  it('parse returns pin:true and correct fields', async () => {
    const { buildCommandTable } = await import('../runner/cli/commands.mjs');
    const impl = {
      parseBuild: () => ({}), runBuild: () => 0,
      runRevert: () => 0, runDiff: () => 0, runReplCommand: () => 0,
      runVersions: () => 0, runRefmap: () => 0, runFallbackCapture: () => 0,
      runWatch: () => 0, runCoverage: () => 0, runDoctor: () => 0,
      runCapabilities: () => 0, runHealCommand: () => 0, runAck: () => 0,
    };
    const { byName } = buildCommandTable(impl);
    const cmd = byName.get('pin');
    const opts = cmd.parse(['2.1.0', '--source', 'my-build', '--force', '--verbose']);
    assert.equal(opts.pin, true);
    assert.equal(opts.pinVersion, '2.1.0');
    assert.equal(opts.pinSource, 'my-build');
    assert.equal(opts.pinForce, true);
    assert.equal(opts.pinVerbose, true);
  });

  it('parse returns an error object when version is missing', async () => {
    const { buildCommandTable } = await import('../runner/cli/commands.mjs');
    const impl = {
      parseBuild: () => ({}), runBuild: () => 0,
      runRevert: () => 0, runDiff: () => 0, runReplCommand: () => 0,
      runVersions: () => 0, runRefmap: () => 0, runFallbackCapture: () => 0,
      runWatch: () => 0, runCoverage: () => 0, runDoctor: () => 0,
      runCapabilities: () => 0, runHealCommand: () => 0, runAck: () => 0,
    };
    const { byName } = buildCommandTable(impl);
    const cmd = byName.get('pin');
    const opts = cmd.parse([]);
    assert.ok(opts.error, 'empty args should produce an error field');
    assert.match(opts.error, /Usage/);
  });

  it('parse returns an error when first arg starts with -', async () => {
    const { buildCommandTable } = await import('../runner/cli/commands.mjs');
    const impl = {
      parseBuild: () => ({}), runBuild: () => 0,
      runRevert: () => 0, runDiff: () => 0, runReplCommand: () => 0,
      runVersions: () => 0, runRefmap: () => 0, runFallbackCapture: () => 0,
      runWatch: () => 0, runCoverage: () => 0, runDoctor: () => 0,
      runCapabilities: () => 0, runHealCommand: () => 0, runAck: () => 0,
    };
    const { byName } = buildCommandTable(impl);
    const cmd = byName.get('pin');
    const opts = cmd.parse(['--force']);
    assert.ok(opts.error);
  });
});

// ── runPin exit codes ─────────────────────────────────────────────────────────

describe('runPin — missing version → exit 2', () => {
  it('returns 2 and logs Usage', async () => {
    const logger = captureLogger();
    const rc = await runPin({ options: { pinVersion: null }, logger });
    assert.equal(rc, 2);
    assert.match(errsJoin(logger), /Usage/);
  });
});

describe('runPin — bundle not found → exit 1', () => {
  it('returns 1 when --input path does not exist', async () => {
    const logger = captureLogger();
    const rc = await runPin({
      options: { pinVersion: '9.9.9', pinInput: '/nonexistent/cli.cjs' },
      logger,
    });
    assert.equal(rc, 1);
    assert.match(errsJoin(logger), /Bundle not found/);
  });
});

// ── runPin successful pin (end-to-end via actual file + temp registry) ────────
// We can't easily override the DEFAULT_REGISTRY inside cmd-pin, so we test the
// underlying writePin for write isolation. The runPin e2e is verified through
// the commands table parse + the writePin integration tests below.

// ── writePin integration (exercising the same path cmd-pin uses) ──────────────

describe('writePin — new pin', () => {
  it('writes entry and returns status=pinned', () => {
    const p = tmpReg({ _comment: 'test', versions: {} });
    const sha = 'd'.repeat(64);
    const result = writePin({ version: '4.0.0', cliSha256: sha, sizeBytes: 50, source: 'test', registryPath: p });
    assert.equal(result.status, 'pinned');
    const written = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.ok(written.versions['4.0.0']);
    assert.equal(written.versions['4.0.0'].cliSha256, sha);
    assert.equal(written.versions['4.0.0'].sizeBytes, 50);
    assert.equal(written.versions['4.0.0'].source, 'test');
    // Metadata preserved.
    assert.equal(written._comment, 'test');
  });
});

describe('writePin — noop (idempotent)', () => {
  it('returns status=noop and does not modify the file', () => {
    const sha = 'e'.repeat(64);
    const p = tmpReg({ versions: { '4.1.0': { cliSha256: sha, sizeBytes: 10, source: 'npm' } } });
    const before = fs.readFileSync(p, 'utf8');
    const result = writePin({ version: '4.1.0', cliSha256: sha, registryPath: p });
    const after = fs.readFileSync(p, 'utf8');
    assert.equal(result.status, 'noop');
    assert.equal(before, after);
  });
});

describe('writePin — refuse on sha mismatch (fail-closed)', () => {
  it('throws SECURITY error and leaves file unchanged', () => {
    const sha1 = 'f'.repeat(64);
    const sha2 = '0'.repeat(64);
    const p = tmpReg({ versions: { '4.2.0': { cliSha256: sha1 } } });
    const before = fs.readFileSync(p, 'utf8');
    assert.throws(
      () => writePin({ version: '4.2.0', cliSha256: sha2, registryPath: p }),
      /SECURITY/
    );
    assert.equal(fs.readFileSync(p, 'utf8'), before);
  });

  it('allows re-pin with force=true', () => {
    const sha1 = 'f'.repeat(64);
    const sha2 = '1'.repeat(64);
    const p = tmpReg({ versions: { '4.3.0': { cliSha256: sha1 } } });
    const result = writePin({ version: '4.3.0', cliSha256: sha2, force: true, registryPath: p });
    assert.equal(result.status, 'pinned');
    const written = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(written.versions['4.3.0'].cliSha256, sha2);
  });
});
