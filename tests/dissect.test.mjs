// tests/dissect.test.mjs — unit tests for the structural-analysis primitive
// (runner/dissect.mjs) and its refmap projection.
//
// Coverage:
//   - analyzeBundle: resolves literal anchors; reports AST-only + missing
//     anchors honestly (in misses, not dropped); offset/line/sha shape.
//   - detectFormat / lineAtOffset edge cases.
//   - analysisToRefmap: exact legacy {fn,offset} projection + miss list.
//   - buildRefmap parity: equals analysisToRefmap on the same code.
//   - diffAnalyses: stable / moved / renamed / appeared / vanished / absent.
//   - buildOwnershipMap: joins anchors to shims, flags orphans.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  analyzeBundle,
  analysisToRefmap,
  diffAnalyses,
  buildOwnershipMap,
  detectFormat,
  lineAtOffset,
  anchorIds,
} from '../runner/dissect.mjs';
import { buildRefmap } from '../tools/build-refmap.mjs';
import { resetBundleIndex } from '../runner/ast-anchor.mjs';

// A synthetic bundle: two registry anchors present (cron_durable, loop_dynamic),
// the loop_prompt + plan_mode anchors absent. The minified fn names are chosen
// so we can assert the resolver picks the enclosing function, not a neighbour.
const CRON = 'function Zx9(){return q("tengu_kairos_cron_durable",!0,h)}';
const LOOP = 'function Yk2(){return q("tengu_kairos_loop_dynamic",!1)}';
function bundle(prefix = '') { return `${prefix}${CRON}${LOOP}var tail=1;`; }

describe('detectFormat', () => {
  it('classifies plain JS, ELF, and Mach-O magics', () => {
    assert.equal(detectFormat(Buffer.from('var x=1;')), 'js');
    assert.equal(detectFormat(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0])), 'elf');
    assert.equal(detectFormat(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0])), 'macho');
    assert.equal(detectFormat(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0])), 'macho-fat');
  });
});

describe('lineAtOffset', () => {
  it('returns 1-based line and -1 out of range', () => {
    const s = 'a\nb\nc';
    assert.equal(lineAtOffset(s, 0), 1);
    assert.equal(lineAtOffset(s, 2), 2);
    assert.equal(lineAtOffset(s, 4), 3);
    assert.equal(lineAtOffset(s, -1), -1);
    assert.equal(lineAtOffset(s, 999), -1);
  });
});

