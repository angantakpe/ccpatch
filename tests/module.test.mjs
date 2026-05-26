import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hashPatchesTree,
  installModuleFromPath,
  listModules,
  removeModule,
  verifyModule,
  readModuleManifest,
} from '../runner/modules.mjs';
import { runModuleCommand } from '../runner/cli.mjs';
import { loadPatches } from '../runner/loader.mjs';
import { validateManifest } from '../runner/manifest.mjs';

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'example-module',
);

function newProject() {
  // A throwaway "project root" with a stub core/ — loadPatches() requires
  // core/ to exist. We point at the real core dir to keep tests realistic.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-mod-proj-'));
  // The loader looks at <projectRoot>/modules/. Core and extensions stay
  // anchored to PROJECT_ROOT in loadPatches, so we only need to provide
  // overrides for those two paths to a known-empty location to keep tests
  // hermetic.
  return root;
}

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

function copyFixture() {
  // Copy the read-only fixture to a writable scratch dir so individual tests
  // can mutate the manifest (e.g. set signature) without disturbing others.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-mod-fix-'));
  fs.cpSync(FIXTURE_DIR, tmp, { recursive: true });
  return tmp;
}

describe('hashPatchesTree', () => {
  it('produces a stable sha256 for a known fixture', () => {
    const patchesDir = path.join(FIXTURE_DIR, 'patches');
    const h1 = hashPatchesTree(patchesDir);
    const h2 = hashPatchesTree(patchesDir);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
  });

  it('changes when a patch file is mutated', () => {
    const src = copyFixture();
    const h1 = hashPatchesTree(path.join(src, 'patches'));
    fs.appendFileSync(path.join(src, 'patches', 'hello.mjs'), '\n// tampered\n');
    const h2 = hashPatchesTree(path.join(src, 'patches'));
    assert.notEqual(h1, h2);
  });
});

describe('module install / list / remove', () => {
  it('installs from a local path into <project>/modules/<name>/', () => {
    const project = newProject();
    const r = installModuleFromPath(FIXTURE_DIR, { projectRoot: project });
    assert.ok(fs.existsSync(r.dir));
    assert.ok(fs.existsSync(path.join(r.dir, 'ccpatch-module.json')));
    assert.ok(fs.existsSync(path.join(r.dir, 'patches', 'hello.mjs')));
    // Sanitised dir name for "@ccpatch-test/example-module"
    assert.ok(r.dir.endsWith('@ccpatch-test__example-module'));
  });

  it('module list returns installed modules', () => {
    const project = newProject();
    installModuleFromPath(FIXTURE_DIR, { projectRoot: project });
    const mods = listModules(project);
    assert.equal(mods.length, 1);
    assert.equal(mods[0].name, '@ccpatch-test/example-module');
    assert.equal(mods[0].version, '1.0.0');
    assert.equal(mods[0].signed, false);
  });

  it('module remove deletes the install dir', () => {
    const project = newProject();
    installModuleFromPath(FIXTURE_DIR, { projectRoot: project });
    removeModule('@ccpatch-test/example-module', { projectRoot: project });
    assert.equal(listModules(project).length, 0);
  });

  it('refuses to overwrite an existing install without --force', () => {
    const project = newProject();
    installModuleFromPath(FIXTURE_DIR, { projectRoot: project });
    assert.throws(
      () => installModuleFromPath(FIXTURE_DIR, { projectRoot: project }),
      /already installed/i,
    );
  });

  it('--force overwrites an existing install', () => {
    const project = newProject();
    installModuleFromPath(FIXTURE_DIR, { projectRoot: project });
    const r = installModuleFromPath(FIXTURE_DIR, { projectRoot: project, force: true });
    assert.ok(fs.existsSync(r.dir));
  });
});

describe('module verify', () => {
  it('passes when sha256(patches/) matches manifest.signature', () => {
    const src = copyFixture();
    const sig = hashPatchesTree(path.join(src, 'patches'));
    const mf = readModuleManifest(src);
    mf.signature = sig;
    fs.writeFileSync(path.join(src, 'ccpatch-module.json'), JSON.stringify(mf, null, 2));
    const project = newProject();
    installModuleFromPath(src, { projectRoot: project });
    const r = verifyModule('@ccpatch-test/example-module', { projectRoot: project });
    assert.equal(r.signed, true);
    assert.equal(r.ok, true);
  });

  it('flags a tampered module as non-zero exit and detects mismatch', async () => {
    const src = copyFixture();
    const sig = hashPatchesTree(path.join(src, 'patches'));
    const mf = readModuleManifest(src);
    mf.signature = sig;
    fs.writeFileSync(path.join(src, 'ccpatch-module.json'), JSON.stringify(mf, null, 2));
    const project = newProject();
    const installed = installModuleFromPath(src, { projectRoot: project });
    // Tamper a patch file post-install.
    fs.appendFileSync(path.join(installed.dir, 'patches', 'hello.mjs'), '\n// tampered\n');

    // Programmatic API:
    const r = verifyModule('@ccpatch-test/example-module', { projectRoot: project });
    assert.equal(r.signed, true);
    assert.equal(r.ok, false);
    assert.notEqual(r.expected, r.actual);

    // CLI surface:
    const logger = captureLogger();
    const code = await runModuleCommand(
      ['verify', '@ccpatch-test/example-module'],
      logger,
      { projectRoot: project },
    );
    assert.equal(code, 1);
    assert.ok(
      logger._err.some(l => l.includes('TAMPERED')),
      `expected TAMPERED in stderr, got: ${logger._err.join('\n')}`,
    );
  });

  it('reports UNSIGNED when manifest has no signature', () => {
    const project = newProject();
    installModuleFromPath(FIXTURE_DIR, { projectRoot: project });
    const r = verifyModule('@ccpatch-test/example-module', { projectRoot: project });
    assert.equal(r.signed, false);
    assert.equal(r.ok, null);
  });
});

