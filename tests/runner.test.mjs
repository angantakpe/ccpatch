import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPatch } from 'diff';
import { applyNamedPatches, topoSort } from '../runner/runner.mjs';

const silent = { log() {}, warn() {}, error() {} };

function mkPatch({ description = 'test', apply, verify, required, dependsOn, priority, phase } = {}) {
  const p = {
    description,
    apply: apply ?? ((c) => c + ' '),
    verify: verify ?? { present: '', weak: true },
  };
  if (required) p.required = required;
  if (dependsOn) p.dependsOn = dependsOn;
  if (priority !== undefined) p.priority = priority;
  if (phase) p.phase = phase;
  return p;
}

describe('topoSort', () => {
  it('orders simple chain by dependsOn', () => {
    const patches = {
      a: mkPatch(),
      b: mkPatch({ dependsOn: ['a'] }),
      c: mkPatch({ dependsOn: ['b'] }),
    };
    assert.deepEqual(topoSort(['c', 'b', 'a'], patches), ['a', 'b', 'c']);
  });

  it('throws on unknown dependsOn (typo)', () => {
    const patches = { a: mkPatch({ dependsOn: ['ghost'] }) };
    assert.throws(
      () => topoSort(['a'], patches),
      /declares dependsOn "ghost".*no such patch is loaded/,
    );
  });

  it('throws when dep exists on disk but is not enabled', () => {
    const patches = {
      foundation: mkPatch(),
      extension: mkPatch({ dependsOn: ['foundation'] }),
    };
    assert.throws(
      () => topoSort(['extension'], patches),
      /requires "foundation".*not enabled/,
    );
  });

  it('throws on circular dependency', () => {
    const patches = {
      a: mkPatch({ dependsOn: ['b'] }),
      b: mkPatch({ dependsOn: ['a'] }),
    };
    assert.throws(
      () => topoSort(['a', 'b'], patches),
      /Circular patch dependency/,
    );
  });
});

describe('applyNamedPatches — priority ordering', () => {
  it('orders same-phase no-dep peers by priority (lowest first)', async () => {
    // Enabled as ['a','b','c'] but priorities 30/10/20 — with no deps and the
    // same (default) phase, lower priority runs first → b (10), c (20), a (30).
    const log = [];
    const patches = {
      a: mkPatch({ apply: (c) => { log.push('a'); return c + 'A'; }, verify: { present: 'A', weak: true }, priority: 30 }),
      b: mkPatch({ apply: (c) => { log.push('b'); return c + 'B'; }, verify: { present: 'B', weak: true }, priority: 10 }),
      c: mkPatch({ apply: (c) => { log.push('c'); return c + 'C'; }, verify: { present: 'C', weak: true }, priority: 20 }),
    };
    await applyNamedPatches('x', patches, ['a', 'b', 'c'], silent);
    assert.deepEqual(log, ['b', 'c', 'a']);
  });

  it('priority cannot override a dependency edge', async () => {
    // B dependsOn A. A "wants" to go last (priority 5000), B "wants" to go first
    // (priority 1), but the dependsOn edge dominates priority → A still applies
    // before B.
    const log = [];
    const patches = {
      a: mkPatch({ apply: (c) => { log.push('a'); return c + 'A'; }, verify: { present: 'A', weak: true }, priority: 5000 }),
      b: mkPatch({ apply: (c) => { log.push('b'); return c + 'B'; }, verify: { present: 'B', weak: true }, priority: 1, dependsOn: ['a'] }),
    };
    await applyNamedPatches('x', patches, ['a', 'b'], silent);
    assert.deepEqual(log, ['a', 'b']);
  });
});

describe('applyNamedPatches — non-strict (default)', () => {
  it('warns but does not throw on no-change', async () => {
    const patches = { noop: mkPatch({ apply: (c) => c }) };
    const { code } = await applyNamedPatches('hello', patches, ['noop'], silent);
    assert.equal(code, 'hello');
  });

  it('swallows apply() errors and continues', async () => {
    const patches = {
      bad:  mkPatch({ apply: () => { throw new Error('boom'); } }),
      good: mkPatch({ apply: (c) => c + '+good' }),
    };
    const { code } = await applyNamedPatches('x', patches, ['bad', 'good'], silent);
    assert.equal(code, 'x+good');
  });

  it('warns on verify failures but does not throw', async () => {
    const patches = {
      p: { description: 't', apply: (c) => c + '!', verify: { present: 'NOT-THERE', weak: true } },
    };
    await assert.doesNotReject(() => applyNamedPatches('x', patches, ['p'], silent));
  });
});