describe('analyzeBundle', () => {
  it('resolves present literal anchors and lists absent ones in misses', () => {
    resetBundleIndex();
    const a = analyzeBundle({ code: bundle() }, { ccVersion: '1.2.3' });
    assert.equal(a.ccVersion, '1.2.3');
    assert.equal(a.format, 'js');
    assert.equal(a.native, null);

    const cron = a.anchors.find(r => r.id === 'isDurableCronEnabled');
    assert.equal(cron.status, 'resolved');
    assert.equal(cron.fn, 'Zx9');
    assert.equal(cron.kind, 'literal');
    assert.equal(cron.offset, 0);
    assert.equal(cron.line, 1);

    const loop = a.anchors.find(r => r.id === 'isLoopDynamicEnabled');
    assert.equal(loop.status, 'resolved');
    assert.equal(loop.fn, 'Yk2');
    assert.equal(loop.offset, CRON.length);

    // loop_prompt has a literal but it's absent → missing (not dropped silently)
    const prompt = a.anchors.find(r => r.id === 'isLoopPromptEnabled');
    assert.equal(prompt.status, 'missing');
    assert.equal(prompt.fn, null);
    assert.ok(a.misses.includes('isLoopPromptEnabled'));
  });

  it('reports every registry anchor exactly once, sorted', () => {
    const a = analyzeBundle({ code: bundle() });
    const ids = a.anchors.map(r => r.id);
    assert.deepEqual(ids, anchorIds());
    assert.deepEqual(ids, [...ids].sort());
  });

  it('captures a source window when context > 0', () => {
    const a = analyzeBundle({ code: bundle() }, { context: 10 });
    const cron = a.anchors.find(r => r.id === 'isDurableCronEnabled');
    assert.equal(typeof cron.snippet, 'string');
    assert.ok(cron.snippet.includes('function'));
  });

  it('sha256 + sizeBytes describe the analyzed JS', () => {
    const code = bundle();
    const a = analyzeBundle({ code });
    assert.equal(a.bundleSha256, createHash('sha256').update(code, 'utf8').digest('hex'));
    assert.equal(a.sizeBytes, Buffer.byteLength(code, 'utf8'));
    assert.equal(a.containerBytes, a.sizeBytes);
  });

  it('reads from a path and accepts a buffer', () => {
    const code = bundle();
    const tmp = path.join(os.tmpdir(), `dissect-${process.pid}.js`);
    fs.writeFileSync(tmp, code, 'utf8');
    try {
      const fromPath = analyzeBundle(tmp);
      const fromBuf = analyzeBundle({ buffer: Buffer.from(code, 'utf8') });
      assert.equal(fromPath.bundleSha256, fromBuf.bundleSha256);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('throws on a malformed input', () => {
    assert.throws(() => analyzeBundle(42), TypeError);
    assert.throws(() => analyzeBundle({}), TypeError);
  });
});

describe('analysisToRefmap', () => {
  it('projects resolved anchors to {fn,offset} and collects misses sorted', () => {
    const a = analyzeBundle({ code: bundle() }, { ccVersion: '1.2.3' });
    const rm = analysisToRefmap(a);
    assert.equal(rm.ccVersion, '1.2.3');
    assert.deepEqual(rm.anchors.isDurableCronEnabled, { fn: 'Zx9', offset: 0 });
    assert.deepEqual(rm.anchors.isLoopDynamicEnabled, { fn: 'Yk2', offset: CRON.length });
    assert.ok(!('isLoopPromptEnabled' in rm.anchors));
    assert.deepEqual(rm.misses, [...rm.misses].sort());
    assert.ok(rm.misses.includes('isLoopPromptEnabled'));
  });
});

describe('buildRefmap parity', () => {
  it('equals analysisToRefmap projection (modulo generatedAt)', () => {
    const code = bundle();
    const rm = buildRefmap(code, { ccVersion: '1.2.3', now: () => new Date('2020-01-01T00:00:00Z') });
    const proj = analysisToRefmap(analyzeBundle({ code }, { ccVersion: '1.2.3' }));
    assert.equal(rm.bundleSha256, proj.bundleSha256);
    assert.deepEqual(rm.anchors, proj.anchors);
    assert.deepEqual(rm.misses, proj.misses);
    assert.equal(rm.generatedAt, '2020-01-01T00:00:00.000Z');
  });
});

describe('diffAnalyses', () => {
  it('classifies stable / moved / renamed / vanished / appeared / absent', () => {
    const prev = analyzeBundle({ code: bundle() });
    // new bundle: cron MOVED (10-byte prefix), loop RENAMED (Yk2 → Qb7),
    // both prompt anchors still absent (absent in both).
    const newCode = 'var p=1;' + 'xy' + CRON + LOOP.replace('Yk2', 'Qb7') + 'var t=1;';
    const next = analyzeBundle({ code: newCode });
    const { summary, rows } = diffAnalyses(prev, next);

    const cron = rows.find(r => r.id === 'isDurableCronEnabled');
    assert.equal(cron.change, 'moved');
    assert.equal(cron.offsetDelta, 10);

    const loop = rows.find(r => r.id === 'isLoopDynamicEnabled');
    assert.equal(loop.change, 'renamed');
    assert.equal(loop.from.fn, 'Yk2');
    assert.equal(loop.to.fn, 'Qb7');

    const prompt = rows.find(r => r.id === 'isLoopPromptEnabled');
    assert.equal(prompt.change, 'absent');

    assert.equal(summary.moved, 1);
    assert.equal(summary.renamed, 1);
  });

  it('detects appeared and vanished', () => {
    const withCron = analyzeBundle({ code: CRON });
    const without = analyzeBundle({ code: 'var x=1;' });
    assert.equal(
      diffAnalyses(without, withCron).rows.find(r => r.id === 'isDurableCronEnabled').change,
      'appeared',
    );
    assert.equal(
      diffAnalyses(withCron, without).rows.find(r => r.id === 'isDurableCronEnabled').change,
      'vanished',
    );
  });
});

describe('buildOwnershipMap', () => {
  it('joins anchors to their owning patch/shim and flags orphans', () => {
    const a = analyzeBundle({ code: bundle() });
    const map = buildOwnershipMap(a);

    const cron = map.find(r => r.id === 'isDurableCronEnabled');
    assert.equal(cron.orphan, false);
    assert.ok(cron.owners.some(o => o.shim.endsWith('durable_cron.mjs')));

    // isPlanModeInterviewEnabled is registered but no patch references it yet.
    const orphan = map.find(r => r.id === 'isPlanModeInterviewEnabled');
    assert.equal(orphan.orphan, true);
    assert.deepEqual(orphan.owners, []);
  });
});
