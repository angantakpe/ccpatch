import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPatch } from 'diff';
import {
  applyFallbackDiff,
  detectDrift,
} from '../runner/apply-pipeline.mjs';
import {
  makeStorageWarnOnce,
  writeConflictsArtifact,
  writeApplyArtifacts,
} from '../runner/apply-artifacts.mjs';
import { buildJsonReport, renderTextSummary } from '../runner/cli/build-report.mjs';

function mkLogger() {
  const entries = { log: [], warn: [], error: [] };
  return {
    entries,
    log:   (...a) => { entries.log.push(a.join(' ')); },
    warn:  (...a) => { entries.warn.push(a.join(' ')); },
    error: (...a) => { entries.error.push(a.join(' ')); },
  };
}

describe('ARCH1 helper — applyFallbackDiff', () => {
  it('returns null when no fallbackDiff is declared', () => {
    const logger = mkLogger();
    assert.equal(applyFallbackDiff('x', {}, 'p', {}, logger), null);
    assert.equal(logger.entries.log.length, 0);
  });

  it('returns null (and does nothing) when patchOptions.disableFallback', () => {
    const logger = mkLogger();
    const fd = { patch: createPatch('f', 'a\n', 'b\n'), capturedAgainst: '1.0.0' };
    const out = applyFallbackDiff('a\n', { fallbackDiff: fd }, 'p', { disableFallback: true }, logger);
    assert.equal(out, null);
  });

  it('applies the stored diff and logs success', () => {
    const before = 'line1\nline2\nline3\n';
    const after  = 'line1\nline2-CHANGED\nline3\n';
    const fd = { patch: createPatch('f', before, after), capturedAgainst: '2.1.148' };
    const logger = mkLogger();
    const out = applyFallbackDiff(before, { fallbackDiff: fd }, 'drifted', {}, logger);
    assert.equal(out, after);
    assert.ok(logger.entries.log.some(l => l.includes('[fallback] drifted: stored-diff applied')));
  });

  it('returns null and warns when the diff does not apply', () => {
    const fd = { patch: createPatch('f', 'totally\ndifferent\n', 'x\ny\n'), capturedAgainst: '9.9.9' };
    const logger = mkLogger();
    const out = applyFallbackDiff('unrelated content here\n', { fallbackDiff: fd }, 'p', {}, logger);
    assert.equal(out, null);
    assert.ok(logger.entries.warn.some(w => w.includes('did not apply')));
  });

  it('honors a custom fuzz factor (no throw)', () => {
    const before = 'a\nb\nc\n';
    const after  = 'a\nB\nc\n';
    const fd = { patch: createPatch('f', before, after), capturedAgainst: '1', fuzz: 0 };
    const logger = mkLogger();
    const out = applyFallbackDiff(before, { fallbackDiff: fd }, 'p', {}, logger);
    assert.equal(out, after);
  });
});

describe('ARCH1 helper — detectDrift', () => {
  it('surfaces candidates from verify.present probes and computes verify_failed', () => {
    const preCode = 'const foo = makeWidget(opts);\n';
    const normalized = { verify: { present: 'makeWidgetWrapped(opts)' } };
    const { candidates, verifyFailed, probesCount, alertLine } =
      detectDrift(preCode, normalized, 'widgetwrap', { version: '2.1.148' });
    assert.ok(probesCount >= 1);
    // The present string is NOT in preCode, so verify_failed records it.
    assert.ok(verifyFailed.some(v => v.startsWith('verify.present missing:')));
    // alertLine is valid JSON with the expected shape.
    const parsed = JSON.parse(alertLine);
    assert.equal(parsed.type, 'anchor-drift');
    assert.equal(parsed.patch, 'widgetwrap');
    assert.equal(parsed.version, '2.1.148');
    assert.ok(Array.isArray(candidates));
  });

  it('records verify.absent still-present failures', () => {
    const preCode = 'badPattern(); ok();\n';
    const normalized = { verify: { absent: 'badPattern()' } };
    const { verifyFailed } = detectDrift(preCode, normalized, 'p', {});
    assert.ok(verifyFailed.some(v => v.startsWith('verify.absent still present:')));
  });

  it('caps candidates at 3 and prefers anchor.literal first', () => {
    const preCode = 'aaaa bbbb cccc dddd eeee\n'.repeat(40);
    const normalized = {
      anchor: { literal: 'aaaa' },
      verify: { present: ['bbbb', 'cccc'], absent: ['dddd'] },
    };
    const { candidates, probesCount } = detectDrift(preCode, normalized, 'p', {});
    assert.ok(probesCount >= 4);
    assert.ok(candidates.length <= 3);
    if (candidates.length) assert.equal(candidates[0].source, 'anchor.literal');
  });

  it('reports zero probes when nothing stable is declared', () => {
    const { probesCount, candidates } = detectDrift('whatever\n', { verify: {} }, 'p', {});
    assert.equal(probesCount, 0);
    assert.equal(candidates.length, 0);
  });
});

