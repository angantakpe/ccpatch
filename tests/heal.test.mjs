import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readDrift,
  pickTopCandidates,
  rewriteAnchorLiteral,
  proposeHeal,
  runHeal,
} from '../runner/heal.mjs';

// ── Synthetic fixtures ──────────────────────────────────────────────────────

// A small anchors.mjs lookalike with two registry entries.
const ANCHORS_SRC = `export const anchors = {
  isDurableCronEnabled: {
    literal: 'tengu_kairos_cron_durable',
    default: /function (\\w+)/,
  },

  isLoopDynamicEnabled: {
    literal: 'tengu_kairos_loop_dynamic',
    default: /function (\\w+)/,
  },
};
`;

// JSONL drift fixture: one drifted patch with candidates (isDurableCronEnabled),
// one healthy (ok) patch that must be ignored, an older lower-score entry for
// the same drifted patch (must lose to the newer one), and one drifted patch
// whose anchor id is absent from the registry (must be skipped).
const DRIFT_LINES = [
  // Older entry for the cron anchor — lower score, should be superseded.
  {
    ts: '2026-05-25T10:00:00.000Z', type: 'anchor-drift', patch: 'durable_cron',
    status: 'missing', detail: 'old', anchor: { id: 'isDurableCronEnabled' },
    candidates: [{ source: 'verify.present', probe: 'OLD_TOKEN', offset: 1, score: 0.2, snippet: 'x' }],
  },
  // Newer entry — two candidates, the higher score should win.
  {
    ts: '2026-05-27T10:00:00.000Z', type: 'anchor-drift', patch: 'durable_cron',
    status: 'missing', detail: 'count mismatch', anchor: { id: 'isDurableCronEnabled' },
    candidates: [
      { source: 'verify.present', probe: 'tengu_kairos_cron_durable_v2', offset: 4200, score: 0.91, snippet: 'function A(){...}' },
      { source: 'anchor.literal', probe: 'weaker_candidate', offset: 99, score: 0.3, snippet: 'noise' },
    ],
  },
  // Healthy patch — must be ignored entirely.
  {
    ts: '2026-05-27T11:00:00.000Z', type: 'anchor-drift', patch: 'happy', status: 'ok',
    anchor: { id: 'isLoopDynamicEnabled' }, candidates: [{ probe: 'should_not_apply', score: 1.0 }],
  },
  // Drifted patch targeting an unknown registry id — must be skipped.
  {
    ts: '2026-05-27T12:00:00.000Z', type: 'anchor-drift', patch: 'ghost', status: 'drift',
    anchor: { id: 'notInRegistry' },
    candidates: [{ source: 'verify.present', probe: 'ghost_token', offset: 7, score: 0.8, snippet: 'g' }],
  },
];

function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-heal-'));
  const driftPath = path.join(dir, 'anchor-drift.jsonl');
  const anchorsPath = path.join(dir, 'anchors.mjs');
  fs.writeFileSync(driftPath, DRIFT_LINES.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(anchorsPath, ANCHORS_SRC, 'utf8');
  return { dir, driftPath, anchorsPath };
}

describe('readDrift', () => {
  it('parses JSONL, skips blanks, returns [] for a missing file', () => {
    const { driftPath } = writeFixture();
    const entries = readDrift(driftPath);
    assert.equal(entries.length, DRIFT_LINES.length);
    assert.equal(entries[0].patch, 'durable_cron');
    assert.deepEqual(readDrift(path.join(os.tmpdir(), 'does-not-exist-xyz.jsonl')), []);
  });

  it('skips malformed lines without throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-heal-bad-'));
    const p = path.join(dir, 'd.jsonl');
    fs.writeFileSync(p, '{"patch":"a","ts":"1"}\nnot json\n{"patch":"b","ts":"2"}\n', 'utf8');
    assert.equal(readDrift(p).length, 2);
  });
});

