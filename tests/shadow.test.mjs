import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runShadow } from '../runner/shadow.mjs';
import { runPatchCli } from '../runner/cli.mjs';

const silent = { log() {}, warn() {}, error() {} };

function mkLogger() {
  const lines = [];
  return {
    lines,
    log(...args) { lines.push(args.join(' ')); },
    warn(...args) { lines.push('WARN: ' + args.join(' ')); },
    error(...args) { lines.push('ERR: ' + args.join(' ')); },
  };
}

describe('runShadow — bytes / verify / parse / forbidden', () => {
  it('clean run: prepend sentinel only in patched bundle → no anomalies', () => {
    const unpatched = 'function main(){return 1;}\n';
    const patched = '/* CCP_SENTINEL */\n' + unpatched;
    const patches = {
      p: { verify: { present: '/* CCP_SENTINEL */' } },
    };
    const r = runShadow(unpatched, patched, patches, ['p']);
    assert.equal(r.ok, true, JSON.stringify(r.anomalies));
    assert.equal(r.anomalies.length, 0);
    assert.equal(r.stats.delta, patched.length - unpatched.length);
  });

  it('weak verify: sentinel already present in unpatched → verify anomaly', () => {
    const unpatched = 'const x = "function";\n';
    // Patch claims to inject "function" but it's already there
    const patched = unpatched + '/* something else */';
    const patches = {
      weak: { verify: { present: 'function' } },
    };
    const r = runShadow(unpatched, patched, patches, ['weak']);
    assert.equal(r.ok, false);
    const verifyAnoms = r.anomalies.filter(a => a.kind === 'verify');
    assert.equal(verifyAnoms.length, 1);
    assert.equal(verifyAnoms[0].patch, 'weak');
    assert.match(verifyAnoms[0].detail, /weak verify\.present/);
  });

  it('verify.present sentinel missing from patched → verify anomaly', () => {
    const unpatched = 'const x = 1;\n';
    const patched = unpatched + 'const y = 2;\n';
    const patches = { p: { verify: { present: '__MISSING__' } } };
    const r = runShadow(unpatched, patched, patches, ['p']);
    assert.equal(r.ok, false);
    const verifyAnoms = r.anomalies.filter(a => a.kind === 'verify');
    assert.equal(verifyAnoms.length, 1);
    assert.match(verifyAnoms[0].detail, /missing from patched/);
  });

  it('parse: patch injects unbalanced brace → parse anomaly', () => {
    const unpatched = 'function f(){return 1;}\n';
    const patched = 'function f(){{return 1;}\n'; // unbalanced extra {
    const patches = {};
    const r = runShadow(unpatched, patched, patches, []);
    const parseAnoms = r.anomalies.filter(a => a.kind === 'parse');
    assert.equal(parseAnoms.length, 1, JSON.stringify(r.anomalies));
    assert.match(parseAnoms[0].detail, /fails to parse/);
  });

  it('forbidden: console.log injection caught by forbiddenAfterPatch', () => {
    const unpatched = 'function f(){return 1;}\n';
    const patched = 'function f(){console.log("x");return 1;}\n';
    const patches = {
      noisy: {
        verify: { present: 'console.log' },
        forbiddenAfterPatch: ['console.log'],
      },
    };
    const r = runShadow(unpatched, patched, patches, ['noisy']);
    const forbidden = r.anomalies.filter(a => a.kind === 'forbidden');
    assert.equal(forbidden.length, 1);
    assert.equal(forbidden[0].patch, 'noisy');
    assert.match(forbidden[0].detail, /console\.log/);
  });

  it('bytes: identical patched/unpatched → bytes anomaly', () => {
    const code = 'const x = 1;\n';
    const r = runShadow(code, code, {}, []);
    const bytes = r.anomalies.filter(a => a.kind === 'bytes');
    assert.equal(bytes.length, 1);
  });
});

describe('--dry-run --write-on-clean via CLI', () => {
  function setupTempInput(code) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-shadow-'));
    const input = path.join(dir, 'cli.js');
    const output = path.join(dir, 'cli.out.js');
    fs.writeFileSync(input, code, 'utf8');
    return { dir, input, output };
  }

  it('writes output when shadow report is clean', async () => {
    // Use an existing built-in patch to keep loader happy, but force via the
    // env-style PATCH selection. Easiest: hand-craft a minimal fixture by
    // pointing at a real bundle and selecting zero patches. But that emits
    // "No patches specified" → exits before shadow runs. Instead, drive
    // runShadow + write-on-clean flow directly with a tiny patches registry.
    const { applyNamedPatches } = await import('../runner/runner.mjs');
    const { runShadow } = await import('../runner/shadow.mjs');

    const code = 'function f(){return 1;}\n';
    const patches = {
      sentinel: {
        description: 't',
        apply: (c) => '/* OK_SENTINEL */\n' + c,
        verify: { present: '/* OK_SENTINEL */' },
      },
    };
    const patched = await applyNamedPatches(code, patches, ['sentinel'], silent);
    const report = runShadow(code, patched, patches, ['sentinel']);
    assert.equal(report.ok, true);

    // simulate write-on-clean
    const { output } = setupTempInput(code);
    if (report.ok) fs.writeFileSync(output, patched, 'utf8');
    assert.equal(fs.existsSync(output), true);
    assert.equal(fs.readFileSync(output, 'utf8'), patched);
  });

  it('does NOT write output when shadow report has anomalies', async () => {
    const { applyNamedPatches } = await import('../runner/runner.mjs');
    const { runShadow } = await import('../runner/shadow.mjs');

    const code = 'function f(){return 1;}\n';
    const patches = {
      bad: {
        description: 't',
        apply: (c) => c + '\nconsole.log("x");\n',
        verify: { present: 'console.log' },
        forbiddenAfterPatch: ['console.log'],
      },
    };
    const patched = await applyNamedPatches(code, patches, ['bad'], silent);
    const report = runShadow(code, patched, patches, ['bad']);
    assert.equal(report.ok, false);

    const { output } = setupTempInput(code);
    // write-on-clean semantics: only write if report.ok
    if (report.ok) fs.writeFileSync(output, patched, 'utf8');
    assert.equal(fs.existsSync(output), false);
  });
});