describe('loader picks up module patches under <name>/<stem>', () => {
  it('exposes module patches with slash-namespaced names', async () => {
    const project = newProject();
    installModuleFromPath(FIXTURE_DIR, { projectRoot: project });
    const patches = await loadPatches({ projectRoot: project });
    const moduleNames = Object.keys(patches).filter(n => n.startsWith('@ccpatch-test/'));
    assert.deepEqual(
      moduleNames.sort(),
      ['@ccpatch-test/example-module/hello', '@ccpatch-test/example-module/risky'].sort(),
    );
    assert.equal(
      patches['@ccpatch-test/example-module/hello'].description,
      'example-module/hello fixture patch',
    );
  });

  it('includeModules:false disables module discovery', async () => {
    const project = newProject();
    installModuleFromPath(FIXTURE_DIR, { projectRoot: project });
    const patches = await loadPatches({ projectRoot: project, includeModules: false });
    assert.equal(
      Object.keys(patches).filter(n => n.includes('/')).length,
      0,
    );
  });
});

describe('slash-in-patch-name policy', () => {
  it('rejects slashes in core/extension patch names (validateManifest)', () => {
    // A core/ patch named "evil" with manifest mod.name === "evil/inner" must fail
    // because validateManifest enforces stem matching, and stems cannot contain '/'
    // since enumeratePatchNames reads filenames (which on POSIX can't contain '/').
    const { ok, errors } = validateManifest(
      { description: 'x', verify: { present: 'y', weak: true }, apply: () => '', name: 'foo/bar' },
      'foo.mjs',
    );
    assert.equal(ok, false);
    assert.ok(
      errors.some(e => e.includes('name mismatch')),
      `expected name mismatch, got: ${errors.join('; ')}`,
    );
  });

  it('accepts slash-namespaced names for module-source patches', async () => {
    // Loader-level: validate the module patch loads cleanly and is namespaced.
    const project = newProject();
    installModuleFromPath(FIXTURE_DIR, { projectRoot: project });
    const patches = await loadPatches({ projectRoot: project });
    assert.ok(patches['@ccpatch-test/example-module/hello']);
  });
});

describe('module install — high-risk capability gate', () => {
  it('exits non-zero in strict mode when high-risk patches lack --allow-capabilities', async () => {
    // The fixture's risky.mjs declares ['network', 'telemetry'] (high risk).
    const project = newProject();
    const logger = captureLogger();
    const code = await runModuleCommand(
      ['install', FIXTURE_DIR, '--strict'],
      logger,
      { projectRoot: project },
    );
    assert.equal(code, 1);
    assert.ok(
      logger._err.some(l => l.includes('--allow-capabilities')),
      `expected gate rejection, got: ${logger._err.join('\n')}`,
    );
    assert.equal(listModules(project).length, 0, 'module must not be installed on gate failure');
  });

  it('allows install in strict mode when --allow-capabilities covers the caps', async () => {
    const project = newProject();
    const logger = captureLogger();
    const code = await runModuleCommand(
      ['install', FIXTURE_DIR, '--strict', '--allow-capabilities=all'],
      logger,
      { projectRoot: project },
    );
    assert.equal(code, 0, `unexpected failure: ${logger._err.join('\n')}`);
    assert.equal(listModules(project).length, 1);
  });

  it('warns (but proceeds) for high-risk modules in non-strict mode', async () => {
    const project = newProject();
    const logger = captureLogger();
    const code = await runModuleCommand(
      ['install', FIXTURE_DIR],
      logger,
      { projectRoot: project },
    );
    assert.equal(code, 0);
    assert.ok(
      logger._out.some(l => l.includes('WARN')),
      `expected a WARN log line, got:\n${logger._out.join('\n')}`,
    );
    assert.equal(listModules(project).length, 1);
  });
});

describe('module install — unsigned module loads but warns', () => {
  it('logs an UNSIGNED warning at install time', async () => {
    const project = newProject();
    const logger = captureLogger();
    const code = await runModuleCommand(
      ['install', FIXTURE_DIR, '--allow-capabilities=all'],
      logger,
      { projectRoot: project },
    );
    assert.equal(code, 0);
    assert.ok(
      logger._out.some(l => l.toLowerCase().includes('unsigned')),
      `expected unsigned warning, got:\n${logger._out.join('\n')}`,
    );
  });
});