describe('pickTopCandidates', () => {
  it('keeps the latest entry per patch and its highest-scoring candidate', () => {
    const picks = pickTopCandidates(DRIFT_LINES);
    const cron = picks.get('durable_cron');
    assert.ok(cron, 'durable_cron should be healable');
    assert.equal(cron.entry.detail, 'count mismatch'); // the newer entry won
    assert.equal(cron.candidate.probe, 'tengu_kairos_cron_durable_v2'); // top score
  });

  it('ignores healthy (status=ok) patches', () => {
    const picks = pickTopCandidates(DRIFT_LINES);
    assert.equal(picks.has('happy'), false);
  });

  it('includes drifted entries even when their registry id is unknown', () => {
    const picks = pickTopCandidates(DRIFT_LINES);
    assert.equal(picks.has('ghost'), true); // skipping happens in proposeHeal
  });
});

describe('rewriteAnchorLiteral', () => {
  it('replaces only the targeted anchor block literal', () => {
    const out = rewriteAnchorLiteral(ANCHORS_SRC, 'isDurableCronEnabled', 'NEW_LITERAL');
    assert.ok(out.includes("literal: \"NEW_LITERAL\""));
    // The sibling anchor must be untouched.
    assert.ok(out.includes("literal: 'tengu_kairos_loop_dynamic'"));
    // The original cron literal must be gone.
    assert.ok(!out.includes("'tengu_kairos_cron_durable'"));
  });

  it('returns null for an unknown anchor id', () => {
    assert.equal(rewriteAnchorLiteral(ANCHORS_SRC, 'notInRegistry', 'X'), null);
  });
});

describe('proposeHeal', () => {
  it('produces a unified diff and change list for drifted-with-candidate anchors', () => {
    const { changes, skipped, diff, newSrc } = proposeHeal(DRIFT_LINES, ANCHORS_SRC);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].id, 'isDurableCronEnabled');
    assert.equal(changes[0].literal, 'tengu_kairos_cron_durable_v2');

    // The unknown-registry patch is reported as skipped, not applied.
    assert.ok(skipped.some(s => s.patch === 'ghost' && /not found/.test(s.reason)));

    // Diff is a real unified diff with the new literal.
    assert.ok(diff.startsWith('--- a/'));
    assert.ok(diff.includes('+++ b/'));
    assert.ok(diff.includes('@@'));
    assert.ok(diff.includes('+    literal: "tengu_kairos_cron_durable_v2",'));
    assert.ok(diff.includes('-    literal: \'tengu_kairos_cron_durable\','));

    // newSrc reflects exactly the change.
    assert.ok(newSrc.includes('tengu_kairos_cron_durable_v2'));
    assert.ok(newSrc.includes("'tengu_kairos_loop_dynamic'"));
  });

  it('returns an empty diff when there is nothing to heal', () => {
    const healthyOnly = [DRIFT_LINES[2]]; // the status=ok entry
    const { diff, changes } = proposeHeal(healthyOnly, ANCHORS_SRC);
    assert.equal(diff, '');
    assert.equal(changes.length, 0);
  });
});

describe('runHeal', () => {
  it('proposes without writing by default', () => {
    const { driftPath, anchorsPath } = writeFixture();
    const res = runHeal({ driftPath, anchorsPath, write: false });
    assert.equal(res.ok, true);
    assert.equal(res.wrote, false);
    assert.equal(res.changes.length, 1);
    assert.ok(res.diff.includes('tengu_kairos_cron_durable_v2'));
    // File must be unchanged on disk.
    assert.equal(fs.readFileSync(anchorsPath, 'utf8'), ANCHORS_SRC);
  });

  it('applies the edit with write:true', () => {
    const { driftPath, anchorsPath } = writeFixture();
    const res = runHeal({ driftPath, anchorsPath, write: true });
    assert.equal(res.wrote, true);
    const after = fs.readFileSync(anchorsPath, 'utf8');
    assert.ok(after.includes('tengu_kairos_cron_durable_v2'));
    assert.ok(!after.includes("'tengu_kairos_cron_durable'"));
    // Re-running against the now-healed file yields nothing to do.
    const again = runHeal({ driftPath, anchorsPath, write: false });
    assert.equal(again.diff, '');
  });

  it('reports an error when the anchors file is missing', () => {
    const { driftPath } = writeFixture();
    const res = runHeal({ driftPath, anchorsPath: path.join(os.tmpdir(), 'nope-anchors.mjs') });
    assert.equal(res.ok, false);
    assert.match(res.error, /not found/);
  });
});