describe('ARCH1 helper — writeConflictsArtifact / writeApplyArtifacts', () => {
  function withTmpCwd(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-helpers-'));
    const prev = process.cwd();
    process.chdir(dir);
    try { return fn(dir); } finally { process.chdir(prev); }
  }

  it('writeConflictsArtifact appends JSONL only when conflicts exist', () => {
    withTmpCwd((dir) => {
      writeConflictsArtifact([], undefined, dir);
      assert.equal(fs.existsSync(path.join(dir, 'storage/outputs/patch-conflicts.jsonl')), false);
      writeConflictsArtifact([{ a: 'x', b: 'y' }], undefined, dir);
      const txt = fs.readFileSync(path.join(dir, 'storage/outputs/patch-conflicts.jsonl'), 'utf8');
      assert.ok(txt.includes('"a":"x"'));
    });
  });

  it('writeApplyArtifacts emits coverage manifest and (when versioned) results catalog with resolved variant', () => {
    withTmpCwd((dir) => {
      const results = { p1: 'applied', p2: 'no-change' };
      const patches = { p1: { coverageMarker: 'M1' }, p2: {} };
      const phaseTraces = { pre: [], main: [{ name: 'p1', diffSpans: [[0, 1]] }], post: [] };
      const logger = mkLogger();
      writeApplyArtifacts({
        results, patches, phaseTraces,
        patchOptions: { version: '2.1.148' },
        phaseOf: () => 'main',
        logger,
        storageRoot: dir,
      });
      const cov = JSON.parse(fs.readFileSync(path.join(dir, 'storage/outputs/coverage-apply-v2.1.148.json'), 'utf8'));
      assert.equal(cov.ccVersion, '2.1.148');
      assert.equal(cov.patches.p1.applied, true);
      assert.equal(cov.patches.p1.diffSpans, 1);
      assert.equal(cov.patches.p1.coverageMarker, 'M1');
      assert.equal(cov.patches.p2.reason, 'no-change');
      const res = JSON.parse(fs.readFileSync(path.join(dir, 'storage/outputs/patch-results-v2.1.148.json'), 'utf8'));
      // Unknown modules (not loaded via loadPatches) default to 'default' variant.
      assert.equal(res.patches.p1.resolvedVariant, 'default');
      assert.equal(res.patches.p1.status, 'applied');
    });
  });

  it('writeApplyArtifacts skips the results catalog when version is absent', () => {
    withTmpCwd((dir) => {
      writeApplyArtifacts({
        results: { p1: 'applied' },
        patches: { p1: {} },
        phaseTraces: { pre: [], main: [], post: [] },
        patchOptions: {},
        phaseOf: () => 'main',
        logger: mkLogger(),
        storageRoot: dir,
      });
      assert.ok(fs.existsSync(path.join(dir, 'storage/outputs/coverage-apply-unknown.json')));
      const files = fs.readdirSync(path.join(dir, 'storage/outputs'));
      assert.ok(!files.some(f => f.startsWith('patch-results-')));
    });
  });
});

