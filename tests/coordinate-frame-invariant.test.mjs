import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { structuredPatch } from 'diff';

import { CoordinateFrame } from '../runner/coordinate-frame.mjs';
import {
  diffSpansFromPatch,
  detectOverlapsInPhase,
  rangesIntersect,
  resetLineStartsCache,
} from '../runner/conflict.mjs';
import {
  collectBootInjects,
  buildBootBlock,
  spliceBootRegistry,
} from '../runner/boot-registry.mjs';

/**
 * ── Architecture-review finding #4: hidden coupling around coordinate frames ──
 *
 * The runner (runner/runner.mjs, applyNamedPatches) performs ONE consolidated
 * boot splice via the boot-registry BEFORE any per-patch apply() runs:
 *
 *     code = spliceBootRegistry(code, bootCollect.entries, logger);   // grows `code`
 *     ...
 *     const frame = new CoordinateFrame(code.length);                 // POST-boot length!
 *
 * So `frame.origLength` already bakes in the boot splice's byte delta. Every
 * apply()-mutating patch then has its diffSpans translated into that shared
 * frame:
 *
 *     t._deltaBefore = frame.deltaBefore(t._preCode);                 // preCode - origLength
 *     t.diffSpans   = frame.shiftToOriginal(raw, t._deltaBefore);     // -> shared frame
 *     ...
 *     const conflicts = detectOverlapsInPhase(traces);
 *
 * This is a cross-LAYER implicit dependency: the boot-registry subsystem
 * produces a translation delta (the boot block length), and a DIFFERENT
 * subsystem (conflict detection, via the coordinate frame) must account for it
 * correctly. It works today only because `origLength` is sampled AFTER the boot
 * splice, so the boot delta is absorbed into the frame's origin rather than
 * leaking into each patch's `_deltaBefore`.
 *
 * These tests make that invariant EXPLICIT so a future refactor (e.g. sampling
 * origLength before the boot splice, or threading the boot delta separately)
 * can't silently break the shared frame and start mis-detecting overlaps.
 *
 * Fixtures are small and hand-built with exact byte math — no 15MB bundle.
 *
 * Real signatures exercised (quoted from the production modules):
 *   CoordinateFrame#deltaBefore(preCode)              -> preCode.length - origLength
 *   CoordinateFrame#shiftToOriginal(spans, delta)     -> spans.map(([s,e]) => [s-d, e-d])
 *   collectBootInjects(patches, names, {code, options, logger})
 *                                                     -> { entries, skipped }
 *   buildBootBlock(entries)                           -> combined boot block string
 *   spliceBootRegistry(code, entries, logger)         -> spliced code (or unchanged)
 *   diffSpansFromPatch(preCode, structuredPatch)      -> [[start,end], ...] (preCode frame)
 *   detectOverlapsInPhase(traces)                     -> [{phase,a,b,kind,rangeA,rangeB}]
 *   rangesIntersect(a, b)                             -> a[0] < b[1] && b[0] < a[1]
 */

