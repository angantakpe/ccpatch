// tests/cmd-module.test.mjs — end-to-end tests for the `ccpatch module` command
// dispatch (runner/cli/cmd-module.mjs), focused on the NO-NETWORK, read-only and
// local-install surfaces that tests/module.test.mjs does not already cover:
//   - the subcommand router (no / unknown subcommand → usage + exit 1)
//   - `module list` on an empty project
//   - `module remove` / `module verify` missing-arg guards
//   - `module install` arg validation (bad --expect-sha256, git URL rejection)
//   - local `--expect-sha256` source pinning: matching hash installs, a
//     mismatched hash refuses (deterministic, no network).
//
// Network-dependent install/update paths (http(s) tarball fetch) are out of
// scope here — tests/module.test.mjs covers fetchAndExtractTarball hardening
// against a local http server, and we deliberately do not reach the network.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runModuleCommand } from '../runner/cli/cmd-module.mjs';
import { hashPatchesTree, listModules } from '../runner/modules.mjs';

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'example-module',
);

function captureLogger() {
  const out = [];
  const err = [];
  return {
    log: (...a) => out.push(a.join(' ')),
    warn: (...a) => out.push(a.join(' ')),
    error: (...a) => err.push(a.join(' ')),
    _out: out,
    _err: err,
  };
}
function newProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-mod-cli-'));
}

// ── subcommand router ─────────────────────────────────────────────────────────

describe('runModuleCommand — dispatch', () => {
  it('prints usage and exits 1 with no subcommand', async () => {
    const logger = captureLogger();
    const code = await runModuleCommand([], logger, { projectRoot: newProject() });
    assert.equal(code, 1);
    assert.ok(logger._out.some(l => /Usage:\s*\n?\s*ccpatch module install/.test(l) || l.includes('ccpatch module install')),
      `expected MODULE_USAGE, got:\n${logger._out.join('\n')}`);
  });

  it('prints usage and exits 1 for an unknown subcommand', async () => {
    const logger = captureLogger();
    const code = await runModuleCommand(['frobnicate'], logger, { projectRoot: newProject() });
    assert.equal(code, 1);
    assert.ok(logger._out.some(l => l.includes('ccpatch module install')));
  });
});

// ── read-only surfaces ────────────────────────────────────────────────────────

describe('runModuleCommand — list / remove / verify guards', () => {
  it('list on an empty project reports none installed, exit 0', async () => {
    const project = newProject();
    const logger = captureLogger();
    const code = await runModuleCommand(['list'], logger, { projectRoot: project });
    assert.equal(code, 0);
    assert.ok(logger._out.some(l => /No modules installed/.test(l)));
  });

  it('remove with no name exits 1 with a guard message', async () => {
    const logger = captureLogger();
    const code = await runModuleCommand(['remove'], logger, { projectRoot: newProject() });
    assert.equal(code, 1);
    assert.match(logger._err.join('\n'), /module remove <name>/);
  });

  it('remove of a non-existent module exits 1', async () => {
    const logger = captureLogger();
    const code = await runModuleCommand(['remove', '@nope/missing'], logger, { projectRoot: newProject() });
    assert.equal(code, 1);
    assert.match(logger._err.join('\n'), /not found/i);
  });

  it('verify with no name exits 1 with a guard message', async () => {
    const logger = captureLogger();
    const code = await runModuleCommand(['verify'], logger, { projectRoot: newProject() });
    assert.equal(code, 1);
    assert.match(logger._err.join('\n'), /module verify <name>/);
  });
});

// ── install arg validation (no network) ───────────────────────────────────────

describe('runModuleCommand install — arg validation', () => {
  it('install with no source exits 1', async () => {
    const logger = captureLogger();
    const code = await runModuleCommand(['install'], logger, { projectRoot: newProject() });
    assert.equal(code, 1);
    assert.match(logger._err.join('\n'), /requires a path or URL/);
  });

  it('rejects a non-hex --expect-sha256', async () => {
    const logger = captureLogger();
    const code = await runModuleCommand(
      ['install', FIXTURE_DIR, '--expect-sha256', 'not-a-sha'],
      logger,
      { projectRoot: newProject() },
    );
    assert.equal(code, 1);
    assert.match(logger._err.join('\n'), /64-char hex sha256/);
  });

  it('rejects git URLs in v1', async () => {
    const logger = captureLogger();
    const code = await runModuleCommand(
      ['install', 'git+https://example.com/mod.git', '--allow-capabilities=all'],
      logger,
      { projectRoot: newProject() },
    );
    assert.equal(code, 1);
    assert.match(logger._err.join('\n'), /git URLs are not supported/);
  });
});

// ── local --expect-sha256 source pinning (deterministic, no network) ──────────

describe('runModuleCommand install — local --expect-sha256 pinning', () => {
  it('installs when the out-of-band hash matches the patches/ tree', async () => {
    const project = newProject();
    const goodHash = hashPatchesTree(path.join(FIXTURE_DIR, 'patches'));
    const logger = captureLogger();
    const code = await runModuleCommand(
      ['install', FIXTURE_DIR, '--expect-sha256', goodHash, '--allow-capabilities=all'],
      logger,
      { projectRoot: project },
    );
    assert.equal(code, 0, `unexpected failure: ${logger._err.join('\n')}`);
    assert.ok(logger._out.some(l => /contentHash OK \(verified against out-of-band/.test(l)));
    assert.equal(listModules(project).length, 1);
  });

  it('refuses to install when the out-of-band hash does not match', async () => {
    const project = newProject();
    const wrongHash = 'a'.repeat(64);
    const logger = captureLogger();
    const code = await runModuleCommand(
      ['install', FIXTURE_DIR, '--expect-sha256', wrongHash, '--allow-capabilities=all'],
      logger,
      { projectRoot: project },
    );
    assert.equal(code, 1);
    assert.match(logger._err.join('\n'), /--expect-sha256 mismatch/);
    assert.equal(listModules(project).length, 0, 'module must not install on hash mismatch');
  });
});
