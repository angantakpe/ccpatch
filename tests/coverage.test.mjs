/**
 * Tests for ccpatch coverage — apply-time manifest + runtime instrumentation.
 *
 * Synthetic fixtures only; no real CC binary needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { applyNamedPatches } from '../runner/runner.mjs';
import { validateManifest } from '../runner/manifest.mjs';
import covKernel from '../core/coverage_kernel.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const silent = { log() {}, warn() {}, error() {} };

// Make sure storage/outputs writes land in a tmp dir so concurrent tests don't
// stomp on each other. We chdir for each test that needs it.
function withTmpCwd(fn) {
  return async (...args) => {
    const prev = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-cov-'));
    try {
      process.chdir(tmp);
      await fn(tmp, ...args);
    } finally {
      process.chdir(prev);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  };
}

describe('manifest: coverageMarker validation', () => {
  function baseMod(extra = {}) {
    return {
      description: 'x',
      apply: (c) => c + '+',
      verify: { present: '+', weak: true },
      ...extra,
    };
  }

  it('accepts a non-empty string', () => {
    const { ok, errors, normalized } = validateManifest(
      baseMod({ coverageMarker: 'my-marker' }), 'p.mjs',
    );
    assert.ok(ok, errors.join('; '));
    assert.equal(normalized.coverageMarker, 'my-marker');
  });

  it('rejects an empty string', () => {
    const { ok, errors } = validateManifest(
      baseMod({ coverageMarker: '   ' }), 'p.mjs',
    );
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('coverageMarker')), errors.join('; '));
  });

  it('rejects non-string values', () => {
    const { ok, errors } = validateManifest(
      baseMod({ coverageMarker: 42 }), 'p.mjs',
    );
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('coverageMarker')));
  });

  it('defaults to null when omitted', () => {
    const { ok, normalized } = validateManifest(baseMod(), 'p.mjs');
    assert.ok(ok);
    assert.equal(normalized.coverageMarker, null);
  });
});

describe('apply-time coverage manifest', () => {
  it('writes coverage-apply-v<ver>.json reflecting applied/no-change/skipped', withTmpCwd(async (tmp) => {
    const patches = {
      good: {
        description: 'g',
        apply: (c) => c + '+good',
        verify: { present: '+good', weak: true },
      },
      noop: {
        description: 'n',
        apply: (c) => c,
        verify: { absent: 'never-there' },
      },
      // No-change when verify expects positive transform → marked no-change.
      drifted: {
        description: 'd',
        apply: (c) => c,
        verify: { present: 'wont-appear', weak: true },
      },
    };
    // bestEffort: 'drifted' declares verify.present and no-ops, which finding #1
    // makes fatal by default; this test asserts the manifest still records it as
    // applied:false (no-change) under lenient mode rather than aborting the run.
    await applyNamedPatches('seed', patches, ['good', 'noop', 'drifted'], silent, { version: '9.9.9', bestEffort: true });
    const file = path.join(tmp, 'storage/outputs/coverage-apply-v9.9.9.json');
    assert.ok(fs.existsSync(file), `expected manifest at ${file}`);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(manifest.ccVersion, '9.9.9');
    assert.equal(typeof manifest.appliedAt, 'string');
    assert.equal(manifest.patches.good.applied, true);
    assert.equal(manifest.patches.good.status, 'applied');
    assert.equal(manifest.patches.noop.applied, true); // no-change-ok
    assert.equal(manifest.patches.drifted.applied, false);
    assert.equal(manifest.patches.drifted.reason, 'no-change');
  }));

  it('falls back to coverage-apply-unknown.json when no version provided', withTmpCwd(async (tmp) => {
    const patches = { p: { description: 'p', apply: (c) => c + '!', verify: { present: '!', weak: true } } };
    await applyNamedPatches('x', patches, ['p'], silent);
    const file = path.join(tmp, 'storage/outputs/coverage-apply-unknown.json');
    assert.ok(fs.existsSync(file));
  }));
});

describe('coverage_kernel runtime', () => {
  it('installs __ccpCoverage and __ccpCovHit; hit() increments counter', () => {
    const ctx = vm.createContext({
      process: { on() {}, stdout: { write() {} } },
    });
    vm.runInContext(covKernel.preloadCode, ctx);
    assert.equal(typeof ctx.__ccpCovHit, 'function');
    assert.equal(typeof ctx.__ccpCoverage, 'object');
    ctx.__ccpCovHit('foo');
    ctx.__ccpCovHit('foo');
    ctx.__ccpCovHit('bar');
    assert.equal(ctx.__ccpCoverage.foo, 2);
    assert.equal(ctx.__ccpCoverage.bar, 1);
  });

  it('registers with __ccpProvide when contracts kernel is present', async () => {
    const ctx = vm.createContext({
      process: { on() {}, stdout: { write() {} } },
    });
    const contracts = (await import('../core/contracts.mjs')).default;
    vm.runInContext(contracts.preloadCode, ctx);
    vm.runInContext(covKernel.preloadCode, ctx);
    const cov = ctx.__ccpRequire('cov', { consumer: 'test', shape: ['hit'] });
    assert.equal(typeof cov.hit, 'function');
  });
});

describe('auto-injection of __ccpCovHit at apply time', () => {
  it('injects a hit call into the patched code when coverageMarker is set', withTmpCwd(async () => {
    const patches = {
      marked: {
        description: 'marked',
        apply: (c) => c + '\n/* INJECT */ console.log("did-thing");\n',
        verify: { present: 'did-thing', weak: true },
        coverageMarker: 'marked-hit',
      },
    };
    const { code: out } = await applyNamedPatches('seed-code', patches, ['marked'], silent);
    assert.ok(out.includes('__ccpCovHit'), `expected __ccpCovHit in output, got: ${out}`);
    assert.ok(out.includes('"marked-hit"'), `expected marker name in output`);
  }));

  it('skips instrumentation gracefully when patch produced no change', withTmpCwd(async () => {
    const logs = [];
    const logger = { log: (m) => logs.push(String(m)), warn() {}, error() {} };
    const patches = {
      ghost: {
        description: 'g',
        apply: (c) => c, // no-change
        verify: { absent: 'forbidden' },
        coverageMarker: 'ghost-hit',
      },
    };
    const { code: out } = await applyNamedPatches('x', patches, ['ghost'], logger);
    // No injection on no-change: the marker should not appear in code.
    assert.equal(out.includes('ghost-hit'), false);
  }));
});

