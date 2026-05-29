import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { structuredPatch } from 'diff';
import { applyNamedPatches } from '../runner/runner.mjs';
import { diffSpansFromPatch } from '../runner/conflict.mjs';
import { validateManifest } from '../runner/manifest.mjs';

const silent = { log() {}, warn() {}, error() {} };

function mkLogger() {
  const warnings = [];
  return {
    warnings,
    log() {},
    warn(m) { warnings.push(String(m)); },
    error() {},
  };
}

// Build a runnable patch object — verify is required by manifest.
function mkPatch({ description = 't', apply, verify, dependsOn, priority, phase, allowOverlapWith, at } = {}) {
  const p = { description };
  if (apply) p.apply = apply;
  if (verify) p.verify = verify;
  if (dependsOn) p.dependsOn = dependsOn;
  if (priority !== undefined) p.priority = priority;
  if (phase) p.phase = phase;
  if (allowOverlapWith) p.allowOverlapWith = allowOverlapWith;
  if (at) p.at = at;
  return p;
}

describe('manifest — priority', () => {
  it('accepts a finite integer priority', () => {
    const { ok, normalized } = validateManifest(
      { description: 'x', apply: (c) => c + '1', verify: { present: '1', weak: true }, priority: 50 },
      'p.mjs',
    );
    assert.equal(ok, true);
    assert.equal(normalized.priority, 50);
  });

  it('defaults priority to 1000 when omitted', () => {
    const { ok, normalized } = validateManifest(
      { description: 'x', apply: (c) => c + '1', verify: { present: '1', weak: true } },
      'p.mjs',
    );
    assert.equal(ok, true);
    assert.equal(normalized.priority, 1000);
  });

  it('rejects non-integer priority (float)', () => {
    const { ok, errors } = validateManifest(
      { description: 'x', apply: (c) => c + '1', verify: { present: '1', weak: true }, priority: 1.5 },
      'p.mjs',
    );
    assert.equal(ok, false);
    assert.ok(errors.some(e => /priority/.test(e)), errors.join('; '));
  });

  it('rejects non-integer priority (string)', () => {
    const { ok, errors } = validateManifest(
      { description: 'x', apply: (c) => c + '1', verify: { present: '1', weak: true }, priority: '5' },
      'p.mjs',
    );
    assert.equal(ok, false);
    assert.ok(errors.some(e => /priority/.test(e)), errors.join('; '));
  });
});

describe('manifest — allowOverlapWith', () => {
  it('accepts a string array', () => {
    const { ok, normalized } = validateManifest(
      { description: 'x', apply: (c) => c + '1', verify: { present: '1', weak: true }, allowOverlapWith: ['other'] },
      'p.mjs',
    );
    assert.equal(ok, true);
    assert.deepEqual(normalized.allowOverlapWith, ['other']);
  });

  it('rejects non-array', () => {
    const { ok, errors } = validateManifest(
      { description: 'x', apply: (c) => c + '1', verify: { present: '1', weak: true }, allowOverlapWith: 'foo' },
      'p.mjs',
    );
    assert.equal(ok, false);
    assert.ok(errors.some(e => /allowOverlapWith/.test(e)), errors.join('; '));
  });

  it('rejects array containing non-string', () => {
    const { ok, errors } = validateManifest(
      { description: 'x', apply: (c) => c + '1', verify: { present: '1', weak: true }, allowOverlapWith: ['ok', 42] },
      'p.mjs',
    );
    assert.equal(ok, false);
    assert.ok(errors.some(e => /allowOverlapWith/.test(e)), errors.join('; '));
  });
});

describe('applyNamedPatches — ordering', () => {
  // Priority was removed in favor of pure (phase asc, topo index asc).
  // The manifest still accepts `priority` for back-compat but the runner
  // ignores it for ordering decisions.
  it('preserves input/topo order for same-phase peers (priority is no-op)', async () => {
    const log = [];
    const patches = {
      a: mkPatch({ apply: (c) => { log.push('a'); return c + 'A'; }, verify: { present: 'A', weak: true }, priority: 200 }),
      b: mkPatch({ apply: (c) => { log.push('b'); return c + 'B'; }, verify: { present: 'B', weak: true }, priority: 100 }),
      c: mkPatch({ apply: (c) => { log.push('c'); return c + 'C'; }, verify: { present: 'C', weak: true }, priority: 50 }),
    };
    await applyNamedPatches('x', patches, ['a', 'b', 'c'], silent);
    assert.deepEqual(log, ['a', 'b', 'c']);
  });

  it('dependsOn determines order regardless of input order', async () => {
    const log = [];
    const patches = {
      a: mkPatch({ apply: (c) => { log.push('a'); return c + 'A'; }, verify: { present: 'A', weak: true } }),
      b: mkPatch({ apply: (c) => { log.push('b'); return c + 'B'; }, verify: { present: 'B', weak: true }, dependsOn: ['a'] }),
    };
    // Note: input order ['b','a'] — dep edge still forces a before b.
    await applyNamedPatches('x', patches, ['b', 'a'], silent);
    assert.deepEqual(log, ['a', 'b']);
  });
});