describe('applyNamedPatches — Finding #1: no-op with verify.present is fatal by default', () => {
  function mkLogger() {
    const warnings = [];
    return { warnings, log() {}, warn(m) { warnings.push(String(m)); }, error() {} };
  }

  it('throws by DEFAULT when a verify.present patch produces no change', async () => {
    const patches = {
      drifted: { description: 't', apply: (c) => c, verify: { present: 'WANTED', weak: true } },
    };
    await assert.rejects(
      () => applyNamedPatches('x', patches, ['drifted'], silent),
      /default mode|no-change/,
    );
  });

  it('--best-effort downgrades the verify.present no-op back to a warn (no throw)', async () => {
    const patches = {
      drifted: { description: 't', apply: (c) => c, verify: { present: 'WANTED', weak: true } },
    };
    const logger = mkLogger();
    const { code, results } = await applyNamedPatches('x', patches, ['drifted'], logger, { bestEffort: true });
    assert.equal(code, 'x');
    assert.equal(results.drifted, 'no-change');
    assert.ok(logger.warnings.some(w => w.includes('produced no changes')));
  });

  it('a no-op patch with ONLY verify.absent stays a non-fatal no-change by default', async () => {
    const patches = {
      clean: { description: 't', apply: (c) => c, verify: { absent: 'BAD' } },
    };
    const { code, results } = await applyNamedPatches('x', patches, ['clean'], silent);
    assert.equal(code, 'x');
    assert.equal(results.clean, 'no-change-ok');
  });

  it('an EMPTY verify.present ("") is not a real present assertion — no-op stays non-fatal', async () => {
    const patches = {
      noop: { description: 't', apply: (c) => c, verify: { present: '', weak: true } },
    };
    const { code, results } = await applyNamedPatches('hello', patches, ['noop'], silent);
    assert.equal(code, 'hello');
    assert.equal(results.noop, 'no-change');
  });

  it('report.noChange counts no-op patches (best-effort)', async () => {
    const patches = {
      a: { description: 't', apply: (c) => c, verify: { present: 'WANTED', weak: true } }, // no-change
      b: { description: 't', apply: (c) => c + 'B', verify: { present: 'B', weak: true } }, // applied
    };
    const { report } = await applyNamedPatches('x', patches, ['a', 'b'], silent, { bestEffort: true });
    assert.equal(report.noChange, 1);
  });
});

describe('applyNamedPatches — Finding #2: applied-fallback is loud and counted', () => {
  function mkLogger() {
    const warnings = [];
    return { warnings, log() {}, warn(m) { warnings.push(String(m)); }, error() {} };
  }

  // Build a unified diff that transforms `before` -> `after`.
  function fallbackFor(before, after) {
    return createPatch('fixture.js', before, after, 'before', 'after');
  }

  it('default mode: stale fallback applies, warns loudly, and is counted', async () => {
    const before = 'line1\nline2\nline3\n';
    const after  = 'line1\nline2-CHANGED\nline3\n';
    const patches = {
      drifted: {
        description: 't',
        apply: (c) => c, // anchor missed
        verify: { present: 'line2-CHANGED', weak: true },
        fallbackDiff: { patch: fallbackFor(before, after), capturedAgainst: '2.1.148' },
      },
    };
    const logger = mkLogger();
    const { code, results, report } = await applyNamedPatches(before, patches, ['drifted'], logger);
    assert.equal(code, after);
    assert.equal(results.drifted, 'applied-fallback');
    assert.equal(report.appliedFallback, 1);
    assert.ok(
      logger.warnings.some(w => w.includes('STALE FALLBACK DIFF')),
      `expected loud stale-fallback warning, got: ${JSON.stringify(logger.warnings)}`,
    );
  });

  it('strict mode: a stale-fallback apply is FATAL', async () => {
    const before = 'line1\nline2\nline3\n';
    const after  = 'line1\nline2-CHANGED\nline3\n';
    const patches = {
      drifted: {
        description: 't',
        apply: (c) => c,
        verify: { present: 'line2-CHANGED', weak: true },
        fallbackDiff: { patch: fallbackFor(before, after), capturedAgainst: '2.1.148' },
      },
    };
    await assert.rejects(
      () => applyNamedPatches(before, patches, ['drifted'], silent, { strict: true, version: '2.1.148' }),
      /stale fallback diff/,
    );
  });
});