describe('ccpatch coverage CLI — end-to-end on synthetic bundle', () => {
  it('reports LIVE for hit markers and DEAD for unhit ones; exit 1 when DEAD', withTmpCwd(async (tmp) => {
    // 1. Hand-write a coverage-apply manifest pretending two patches applied.
    fs.mkdirSync('storage/outputs', { recursive: true });
    const manifest = {
      ccVersion: '0.0.1',
      appliedAt: new Date().toISOString(),
      patches: {
        live_patch: { phase: 'main', applied: true, status: 'applied', diffSpans: 1, coverageMarker: 'live-marker' },
        dead_patch: { phase: 'main', applied: true, status: 'applied', diffSpans: 1, coverageMarker: 'dead-marker' },
        skipped_patch: { phase: 'main', applied: false, status: 'no-change', diffSpans: 0, reason: 'no-change' },
      },
    };
    fs.writeFileSync(
      'storage/outputs/coverage-apply-v0.0.1.json',
      JSON.stringify(manifest),
      'utf8',
    );

    // 2. Write a synthetic patched bundle that boots, hits live-marker, dumps
    //    the coverage map on exit, and quits.
    const bundlePath = path.join(tmp, 'fake-cli.js');
    const kernelPreload = covKernel.preloadCode;
    fs.writeFileSync(bundlePath, [
      '#!/usr/bin/env node',
      kernelPreload,
      'globalThis.__ccpCovHit("live-marker");',
      '// dead-marker is intentionally never called',
      'process.exit(0);',
    ].join('\n'), 'utf8');

    // 3. Invoke the ccpatch coverage CLI as a subprocess.
    const binPath = path.join(REPO_ROOT, 'bin/patch-cli.mjs');
    const out = path.join(tmp, 'coverage-report.json');
    const result = spawnSync(process.execPath, [
      binPath, 'coverage', bundlePath, '--cc-version', '0.0.1', '--out', out,
    ], { encoding: 'utf8', cwd: tmp });

    assert.equal(result.status, 1, `expected exit 1 (DEAD), got ${result.status}; stderr=${result.stderr}`);
    assert.ok(result.stdout.includes('LIVE'), `expected LIVE in output:\n${result.stdout}`);
    assert.ok(result.stdout.includes('DEAD'), `expected DEAD in output:\n${result.stdout}`);
    assert.ok(result.stdout.includes('SKIPPED'), `expected SKIPPED in output:\n${result.stdout}`);
    assert.ok(fs.existsSync(out));
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(report.deadCount, 1);
    const dead = report.patches.find(p => p.name === 'dead_patch');
    assert.equal(dead.status, 'DEAD');
    const live = report.patches.find(p => p.name === 'live_patch');
    assert.equal(live.status, 'LIVE');
    assert.equal(live.hits, 1);
  }));

  it('exits 0 when all instrumented patches were hit', withTmpCwd(async (tmp) => {
    fs.mkdirSync('storage/outputs', { recursive: true });
    const manifest = {
      ccVersion: '0.0.2',
      appliedAt: new Date().toISOString(),
      patches: {
        only_live: { phase: 'main', applied: true, status: 'applied', diffSpans: 1, coverageMarker: 'live2' },
      },
    };
    fs.writeFileSync(
      'storage/outputs/coverage-apply-v0.0.2.json',
      JSON.stringify(manifest),
      'utf8',
    );
    const bundlePath = path.join(tmp, 'fake-cli.js');
    fs.writeFileSync(bundlePath, [
      '#!/usr/bin/env node',
      covKernel.preloadCode,
      'globalThis.__ccpCovHit("live2");',
      'process.exit(0);',
    ].join('\n'), 'utf8');

    const binPath = path.join(REPO_ROOT, 'bin/patch-cli.mjs');
    const result = spawnSync(process.execPath, [
      binPath, 'coverage', bundlePath, '--cc-version', '0.0.2',
    ], { encoding: 'utf8', cwd: tmp });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stdout=${result.stdout}; stderr=${result.stderr}`);
  }));
});
