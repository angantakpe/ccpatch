import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectOverlapsInPhase } from '../runner/conflict.mjs';
import { applyNamedPatches } from '../runner/runner.mjs';

const silent = { log() {}, warn() {}, error() {}, debug() {} };

function mkLogger() {
  const warnings = [];
  return { warnings, log() {}, warn(m) { warnings.push(String(m)); }, error() {}, debug() {} };
}

function mkPatch({ description = 't', apply, verify, phase, priority, allowOverlapWith } = {}) {
  const p = { description };
  if (apply) p.apply = apply;
  if (verify) p.verify = verify;
  if (phase) p.phase = phase;
  if (priority !== undefined) p.priority = priority;
  if (allowOverlapWith) p.allowOverlapWith = allowOverlapWith;
  return p;
}

describe('conflict — prepend heuristic (explicit pre-frame classification)', () => {
  it('does NOT drop a genuine low-offset edit that translates negative after a large prior insertion', () => {
    // Frame setup: a large prior insertion (DELTA bytes) ran before BOTH patches.
    // Patch A and patch B each edit a genuinely-overlapping LOW byte offset in
    // their own pre-apply frame (pre-frame start ~10_000 — well past the prepend
    // region — because preCode already grew by the insertion). Translated into
    // the shared original frame (subtract DELTA) their starts go NEGATIVE.
    //
    // The OLD `r[0] < 0` heuristic dropped both ranges (negative translated
    // start) and silently suppressed the conflict. The FIXED heuristic keeps them
    // (pre-frame start is far from 0) so the real overlap IS detected.
    const DELTA = 50000;
    // Shared-frame ranges: pre-frame [10000,10010] - DELTA = [-40000,-39990].
    const A = {
      name: 'a', phase: 'main',
      atSites: null,
      diffSpans: [[10000 - DELTA, 10010 - DELTA]],
      _deltaBefore: DELTA,
      allowOverlapWith: [],
    };
    const B = {
      name: 'b', phase: 'main',
      atSites: null,
      diffSpans: [[10005 - DELTA, 10015 - DELTA]], // overlaps A in the same frame
      _deltaBefore: DELTA,
      allowOverlapWith: [],
    };
    const conflicts = detectOverlapsInPhase([A, B]);
    assert.equal(conflicts.length, 1, `expected the genuine low-offset conflict to be detected, got ${JSON.stringify(conflicts)}`);
    assert.equal(conflicts[0].kind, 'diff-vs-diff');
  });

  it('still drops two real top-of-bundle prepends so they do not false-overlap', () => {
    // Two genuine prepends: each injected at pre-frame offset ~0-20 (after a
    // shebang). Prior insertions pushed their translated starts negative and
    // collapsed them onto the sentinel region — exactly the false-overlap the
    // heuristic exists to suppress. Pre-frame start < 64 AND translated start < 0,
    // so BOTH are classified as prepends and dropped → no conflict.
    const DELTA = 50000;
    const A = {
      name: 'esm_compat', phase: 'main',
      atSites: null,
      diffSpans: [[20 - DELTA, 21 - DELTA]], // pre-frame start 20 (after shebang)
      _deltaBefore: DELTA,
      allowOverlapWith: [],
    };
    const B = {
      name: 'fetch_interceptor', phase: 'main',
      atSites: null,
      diffSpans: [[0 - DELTA, 1 - DELTA]],   // pre-frame start 0 (before CJS-IIFE)
      _deltaBefore: DELTA,
      allowOverlapWith: [],
    };
    const conflicts = detectOverlapsInPhase([A, B]);
    assert.equal(conflicts.length, 0, `real prepends must not false-overlap, got ${JSON.stringify(conflicts)}`);
  });

  it('end-to-end: a low-offset edit after a large insertion is flagged in strict mode', async () => {
    // a inserts a large block at the TOP of the bundle (a prepend-like injection),
    // shifting everything after it forward. b and c then BOTH edit the same early
    // marker that now lives at a large pre-frame offset (past the insertion). Their
    // edits genuinely collide; strict mode must flag the b<->c overlap rather than
    // dropping it as a phantom "prepend".
    const block = 'Z'.repeat(20000);
    const code = 'HEAD' + 'x'.repeat(100) + 'COLLIDE' + 'y'.repeat(100) + 'TAIL';
    const patches = {
      // priority orders them: a first (prepend), then b, then c.
      a: mkPatch({ priority: 1, apply: (s) => block + s, verify: { present: block, weak: true } }),
      b: mkPatch({ priority: 2, apply: (s) => s.replace('COLLIDE', 'COLLIDE_B'), verify: { present: 'COLLIDE_B', weak: true } }),
      c: mkPatch({ priority: 3, apply: (s) => s.replace('COLLIDE_B', 'COLLIDE_BC'), verify: { present: 'COLLIDE_BC', weak: true } }),
    };
    await assert.rejects(
      () => applyNamedPatches(code, patches, ['a', 'b', 'c'], silent, { strict: true }),
      /overlap.*(b.*c|c.*b)/s,
      'the genuine b<->c overlap after a large prepend must still be fatal in strict mode',
    );
  });

  it('end-to-end: two real prepends in the same phase do not false-overlap (non-strict, no overlap warning)', async () => {
    // Two patches that both inject at the very top of the bundle. After the first
    // runs, the second sees a grown preCode; both translate negative. They touch
    // disjoint top-of-bundle bytes and must NOT be reported as overlapping.
    const code = '#!/usr/bin/env node\nMAIN_BODY';
    const patches = {
      p1: mkPatch({ priority: 1, apply: (s) => s.replace('#!/usr/bin/env node\n', '#!/usr/bin/env node\n/*P1*/'), verify: { present: '/*P1*/', weak: true } }),
      p2: mkPatch({ priority: 2, apply: (s) => s.replace('#!/usr/bin/env node\n', '#!/usr/bin/env node\n/*P2*/'), verify: { present: '/*P2*/', weak: true } }),
    };
    const logger = mkLogger();
    const { code: out } = await applyNamedPatches(code, patches, ['p1', 'p2'], logger);
    assert.ok(out.includes('/*P1*/') && out.includes('/*P2*/'));
    assert.ok(
      !logger.warnings.some(w => w.includes('[overlap]')),
      `real prepends must not produce an overlap warning, got: ${JSON.stringify(logger.warnings)}`,
    );
  });
});