describe('applyNamedPatches — strict mode', () => {
  const opts = { strict: true };

  it('throws on no-change', async () => {
    const patches = { noop: mkPatch({ apply: (c) => c }) };
    await assert.rejects(
      () => applyNamedPatches('x', patches, ['noop'], silent, opts),
      /strict mode[\s\S]*no-change/,
    );
  });

  it('throws when apply() returns non-string', async () => {
    const patches = { weird: mkPatch({ apply: () => 42 }) };
    await assert.rejects(
      () => applyNamedPatches('x', patches, ['weird'], silent, opts),
      /non-string/,
    );
  });

  it('throws when apply() throws', async () => {
    const patches = { bad: mkPatch({ apply: () => { throw new Error('boom'); } }) };
    await assert.rejects(
      () => applyNamedPatches('x', patches, ['bad'], silent, opts),
      /apply\(\) threw: boom/,
    );
  });

  it('throws on verify.present miss', async () => {
    const patches = {
      p: { description: 't', apply: (c) => c + '!', verify: { present: 'NOT-THERE', weak: true } },
    };
    await assert.rejects(
      () => applyNamedPatches('x', patches, ['p'], silent, opts),
      /verify.*present.*NOT-THERE/,
    );
  });

  it('throws on verify.absent hit', async () => {
    const patches = {
      p: { description: 't', apply: (c) => c + 'FORBIDDEN', verify: { absent: 'FORBIDDEN' } },
    };
    await assert.rejects(
      () => applyNamedPatches('x', patches, ['p'], silent, opts),
      /verify.*absent.*FORBIDDEN/,
    );
  });

  it('aggregates multiple failures into one error', async () => {
    const patches = {
      a: mkPatch({ apply: (c) => c }),
      b: mkPatch({ apply: () => { throw new Error('nope'); } }),
    };
    let err;
    try { await applyNamedPatches('x', patches, ['a', 'b'], silent, opts); }
    catch (e) { err = e; }
    assert.ok(err, 'expected throw');
    assert.match(err.message, /2 patch failure\(s\)/);
    assert.match(err.message, /a: no-change/);
    assert.match(err.message, /b: apply\(\) threw/);
  });

  it('passes when every patch applies cleanly', async () => {
    const patches = {
      a: { ...mkPatch({ apply: (c) => c + '1' }), allowOverlapWith: ['b'] },
      b: { ...mkPatch({ apply: (c) => c + '2' }), allowOverlapWith: ['a'] },
    };
    const { code } = await applyNamedPatches('x', patches, ['a', 'b'], silent, opts);
    assert.equal(code, 'x12');
  });

  it('returns { code, results, report } with timings populated', async () => {
    const patches = {
      a: mkPatch({ apply: (c) => c + 'A', verify: { present: 'A', weak: true } }),
      b: mkPatch({ apply: (c) => c + 'B', verify: { present: 'B', weak: true } }),
    };
    const ret = await applyNamedPatches('x', patches, ['a', 'b'], silent);
    assert.equal(ret.code, 'xAB');
    assert.equal(ret.results.a, 'applied');
    assert.equal(ret.results.b, 'applied');
    assert.ok(Array.isArray(ret.report.timings));
    assert.equal(ret.report.timings.length, 2);
    assert.ok(ret.report.timings.every(t => typeof t.name === 'string' && typeof t.ms === 'number'));
    assert.ok(Array.isArray(ret.report.drifts));
    assert.ok(Array.isArray(ret.report.verifyIssues));
  });
});

describe('applyNamedPatches — required: true (per-patch strict)', () => {
  it('throws on no-change for required patch even without global strict', async () => {
    const patches = { core: mkPatch({ apply: (c) => c, required: true }) };
    await assert.rejects(
      () => applyNamedPatches('x', patches, ['core'], silent),
      /required patches[\s\S]*no-change/,
    );
  });

  it('non-required patches still skipped silently when required passes', async () => {
    const patches = {
      core: mkPatch({ apply: (c) => c + '+core', required: true }),
      opt:  mkPatch({ apply: (c) => c }),
    };
    const { code } = await applyNamedPatches('x', patches, ['core', 'opt'], silent);
    assert.equal(code, 'x+core');
  });
});

