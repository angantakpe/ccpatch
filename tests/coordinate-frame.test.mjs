import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CoordinateFrame } from '../runner/coordinate-frame.mjs';

// These cases were previously only described in runner.mjs comments — the
// additive overlap-coordinate frame is now isolated and directly testable.

describe('CoordinateFrame — deltaBefore', () => {
  it('is preCode.length minus the original bundle length', () => {
    const frame = new CoordinateFrame(100);
    assert.equal(frame.deltaBefore('x'.repeat(100)), 0);
    assert.equal(frame.deltaBefore('x'.repeat(137)), 37);  // 37 bytes added by prior patches
    assert.equal(frame.deltaBefore('x'.repeat(88)), -12);  // prior patches net-deleted 12 bytes
  });
});

describe('CoordinateFrame — shiftToOriginal', () => {
  it('subtracts deltaBefore from both ends of every span', () => {
    const frame = new CoordinateFrame(0);
    const spans = [[50, 60], [200, 215]];
    assert.deepEqual(frame.shiftToOriginal(spans, 40), [[10, 20], [160, 175]]);
  });

  it('returns an empty array for empty input', () => {
    const frame = new CoordinateFrame(0);
    assert.deepEqual(frame.shiftToOriginal([], 99), []);
  });

  it('(c) scatter-patch multi-span shifting maps every hunk to the original frame', () => {
    // A scatter patch (e.g. unhide_features) yields many small spans, all in the
    // preCode frame. With 80 bytes of prior-patch growth, each maps back to its
    // original-bundle offset independently — no single envelope.
    const frame = new CoordinateFrame(1000);
    const deltaBefore = frame.deltaBefore('z'.repeat(1080)); // 80
    const preFrameSpans = [[100, 110], [480, 495], [900, 905]];
    assert.deepEqual(
      frame.shiftToOriginal(preFrameSpans, deltaBefore),
      [[20, 30], [400, 415], [820, 825]],
    );
  });
});

describe('CoordinateFrame — shiftSites', () => {
  it('(d) shifts at-site start/end by deltaBefore, preserving other fields', () => {
    const frame = new CoordinateFrame(0);
    const sites = [{ start: 50, end: 60, kind: 'call' }, { start: 120, end: 121 }];
    assert.deepEqual(frame.shiftSites(sites, 30), [
      { start: 20, end: 30, kind: 'call' },
      { start: 90, end: 91 },
    ]);
  });

  it('defaults a missing end to start (shifted)', () => {
    const frame = new CoordinateFrame(0);
    assert.deepEqual(frame.shiftSites([{ start: 70 }], 25), [{ start: 45, end: 45 }]);
  });

  it('returns null when there are no sites', () => {
    const frame = new CoordinateFrame(0);
    assert.equal(frame.shiftSites(null, 10), null);
  });
});

describe('CoordinateFrame — assertAdditive', () => {
  it('passes when beforeCode equals the accumulated prior-patch result', () => {
    const frame = new CoordinateFrame(100);
    const orig = 'x'.repeat(100);
    const accumulated = 'x'.repeat(115); // prior patches added 15 bytes
    // beforeCode this patch sees is exactly the accumulated result.
    assert.doesNotThrow(() => frame.assertAdditive(accumulated, accumulated, orig, 'p'));
  });

  it('(b) throws with the exact message on a genuine non-additive break', () => {
    const frame = new CoordinateFrame(100);
    const orig = 'x'.repeat(100);
    const accumulated = 'x'.repeat(115);
    // An onBeforeApply hook swapped ctx.code for an unrelated, differently-sized
    // string: beforeCode no longer matches the accumulated frame.
    const swapped = 'y'.repeat(130);
    assert.throws(
      () => frame.assertAdditive(swapped, accumulated, orig, 'bad_patch'),
      (err) => {
        assert.match(err.message, /^Overlap-frame invariant violated at patch "bad_patch":/);
        assert.match(err.message, /beforeCode\.length-origLength-hookDelta=30/); // 130-100-0
        assert.match(err.message, /cumulative prior patch delta=15/);            // 115-100-0
        assert.match(err.message, /hookDelta=0/);
        assert.match(err.message, /Fix the patch so it preserves the additive frame\./);
        return true;
      },
    );
  });

  it('(a) a heal that changes byte length nets out via hookDelta and does NOT trip the invariant', () => {
    const frame = new CoordinateFrame(100);
    const orig = 'x'.repeat(100);
    // Prior patches grew the code to 120 bytes (pure apply deltas).
    let accumulated = 'x'.repeat(120);
    // An onVerifyFail heal then replaced the running code with a SHORTER string
    // (120 -> 112): a -8 out-of-band change. Both nextCode and the beforeCode a
    // later patch sees carry those healed bytes equally.
    frame.recordHookDelta(120, 112);
    assert.equal(frame.hookDelta, -8);
    accumulated = 'x'.repeat(112);
    // The next patch sees exactly the healed accumulated code → invariant holds.
    assert.doesNotThrow(() => frame.assertAdditive(accumulated, accumulated, orig, 'after_heal'));
  });

  it('hookDelta is subtracted from BOTH sides, so a heal alone never trips the gate', () => {
    const frame = new CoordinateFrame(100);
    const orig = 'x'.repeat(100);
    frame.recordHookDelta(100, 140); // +40 heal
    // Both beforeCode and nextCode reflect the +40; expected and actual both net
    // to the same value once hookDelta is subtracted.
    const healed = 'x'.repeat(140);
    assert.doesNotThrow(() => frame.assertAdditive(healed, healed, orig, 'p'));
  });

  it('a break still throws even after a heal has been recorded', () => {
    const frame = new CoordinateFrame(100);
    const orig = 'x'.repeat(100);
    frame.recordHookDelta(100, 140); // +40 heal, hookDelta=40
    const accumulated = 'x'.repeat(140);
    const swapped = 'y'.repeat(155); // unrelated swap on top of the heal
    assert.throws(
      () => frame.assertAdditive(swapped, accumulated, orig, 'p'),
      (err) => {
        // actual = 155-100-40 = 15 ; expected = 140-100-40 = 0
        assert.match(err.message, /beforeCode\.length-origLength-hookDelta=15/);
        assert.match(err.message, /cumulative prior patch delta=0/);
        assert.match(err.message, /hookDelta=40/);
        return true;
      },
    );
  });
});

describe('CoordinateFrame — recordHookDelta', () => {
  it('accumulates multiple heals', () => {
    const frame = new CoordinateFrame(0);
    frame.recordHookDelta(100, 110); // +10
    frame.recordHookDelta(110, 105); // -5
    assert.equal(frame.hookDelta, 5);
  });
});