describe('diffSpansFromPatch — byte-exact spans', () => {
  it('tightens to the changed bytes inside a very long (minified) line', () => {
    // One newline-free line; the edit sits in the middle. A line-resolution
    // span would report [0, len]; byte-exact must report just the changed run.
    const pre = 'x'.repeat(500) + 'ALPHA' + 'y'.repeat(500);
    const post = pre.replace('ALPHA', 'ZZZZZ');
    const sp = structuredPatch('a', 'a', pre, post, '', '', { context: 0 });
    const spans = diffSpansFromPatch(pre, sp);
    assert.equal(spans.length, 1);
    assert.deepEqual(spans[0], [500, 505]);
  });

  it('strips outer common bytes (two edits on one line collapse to one trimmed span)', () => {
    // Both edits live on a single newline-free line, so `diff` emits ONE hunk;
    // byte-exact trimming removes the shared 200-char prefix and suffix even
    // though the gap between the two edits stays inside the span. The point is
    // the span no longer covers the WHOLE line — that's what kills false overlaps.
    const pre = 'a'.repeat(200) + 'ONE' + 'b'.repeat(2000) + 'TWO' + 'c'.repeat(200);
    const post = pre.replace('ONE', 'XXX').replace('TWO', 'YYY');
    const sp = structuredPatch('a', 'a', pre, post, '', '', { context: 0 });
    const spans = diffSpansFromPatch(pre, sp);
    assert.equal(spans.length, 1);
    assert.deepEqual(spans[0], [200, pre.length - 200]); // outer 200a / 200c excluded
  });

  it('edits on distinct lines produce separate tight spans', () => {
    const pre = ['x'.repeat(50) + 'ONE', 'mid'.repeat(100), 'y'.repeat(50) + 'TWO'].join('\n');
    const post = pre.replace('ONE', 'XXX').replace('TWO', 'YYY');
    const sp = structuredPatch('a', 'a', pre, post, '', '', { context: 0 });
    const spans = diffSpansFromPatch(pre, sp);
    // Two separate hunks → two small spans that don't touch.
    assert.equal(spans.length, 2);
    for (const [s, e] of spans) assert.ok(e - s <= 4, `span too wide: ${e - s}`);
    assert.ok(spans[0][1] < spans[1][0], 'spans should be disjoint');
  });
});

describe('applyNamedPatches — overlap detection', () => {
  it('reports overlap as warning in non-strict mode (does not throw)', async () => {
    const logger = mkLogger();
    const patches = {
      a: mkPatch({ apply: (c) => c.replace('HELLO', 'AAAAA'), verify: { present: 'AAAAA', weak: true } }),
      b: mkPatch({ apply: (c) => c.replace('AAAAA', 'BBBBB').replace('HELLO', 'BBBBB'), verify: { present: 'BBBBB', weak: true } }),
    };
    await assert.doesNotReject(() => applyNamedPatches('xxHELLOxx', patches, ['a', 'b'], logger));
    assert.ok(
      logger.warnings.some(w => w.includes('[overlap]')),
      `expected overlap warning, got: ${JSON.stringify(logger.warnings)}`,
    );
  });

  it('strict mode: overlap without allowOverlapWith is fatal', async () => {
    const patches = {
      a: mkPatch({ apply: (c) => c.replace('HELLO', 'AAAAA'), verify: { present: 'AAAAA', weak: true } }),
      b: mkPatch({ apply: (c) => c.replace('AAAAA', 'BBBBB'), verify: { present: 'BBBBB', weak: true } }),
    };
    await assert.rejects(
      () => applyNamedPatches('xxHELLOxx', patches, ['a', 'b'], silent, { strict: true }),
      /overlap.*a.*b|overlap.*b.*a/,
    );
  });

  it('strict mode: allowOverlapWith on one side suppresses the failure', async () => {
    const logger = mkLogger();
    const patches = {
      a: mkPatch({ apply: (c) => c.replace('HELLO', 'AAAAA'), verify: { present: 'AAAAA', weak: true }, allowOverlapWith: ['b'] }),
      b: mkPatch({ apply: (c) => c.replace('AAAAA', 'BBBBB'), verify: { present: 'BBBBB', weak: true } }),
    };
    await assert.doesNotReject(
      () => applyNamedPatches('xxHELLOxx', patches, ['a', 'b'], logger, { strict: true }),
    );
    // Should still warn (loudly, once), but with the "allowlisted" tag.
    assert.ok(
      logger.warnings.some(w => w.includes('[overlap]') && w.includes('allowlisted')),
      `expected allowlisted overlap warning, got: ${JSON.stringify(logger.warnings)}`,
    );
  });

  it('non-overlapping patches in strict mode pass cleanly', async () => {
    // Spread changes across distinct lines so the line-resolution diff span
    // approximation correctly classifies them as disjoint.
    const code = [
      'line0',
      'TOP',
      'line2',
      'line3',
      'line4',
      'line5',
      'line6',
      'BOT',
      'line8',
    ].join('\n');
    const patches = {
      a: mkPatch({ apply: (c) => c.replace('TOP', 'TOP_A'), verify: { present: 'TOP_A', weak: true } }),
      b: mkPatch({ apply: (c) => c.replace('BOT', 'BOT_B'), verify: { present: 'BOT_B', weak: true } }),
    };
    const { code: out } = await applyNamedPatches(code, patches, ['a', 'b'], silent, { strict: true });
    assert.ok(out.includes('TOP_A') && out.includes('BOT_B'));
  });
});