describe('applyNamedPatches — revisit markers', () => {
  function mkLogger() {
    const warnings = [];
    return {
      warnings,
      log() {},
      warn(msg) { warnings.push(msg); },
      error() {},
    };
  }

  it('emits [revisit] warning when bundle version >= revisit.until', async () => {
    const patches = {
      forensic: {
        ...mkPatch({ apply: (c) => c + '+f' }),
        revisit: { note: 'check normalizer', addedIn: '2.1.131', until: '2.1.148' },
      },
    };
    const logger = mkLogger();
    await applyNamedPatches('x', patches, ['forensic'], logger, { version: '2.1.148' });
    assert.ok(
      logger.warnings.some(w => w.includes('[revisit] forensic') && w.includes('2.1.148')),
      `expected revisit warning, got: ${JSON.stringify(logger.warnings)}`,
    );
  });

  it('does not warn when bundle version < revisit.until', async () => {
    const patches = {
      forensic: {
        ...mkPatch({ apply: (c) => c + '+f' }),
        revisit: { note: 'x', until: '2.2.0' },
      },
    };
    const logger = mkLogger();
    await applyNamedPatches('x', patches, ['forensic'], logger, { version: '2.1.148' });
    assert.ok(
      !logger.warnings.some(w => w.includes('[revisit]')),
      `unexpected revisit warning: ${JSON.stringify(logger.warnings)}`,
    );
  });

  it('does not warn when patchOptions.version is missing', async () => {
    const patches = {
      forensic: {
        ...mkPatch({ apply: (c) => c + '+f' }),
        revisit: { note: 'x', until: '2.1.148' },
      },
    };
    const logger = mkLogger();
    await applyNamedPatches('x', patches, ['forensic'], logger);
    assert.ok(
      !logger.warnings.some(w => w.includes('[revisit]')),
      `unexpected revisit warning: ${JSON.stringify(logger.warnings)}`,
    );
  });
});

describe('apply-state — artifactsDegraded + string-identity dev guard', () => {
  // A storageRoot whose `storage` entry is a FILE makes every sidecar
  // mkdirSync throw ENOTDIR — deterministic artifact-write failure injection.
  function brokenStorageRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-runner-broken-'));
    fs.writeFileSync(path.join(dir, 'storage'), 'not a directory', 'utf8');
    return dir;
  }

  it('report.artifactsDegraded lists failed sidecar writes (run still succeeds)', async () => {
    const dir = brokenStorageRoot();
    const patches = {
      // No-op with a real verify.present → triggers the anchor-drift.jsonl
      // write; bestEffort downgrades the no-op from fatal so the run returns.
      noop: { description: 't', apply: (c) => c, verify: { present: 'WANTED', weak: true } },
    };
    const { report } = await applyNamedPatches('x', patches, ['noop'], silent, {
      bestEffort: true, storageRoot: dir,
    });
    assert.ok(Array.isArray(report.artifactsDegraded), 'artifactsDegraded present');
    const labels = report.artifactsDegraded.map(f => f.artifact);
    assert.ok(labels.includes('anchor-drift.jsonl'), `got: ${labels.join(', ')}`);
    assert.ok(labels.includes('coverage-apply manifest'), `got: ${labels.join(', ')}`);
    for (const f of report.artifactsDegraded) assert.equal(typeof f.error, 'string');
  });

  it('happy path: report.artifactsDegraded is absent', async () => {
    const okDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-runner-ok-'));
    const patches = { a: mkPatch({ apply: (c) => c + 'A', verify: { present: 'A', weak: true } }) };
    const { report } = await applyNamedPatches('x', patches, ['a'], silent, { storageRoot: okDir });
    assert.ok(!('artifactsDegraded' in report), 'field must be absent when nothing failed');
  });

  it('CCPATCH_DEBUG string-identity guard stays quiet on a normal run (incl. onBeforeApply rewrites)', async () => {
    const prev = process.env.CCPATCH_DEBUG;
    process.env.CCPATCH_DEBUG = '1';
    try {
      const patches = {
        a: mkPatch({ apply: (c) => c + 'A', verify: { present: 'A', weak: true } }),
        // Length-preserving ctx.code rewrite: a FRESH string reference, which
        // the guard must tolerate because an onBeforeApply hook explains it.
        hooky: {
          description: 't',
          apply: (c) => c + 'B',
          verify: { present: 'B', weak: true },
          onBeforeApply(ctx) { ctx.code = ctx.code.split('').join(''); },
        },
        // Next patch threads run.nextCode by reference again — guard holds.
        b: mkPatch({ apply: (c) => c + 'C', verify: { present: 'C', weak: true } }),
      };
      const { code, results } = await applyNamedPatches('x', patches, ['a', 'hooky', 'b'], silent);
      assert.equal(code, 'xABC');
      assert.deepEqual(results, { a: 'applied', hooky: 'applied', b: 'applied' });
    } finally {
      if (prev === undefined) delete process.env.CCPATCH_DEBUG;
      else process.env.CCPATCH_DEBUG = prev;
    }
  });
});
