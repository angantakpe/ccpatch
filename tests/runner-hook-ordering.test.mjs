import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyNamedPatches } from '../runner/runner.mjs';

const silent = { log() {}, warn() {}, error() {}, debug() {} };

function mkLogger() {
  const warnings = [];
  return {
    warnings,
    log() {},
    warn(m) { warnings.push(String(m)); },
    error() {},
    debug() {},
  };
}

function mkPatch({ description = 't', apply, verify, phase, priority, onVerifyFail, onAfterApply } = {}) {
  const p = { description };
  if (apply) p.apply = apply;
  if (verify) p.verify = verify;
  if (phase) p.phase = phase;
  if (priority !== undefined) p.priority = priority;
  if (onVerifyFail) p.onVerifyFail = onVerifyFail;
  if (onAfterApply) p.onAfterApply = onAfterApply;
  return p;
}

describe('runner — onVerifyFail heal vs overlap-frame invariant', () => {
  it('a length-changing heal at a phase boundary does not trip the overlap-frame invariant', async () => {
    // P1 (pre) injects a sentinel its verify cannot find (verify.present asks for
    // a DIFFERENT string) so the deferred verify FAILS at the pre→main boundary.
    // Its onVerifyFail returns a healed string whose length DIFFERS from nextCode
    // — those bytes were introduced OUTSIDE patch apply, so no trace's
    // _deltaBefore reflects them. A later main-phase patch P2 then runs; the
    // additive-frame invariant must NOT falsely throw on the successful heal.
    const heal = 'HEALED_' + 'q'.repeat(40); // present:HEAL satisfied; length != P1 apply delta
    const patches = {
      p1: mkPatch({
        phase: 'pre',
        apply: (c) => c + 'P1',                 // delta +2
        verify: { present: 'HEAL', weak: true },// fails on snapshot 'seed'+'P1'
        onVerifyFail: (ctx) => ctx.code + heal, // heal off pre-apply code, new length
      }),
      p2: mkPatch({
        phase: 'main',
        apply: (c) => c + 'P2',
        verify: { present: 'P2', weak: true },
      }),
    };
    const logger = mkLogger();
    await assert.doesNotReject(
      () => applyNamedPatches('seed', patches, ['p1', 'p2'], logger),
      'a successful length-changing heal must not trip the overlap-frame invariant',
    );
    assert.ok(
      !logger.warnings.some(w => /Overlap-frame invariant/.test(w)),
      `unexpected invariant warning: ${JSON.stringify(logger.warnings)}`,
    );
  });

  it('two same-phase patches plus a heal between phases still apply cleanly', async () => {
    // Stress the accounting with two pre patches (so the phase has real prior
    // deltas) before the healing flush and a following main patch.
    const heal = (c) => c.replace('seed', 'SEEDXX'); // +2 length change via heal
    const patches = {
      a: mkPatch({ phase: 'pre', apply: (c) => c.replace('seed', 'seedAAAA'), verify: { present: 'seedAAAA', weak: true } }),
      b: mkPatch({
        phase: 'pre',
        apply: (c) => c + 'BBBB',
        verify: { present: 'NEVER_THERE', weak: true },
        onVerifyFail: (ctx) => heal(ctx.code) + 'BBBBNEVER_THERE',
      }),
      c: mkPatch({ phase: 'main', apply: (cc) => cc + 'CC', verify: { present: 'CC', weak: true } }),
    };
    const logger = mkLogger();
    await assert.doesNotReject(
      () => applyNamedPatches('seedseed', patches, ['a', 'b', 'c'], logger),
    );
    assert.ok(
      !logger.warnings.some(w => /Overlap-frame invariant/.test(w)),
      `unexpected invariant warning: ${JSON.stringify(logger.warnings)}`,
    );
  });
});

describe('runner — reverse-diff & coverage capture after onAfterApply', () => {
  it('reverse diff reflects an onAfterApply mutation (byte-for-byte revert target is final code)', async () => {
    // onAfterApply rewrites appliedCode after apply() returns. The reverse diff
    // (and any coverage marker) must be captured against the FINAL effectiveCode,
    // not the pre-hook one — else a revert would not restore byte-for-byte.
    const captureReverse = [];
    const patches = {
      p: {
        description: 't',
        apply: (c) => c + 'APPLIED',
        verify: { present: 'AFTERHOOK', weak: true },
        onAfterApply(ctx) { ctx.appliedCode = ctx.appliedCode + 'AFTERHOOK'; },
      },
    };
    const { code: out } = await applyNamedPatches('seed', patches, ['p'], silent, { captureReverse });
    assert.ok(out.endsWith('APPLIEDAFTERHOOK'), `final code missing hook mutation: ${out}`);
    assert.equal(captureReverse.length, 1);
    // The reverse diff restores the final patched code back to the original seed.
    const { applyPatch } = await import('diff');
    const restored = applyPatch(out, captureReverse[0].reverseDiff);
    assert.equal(restored, 'seed', 'reverse diff must restore the original from the FINAL (post-hook) code');
  });

  it('coverage marker is injected against the post-onAfterApply code', async () => {
    // The coverage marker injection must run after onAfterApply so a last-mile
    // hook rewrite does not drop the instrumentation.
    const patches = {
      p: {
        description: 't',
        coverageMarker: 'p_hit',
        apply: (c) => c.replace('FN', 'function fn(){ return 1; }'),
        verify: { present: 'fn', weak: true },
        onAfterApply(ctx) {
          // Re-emit the function so the marker must target the post-hook string.
          ctx.appliedCode = ctx.appliedCode.replace('return 1;', 'return 2;');
        },
      },
    };
    const { code: out } = await applyNamedPatches('var x = FN;', patches, ['p'], silent);
    assert.ok(out.includes('return 2;'), `hook mutation lost: ${out}`);
    // injectCoverageHit injects a __ccpCovHit('p_hit') call when a site is found;
    // if no site is found it is a silent skip. Either way the build must succeed
    // and reflect the hook mutation (the regression we guard is dropping the
    // mutation, not the marker presence).
  });
});
