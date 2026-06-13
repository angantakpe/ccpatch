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
  findExtinct,
  healNextLine,
} from '../runner/heal.mjs';
import { buildDriftRecord, isExtinctEntry, EXTINCT_STATUS } from '../runner/drift-record.mjs';
import { formatSuggestion } from '../runner/cli/doctor-suggest.mjs';

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

// ── Anchor extinction (THREAT_MODEL.md "anchor extinction") ─────────────────
//
// When every probe (anchor.literal + verify.present + verify.absent) yields
// ZERO fuzzy candidates, the anchor literal has vanished from the bundle.
// buildDriftRecord must classify that as extinct (status 'extinct' + additive
// `extinct: true` field), and heal/doctor-suggest must surface it distinctly
// instead of letting it look like ordinary no-candidate drift.

describe('buildDriftRecord — extinct classification', () => {
  // Bundle text that contains NONE of the probe tokens below.
  const EMPTY_BUNDLE = 'function zz(){return 1}\n'.repeat(20);
  // Bundle text that DOES contain a near-miss of the literal (drift, not extinct).
  const NEARBY_BUNDLE = 'var q = X("tengu_kairos_cron_durable_v3", !0);\n' + EMPTY_BUNDLE;

  it('promotes a supplied doctor status to "extinct" when zero candidates are found', () => {
    const { record, extinct, candidates } = buildDriftRecord(
      EMPTY_BUNDLE,
      { literal: 'tengu_kairos_cron_durable', present: 'some_marker_token' },
      { source: 'doctor', patchName: 'durable_cron', version: '9.9.9', status: 'missing', detail: 'gone' },
    );
    assert.equal(candidates.length, 0);
    assert.equal(extinct, true);
    assert.equal(record.status, EXTINCT_STATUS);
    assert.equal(record.extinct, true);          // additive forensics field
    assert.equal(record.detail, 'gone');         // original detail preserved
    assert.equal(isExtinctEntry(record), true);
  });

  it('keeps the supplied status when fuzzy candidates exist (ordinary drift)', () => {
    const { record, extinct } = buildDriftRecord(
      NEARBY_BUNDLE,
      { literal: 'tengu_kairos_cron_durable' },
      { source: 'doctor', patchName: 'durable_cron', status: 'missing', detail: 'gone' },
    );
    assert.equal(extinct, false);
    assert.equal(record.status, 'missing');
    assert.equal('extinct' in record, false, 'non-extinct records stay byte-compatible (no extinct field)');
    assert.equal(isExtinctEntry(record), false);
  });

  it('marks runner-style records (no status field) with the additive flag only', () => {
    const { record, extinct } = buildDriftRecord(
      EMPTY_BUNDLE,
      { literal: 'tengu_kairos_cron_durable' },
      { patchName: 'durable_cron', version: null },
    );
    assert.equal(extinct, true);
    assert.equal('status' in record, false, 'runner records never carried status — still must not');
    assert.equal(record.extinct, true);
    assert.equal(isExtinctEntry(record), true);
  });

  it('does not claim extinction when there were no usable probes at all', () => {
    const { record, extinct, probesCount } = buildDriftRecord(
      EMPTY_BUNDLE,
      {},                                       // no literal, no verify strings
      { patchName: 'unprobeable' },
    );
    assert.equal(probesCount, 0);
    assert.equal(extinct, false);
    assert.equal('extinct' in record, false);
  });
});

describe('heal — extinct anchors are surfaced, not silently dropped', () => {
  const EXTINCT_ENTRY = {
    ts: '2026-06-01T00:00:00.000Z', type: 'anchor-drift', source: 'doctor',
    patch: 'vanished_patch', version: '9.9.9', status: 'extinct', detail: 'anchor gone',
    anchor: { id: 'isDurableCronEnabled' }, candidates: [], verify_failed: [], extinct: true,
  };
  // Legacy extinct record (pre-status-promotion): additive flag only.
  const EXTINCT_LEGACY = {
    ts: '2026-06-01T00:00:00.000Z', type: 'anchor-drift',
    patch: 'legacy_vanished', status: 'missing',
    anchor: { id: 'isLoopDynamicEnabled' }, candidates: [], extinct: true,
  };

  it('findExtinct returns the latest extinct entries, sorted by patch', () => {
    const out = findExtinct([EXTINCT_LEGACY, EXTINCT_ENTRY, ...DRIFT_LINES]);
    assert.deepEqual(out.map(e => e.patch), ['legacy_vanished', 'vanished_patch']);
    assert.equal(out[1].id, 'isDurableCronEnabled');
    assert.equal(out[1].detail, 'anchor gone');
  });

  it('proposeHeal reports extinct anchors in both `extinct` and `skipped` (loud reason)', () => {
    const { changes, skipped, extinct } = proposeHeal([EXTINCT_ENTRY, ...DRIFT_LINES], ANCHORS_SRC);
    assert.equal(changes.length, 1, 'ordinary healable drift still heals');
    assert.equal(extinct.length, 1);
    assert.equal(extinct[0].patch, 'vanished_patch');
    const loud = skipped.find(s => s.patch === 'vanished_patch');
    assert.ok(loud, 'extinct patch must appear in skipped');
    assert.match(loud.reason, /EXTINCT/);
    assert.match(loud.reason, /finding-anchors\.md/);
  });

  it('runHeal carries the extinct list through and adapts the next-step line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-heal-extinct-'));
    const driftPath = path.join(dir, 'anchor-drift.jsonl');
    const anchorsPath = path.join(dir, 'anchors.mjs');
    fs.writeFileSync(driftPath, JSON.stringify(EXTINCT_ENTRY) + '\n', 'utf8');
    fs.writeFileSync(anchorsPath, ANCHORS_SRC, 'utf8');
    const res = runHeal({ driftPath, anchorsPath, write: false });
    assert.equal(res.ok, true);
    assert.equal(res.empty, true, 'nothing healable');
    assert.equal(res.extinct.length, 1);
    assert.match(res.nextLine, /EXTINCT/);
    assert.match(res.nextLine, /finding-anchors\.md/);
  });

  it('healNextLine prefers proposals over the extinct nudge when both exist', () => {
    const withChanges = healNextLine({ changeCount: 2, empty: false, extinctCount: 3 });
    assert.match(withChanges, /--write/);
    const extinctOnly = healNextLine({ changeCount: 0, empty: true, extinctCount: 3 });
    assert.match(extinctOnly, /EXTINCT/);
  });
});

describe('doctor --suggest — extinct formatting', () => {
  it('prints the loud extinction block instead of the re-run nudge', () => {
    const out = formatSuggestion({
      patch: 'vanished_patch', detail: 'anchor gone',
      status: 'extinct', extinct: true, candidates: [],
    });
    assert.match(out, /EXTINCT/);
    assert.match(out, /finding-anchors\.md/);
    assert.match(out, /escape-hatch registry/);
    assert.match(out, /retire/i);
    assert.doesNotMatch(out, /re-running doctor against a fresh bundle/);
  });

  it('keeps the legacy no-candidates note for old records without the extinct marker', () => {
    const out = formatSuggestion({ patch: 'old_record', status: 'missing', candidates: [] });
    assert.match(out, /no fuzzy candidates recorded/);
    assert.doesNotMatch(out, /EXTINCT/);
  });
});