// Mirror the silent logger idiom used across the existing tests.
const silent = { log() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// UNIT: shiftToOriginal threads a known boot-splice delta back to the origin.
// ---------------------------------------------------------------------------
describe('coordinate-frame invariant — shiftToOriginal accounts for the boot delta', () => {
  it('translates a post-boot-splice offset back to the original-bundle offset (exact bytes)', () => {
    // Hand-built byte math, modelling the runner's exact wiring.
    //
    //   ORIGINAL bundle length .................. 100 bytes
    //   boot block spliced in by the registry ...  30 bytes  (runs BEFORE apply())
    //   POST-boot bundle length ................. 130 bytes  <- this is what the
    //                                                            runner feeds to
    //                                                            new CoordinateFrame()
    //
    // The frame's origin is the POST-boot length, so the boot delta is absorbed
    // into origLength — it must NOT also show up in any patch's deltaBefore.
    const ORIGINAL_LEN = 100;
    const BOOT_BLOCK_LEN = 30;
    const POST_BOOT_LEN = ORIGINAL_LEN + BOOT_BLOCK_LEN; // 130
    const frame = new CoordinateFrame(POST_BOOT_LEN);

    // FIRST apply()-patch: it is the first to mutate, so its preCode IS the
    // post-boot bundle (no prior apply deltas). deltaBefore must therefore be 0,
    // proving the boot delta did NOT leak into the per-patch translation.
    const preCodeFirst = 'z'.repeat(POST_BOOT_LEN); // 130 bytes
    const d1 = frame.deltaBefore(preCodeFirst);
    assert.equal(d1, 0, 'boot delta is in origLength, NOT in the first patch deltaBefore');

    // It edits bytes [70, 75) of the post-boot bundle. Shifting by d1=0 leaves
    // the offset unchanged — i.e. the post-boot offset already IS the shared
    // frame's offset, because the frame origin is post-boot.
    assert.deepEqual(frame.shiftToOriginal([[70, 75]], d1), [[70, 75]]);

    // SECOND apply()-patch: it runs after the first added +5 bytes, so its
    // preCode is 135 bytes and deltaBefore = 5. An edit at [80, 85) in ITS frame
    // must translate back to [75, 80) in the shared (post-boot) frame.
    const preCodeSecond = 'z'.repeat(POST_BOOT_LEN + 5); // 135 bytes
    const d2 = frame.deltaBefore(preCodeSecond);
    assert.equal(d2, 5);
    assert.deepEqual(frame.shiftToOriginal([[80, 85]], d2), [[75, 80]]);
  });

  it('a hypothetical boot delta leak (origLength sampled PRE-boot) would corrupt the frame', () => {
    // Documents the bug the coupling guards against. If a future refactor sampled
    // origLength BEFORE the boot splice (= ORIGINAL_LEN, 100) while preCode still
    // reflects the post-boot bundle, the first patch's deltaBefore would wrongly
    // pick up the +30 boot delta and shift every span by 30 — silently corrupting
    // overlap detection.
    const ORIGINAL_LEN = 100;
    const BOOT_BLOCK_LEN = 30;
    const wrongFrame = new CoordinateFrame(ORIGINAL_LEN); // BUG: pre-boot length

    const preCodeFirst = 'z'.repeat(ORIGINAL_LEN + BOOT_BLOCK_LEN); // 130
    const leakedDelta = wrongFrame.deltaBefore(preCodeFirst);
    assert.equal(leakedDelta, 30, 'this is the leak — boot delta wrongly in deltaBefore');

    // The same [70,75) edit would now be mis-translated to [40,45). This assert
    // pins WHY the runner samples origLength after the boot splice: so this never
    // happens. The correct frame (above) yields [70,75]; the leaked one diverges.
    assert.deepEqual(wrongFrame.shiftToOriginal([[70, 75]], leakedDelta), [[40, 45]]);
    assert.notDeepEqual(
      wrongFrame.shiftToOriginal([[70, 75]], leakedDelta),
      [[70, 75]],
      'a pre-boot origLength would diverge from the correct shared frame',
    );
  });
});

// ---------------------------------------------------------------------------
// END-TO-END: real boot-registry splice + real frame + real conflict detection
// agree on ONE coordinate frame. Overlap is detected when it really overlaps,
// and NOT when it doesn't.
// ---------------------------------------------------------------------------
describe('coordinate-frame invariant — boot splice delta is threaded into conflict detection', () => {
  // A shebang bundle: spliceBoot inserts the boot block right after the first
  // '\n'. We hand-build the body so two later apply()-patches edit known, exact
  // byte offsets in the POST-boot bundle.
  const SHEBANG = '#!/usr/bin/env node\n';

  // A bootInject patch (goes through the registry, BEFORE apply()). Its block
  // content is irrelevant to the math beyond its length; we only need it to be
  // injected so the body shifts down.
  const bootPatch = {
    bootInject: { code: 'globalThis.__ccpBootHook_v1 = 1;', order: 10 },
    verify: { present: '__ccpBootHook_v1' },
  };

  function runBootSplice(bodyCode) {
    resetLineStartsCache(); // test isolation (cache is keyed by string identity)
    const code = SHEBANG + bodyCode;
    const { entries, skipped } = collectBootInjects({ boot: bootPatch }, ['boot'], {
      code,
      options: {},
      logger: silent,
    });
    assert.equal(skipped.length, 0, 'boot patch sentinel not yet present -> injected');
    assert.equal(entries.length, 1);
    const spliced = spliceBootRegistry(code, entries, silent);
    assert.notEqual(spliced, code, 'boot splice must actually grow the bundle');
    return { original: code, postBoot: spliced, entries };
  }

  /**
   * Reproduce the runner's per-patch span pipeline EXACTLY:
   *   preCode = bundle this patch saw
   *   raw     = diffSpansFromPatch(preCode, structuredPatch(...))  (preCode frame)
   *   shifted = frame.shiftToOriginal(raw, frame.deltaBefore(preCode))  (shared frame)
   * and attach _deltaBefore so detectOverlapsInPhase's prepend filter behaves
   * identically to production.
   */
  function makeTrace(frame, name, preCode, effectiveCode) {
    resetLineStartsCache();
    const sp = structuredPatch(name, name, preCode, effectiveCode, 'pre', 'post', { context: 0 });
    const raw = diffSpansFromPatch(preCode, sp);
    const deltaBefore = frame.deltaBefore(preCode);
    return {
      name,
      phase: 'main',
      atSites: null,
      diffSpans: frame.shiftToOriginal(raw, deltaBefore),
      _deltaBefore: deltaBefore,
      allowOverlapWith: [],
    };
  }

  it('detects a REAL overlap: two apply()-patches editing the same post-boot bytes', () => {
    // Body is one long minified-style line plus a marker region the two patches
    // both rewrite. Using a single line forces the byte-exact tightening path in
    // diffSpansFromPatch (the realistic minified-bundle case).
    const body = 'x'.repeat(200) + 'TARGET' + 'y'.repeat(200);
    const { postBoot } = runBootSplice(body);

    // The frame is built on the POST-boot length, exactly as the runner does.
    const frame = new CoordinateFrame(postBoot.length);

    // Patch A (first to apply) sees the post-boot bundle and rewrites TARGET.
    const aPre = postBoot;
    const aEff = postBoot.replace('TARGET', 'AAAAAA');

    // Patch B also rewrites the SAME 'TARGET' bytes. To mirror the runner's
    // sequential model (B runs after A's apply), B's preCode is A's output — but
    // A replaced TARGET, so to construct a genuine same-region conflict we let B
    // edit the very bytes A touched: B sees aEff and rewrites 'AAAAAA' -> 'BBBBBB'.
    // Both edits land on the identical original-frame byte range, so the shared
    // frame MUST report them as intersecting.
    const bPre = aEff;
    const bEff = aEff.replace('AAAAAA', 'BBBBBB');

    const traces = [
      makeTrace(frame, 'patchA', aPre, aEff),
      makeTrace(frame, 'patchB', bPre, bEff),
    ];

    // Sanity: B ran after A with no length change (6->6), so its deltaBefore is 0
    // too; both edits resolve to the identical shared-frame range.
    assert.deepEqual(traces[0].diffSpans, traces[1].diffSpans,
      'same-byte edits must translate to the same shared-frame range');

    const conflicts = detectOverlapsInPhase(traces);
    assert.equal(conflicts.length, 1, 'a genuine same-region edit must be flagged');
    assert.equal(conflicts[0].kind, 'diff-vs-diff');
    assert.equal(conflicts[0].a, 'patchA');
    assert.equal(conflicts[0].b, 'patchB');
    // And the reported range is the SAME for both, in the shared frame.
    assert.deepEqual(conflicts[0].rangeA, conflicts[0].rangeB);
  });

  it('does NOT spuriously flag two apply()-patches editing DISTINCT post-boot regions', () => {
    // Two well-separated marker regions in a single long line. After the boot
    // splice pushes everything down by the (identical) block length, both
    // patches' spans must STILL translate to non-overlapping original-frame
    // ranges — the boot delta must not smear them together.
    const body = 'x'.repeat(150) + 'LEFTMARK' + 'm'.repeat(400) + 'RIGHTMARK' + 'y'.repeat(150);
    const { postBoot } = runBootSplice(body);
    const frame = new CoordinateFrame(postBoot.length);

    // Patch A edits LEFTMARK (low offset). Patch B edits RIGHTMARK (high offset),
    // running after A. A's replacement is the same length (8->8) so B's preCode
    // offsets are unshifted relative to A's output.
    const aPre = postBoot;
    const aEff = postBoot.replace('LEFTMARK', 'leftMARK');
    const bPre = aEff;
    const bEff = aEff.replace('RIGHTMARK', 'rghtMARK'); // 8 -> 8, distinct region

    const traces = [
      makeTrace(frame, 'patchA', aPre, aEff),
      makeTrace(frame, 'patchB', bPre, bEff),
    ];

    // The two shared-frame ranges must be disjoint (no intersection).
    const [ra] = traces[0].diffSpans;
    const [rb] = traces[1].diffSpans;
    assert.ok(ra && rb, 'both patches produced a span');
    assert.equal(rangesIntersect(ra, rb), false,
      'distinct post-boot regions must not intersect in the shared frame');

    const conflicts = detectOverlapsInPhase(traces);
    assert.equal(conflicts.length, 0, 'distinct regions must NOT be flagged as a conflict');
  });

  it('the shared frame recovers the original-bundle offset of an apply() edit (exact bytes)', () => {
    // Tie the end-to-end pipeline to concrete numbers: an edit at a known offset
    // in the post-boot bundle must translate to the SAME offset in the shared
    // frame when it is the first apply()-patch (deltaBefore == 0), regardless of
    // how big the boot block was.
    const body = 'x'.repeat(64) + 'ZZ' + 'y'.repeat(64); // 'ZZ' starts at body offset 64
    const { original, postBoot, entries } = runBootSplice(body);

    const bootBlockLen = buildBootBlock(entries).length;
    // Sanity-check the byte arithmetic of the splice itself.
    assert.equal(postBoot.length, original.length + bootBlockLen);
    // The shebang line is SHEBANG.length bytes; the boot block is inserted right
    // after it, so 'ZZ' (at body offset 64) sits at this exact post-boot offset.
    const zzPostBoot = SHEBANG.length + bootBlockLen + 64;
    assert.equal(postBoot.slice(zzPostBoot, zzPostBoot + 2), 'ZZ',
      'ZZ marker lands at the computed post-boot offset');

    const frame = new CoordinateFrame(postBoot.length);
    const eff = postBoot.slice(0, zzPostBoot) + 'QQ' + postBoot.slice(zzPostBoot + 2);
    const trace = makeTrace(frame, 'edit', postBoot, eff);

    // First apply()-patch => deltaBefore 0 => shared-frame offset == post-boot
    // offset. The boot delta lives in origLength, so it does NOT shift this span.
    assert.equal(trace._deltaBefore, 0);
    assert.deepEqual(trace.diffSpans, [[zzPostBoot, zzPostBoot + 2]]);
  });
});