describe('Task 4 — artifact-write failure surfacing', () => {
  // A storageRoot whose `storage` entry is a FILE makes mkdirSync throw
  // ENOTDIR for every sidecar write — a deterministic failure injection.
  function withBrokenStorage(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-broken-'));
    fs.writeFileSync(path.join(dir, 'storage'), 'not a directory', 'utf8');
    return fn(dir);
  }

  it('makeStorageWarnOnce warns once but collects every distinct artifact label', () => {
    const logger = mkLogger();
    const warnOnce = makeStorageWarnOnce(logger);
    warnOnce('first.jsonl', new Error('boom1'));
    warnOnce('first.jsonl', new Error('boom1-again')); // deduped by label
    warnOnce('second.json', new Error('boom2'));
    assert.equal(logger.entries.warn.length, 1, 'only the first failure logs');
    assert.deepEqual(warnOnce.failures, [
      { artifact: 'first.jsonl', error: 'boom1' },
      { artifact: 'second.json', error: 'boom2' },
    ]);
  });

  it('writeConflictsArtifact returns true on success/no-op, false on failure', () => {
    const okDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-ok-'));
    assert.equal(writeConflictsArtifact([], undefined, okDir), true);
    assert.equal(writeConflictsArtifact([{ a: 'x', b: 'y' }], undefined, okDir), true);
    withBrokenStorage((dir) => {
      const warnOnce = makeStorageWarnOnce(mkLogger());
      assert.equal(writeConflictsArtifact([{ a: 'x', b: 'y' }], warnOnce, dir), false);
      assert.equal(warnOnce.failures[0].artifact, 'patch-conflicts.jsonl');
    });
  });

  it('writeApplyArtifacts returns the failed artifact labels', () => {
    withBrokenStorage((dir) => {
      const warnOnce = makeStorageWarnOnce(mkLogger());
      const { failed } = writeApplyArtifacts({
        results: { p1: 'applied' },
        patches: { p1: {} },
        phaseTraces: { pre: [], main: [], post: [] },
        patchOptions: { version: '9.9.9' },
        phaseOf: () => 'main',
        logger: mkLogger(),
        warnStorageOnce: warnOnce,
        storageRoot: dir,
      });
      assert.deepEqual(failed, ['coverage-apply manifest', 'patch-results catalog']);
      assert.deepEqual(warnOnce.failures.map(f => f.artifact), failed);
    });
    // Happy path: nothing failed.
    const okDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-ok2-'));
    const { failed } = writeApplyArtifacts({
      results: { p1: 'applied' },
      patches: { p1: {} },
      phaseTraces: { pre: [], main: [], post: [] },
      patchOptions: {},
      phaseOf: () => 'main',
      logger: mkLogger(),
      storageRoot: okDir,
    });
    assert.deepEqual(failed, []);
  });

  it('buildJsonReport surfaces artifactsDegraded only when present', () => {
    const base = { ok: true, durationMs: 10, patchNames: ['p1'] };
    const clean = buildJsonReport({ ...base, report: {} });
    assert.ok(!('artifactsDegraded' in clean), 'happy path: field absent');
    const degraded = buildJsonReport({
      ...base,
      report: { artifactsDegraded: [{ artifact: 'anchor-drift.jsonl', error: 'ENOTDIR' }] },
    });
    assert.deepEqual(degraded.artifactsDegraded, [
      { artifact: 'anchor-drift.jsonl', error: 'ENOTDIR' },
    ]);
  });

  it('renderTextSummary lists failed artifacts; happy path output unchanged', () => {
    const base = { ok: true, durationMs: 10, outputPath: null, drySuggest: false };
    const clean = renderTextSummary({ ...base, report: {} });
    assert.ok(!clean.includes('Artifacts degraded'));
    const degraded = renderTextSummary({
      ...base,
      report: {
        artifactsDegraded: [
          { artifact: 'patch-conflicts.jsonl', error: 'ENOTDIR' },
          { artifact: 'coverage-apply manifest', error: 'ENOTDIR' },
        ],
      },
    });
    assert.ok(degraded.includes('Artifacts degraded'));
    assert.ok(degraded.includes('patch-conflicts.jsonl'));
    assert.ok(degraded.includes('coverage-apply manifest'));
  });
});
