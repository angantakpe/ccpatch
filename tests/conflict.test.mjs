import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { structuredPatch } from 'diff';
import { applyNamedPatches } from '../runner/runner.mjs';
import { diffSpansFromPatch, resetLineStartsCache } from '../runner/conflict.mjs';
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
  // Priority orders same-phase peers that have no dependency path between them:
  // lower `priority` runs first (default 1000). Here a/b/c are independent
  // same-phase peers with priority 200/100/50, so they apply lowest-first →
  // c, b, a — independent of the enable-list order ['a','b','c'].
  it('orders same-phase peers by priority (lowest first) regardless of input order', async () => {
    const log = [];
    const patches = {
      a: mkPatch({ apply: (c) => { log.push('a'); return c + 'A'; }, verify: { present: 'A', weak: true }, priority: 200 }),
      b: mkPatch({ apply: (c) => { log.push('b'); return c + 'B'; }, verify: { present: 'B', weak: true }, priority: 100 }),
      c: mkPatch({ apply: (c) => { log.push('c'); return c + 'C'; }, verify: { present: 'C', weak: true }, priority: 50 }),
    };
    await applyNamedPatches('x', patches, ['a', 'b', 'c'], silent);
    assert.deepEqual(log, ['c', 'b', 'a']);
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

describe('resetLineStartsCache', () => {
  it('clears the lineStarts cache without affecting subsequent span correctness', () => {
    // Warm the cache, reset it, then confirm spans are still computed correctly.
    const pre = 'x'.repeat(100) + 'ALPHA' + 'y'.repeat(100);
    const post = pre.replace('ALPHA', 'ZZZZZ');
    const sp = structuredPatch('a', 'a', pre, post, '', '', { context: 0 });
    const before = diffSpansFromPatch(pre, sp);
    resetLineStartsCache();
    const after = diffSpansFromPatch(pre, sp);
    assert.deepEqual(after, before);
    assert.doesNotThrow(() => resetLineStartsCache());
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

  it('A2 strict: a multi-site scatter patch + a patch editing inside its envelope do not false-overlap', async () => {
    // Patch a is a SCATTER edit: it touches two distant sites (HEAD and TAIL) on
    // distinct lines, so structuredPatch yields two TIGHT per-hunk spans, not one
    // envelope swallowing everything between them. Patch b edits MID, which sits
    // strictly between a's two real edit sites. With byte-exact per-hunk spans
    // (no over-wide envelope, no imprecise heuristic) b's span never intersects
    // either of a's spans, so strict mode must NOT flag an overlap.
    const code = [
      'aHEADa',
      'x'.repeat(2000),
      'mMIDm',
      'y'.repeat(2000),
      'bTAILb',
    ].join('\n');
    const patches = {
      a: mkPatch({ apply: (c) => c.replace('HEAD', 'HEADZ').replace('TAIL', 'TAILZ'), verify: { present: 'HEADZ', weak: true } }),
      b: mkPatch({ apply: (c) => c.replace('MID', 'MIDZ'), verify: { present: 'MIDZ', weak: true } }),
    };
    const logger = mkLogger();
    const { code: out } = await applyNamedPatches(code, patches, ['a', 'b'], logger, { strict: true });
    assert.ok(out.includes('HEADZ') && out.includes('MIDZ') && out.includes('TAILZ'));
    assert.ok(
      !logger.warnings.some(w => w.includes('[overlap]')),
      `expected no false overlap from scatter patch, got: ${JSON.stringify(logger.warnings)}`,
    );
  });

  it('A2 strict: coordinate translation cancels an earlier insertion so a later same-region edit is judged in the original frame', async () => {
    // Patch a INSERTS a large block on an early line, shifting every byte after
    // it forward by ~len(block) in b's pre-apply frame. Patch b edits a DISTINCT
    // later line. Pre-A2 the detector compared a's pre-frame span against b's
    // post-A (shifted) span without correcting for a's net delta — incidental
    // alignment of those mismatched offsets could manufacture a false overlap.
    // After A2 both spans are translated into the shared original frame
    // (b's span has a's insertion delta subtracted back out), so they're judged
    // on the bytes they truly touched and stay disjoint → no overlap.
    const block = 'Z'.repeat(4000);
    const code = [
      'top INSERT_HERE end',
      'l1', 'l2', 'l3', 'l4', 'l5', 'l6',
      'bottom EDIT_HERE end',
    ].join('\n');
    const patches = {
      a: mkPatch({ apply: (c) => c.replace('INSERT_HERE', 'INSERT_HERE' + block), verify: { present: block, weak: true } }),
      b: mkPatch({ apply: (c) => c.replace('EDIT_HERE', 'EDITED'), verify: { present: 'EDITED', weak: true } }),
    };
    const logger = mkLogger();
    const { code: out } = await applyNamedPatches(code, patches, ['a', 'b'], logger, { strict: true });
    assert.ok(out.includes(block) && out.includes('EDITED'));
    assert.ok(
      !logger.warnings.some(w => w.includes('[overlap]')),
      `expected disjoint edits judged in original frame, got: ${JSON.stringify(logger.warnings)}`,
    );
  });

  it('Finding #5: throws a clear diagnostic when an onBeforeApply hook breaks the additive frame', async () => {
    // Patch a adds 4 bytes (additive: delta +4). Patch b's onBeforeApply then
    // REPLACES ctx.code with an unrelated, differently-sized string — so b's
    // preCode is no longer (original + 4). The shared-frame overlap math would
    // silently mis-translate every span; the runtime invariant must throw instead.
    const patches = {
      a: mkPatch({ apply: (c) => c + 'AAAA', verify: { present: 'AAAA', weak: true } }),
      b: {
        ...mkPatch({ apply: (c) => c + 'B', verify: { present: 'B', weak: true } }),
        // Same phase as `a` so b actually runs after a in the additive frame.
        onBeforeApply(ctx) { ctx.code = 'totally-unrelated-and-different-length'; },
      },
    };
    await assert.rejects(
      () => applyNamedPatches('seedseed', patches, ['a', 'b'], silent),
      /Overlap-frame invariant violated.*additive frame/s,
    );
  });

  it('Finding #5: a same-length onBeforeApply rewrite preserves the additive frame (no throw)', async () => {
    // Replacing ctx.code with a SAME-LENGTH string keeps preCode === original +
    // prior-deltas in length terms, so the additive invariant still holds.
    const patches = {
      a: mkPatch({ apply: (c) => c + 'AAAA', verify: { present: 'AAAA', weak: true } }),
      b: {
        ...mkPatch({ apply: (c) => c + 'B', verify: { present: 'B', weak: true } }),
        onBeforeApply(ctx) { ctx.code = ctx.code.replace('seed', 'SEED'); }, // same length
      },
    };
    await assert.doesNotReject(
      () => applyNamedPatches('seedseed', patches, ['a', 'b'], silent),
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
