/**
 * The additive overlap-coordinate frame, extracted out of applyNamedPatches
 * (anchor-lint task — pure refactor, no behavior change). runner.mjs now
 * delegates the frame math here instead of inlining it.
 *
 * The shared-frame overlap math (A2) translates every patch's recorded ranges
 * into ONE coordinate frame — original-bundle offsets — by subtracting
 * `deltaBefore`, the net length change all prior patches introduced (preCode's
 * length minus the original bundle length). preCode for each patch is exactly
 * original + prior-deltas, so this collapses every patch's spans/at-sites into
 * the same frame and detectOverlapsInPhase() can compare them like-for-like.
 *
 * The frame is "additive": preCode === original + sum of prior patch apply
 * deltas (+ any onVerifyFail heal deltas, tracked separately as `hookDelta`).
 * assertAdditive() guards that invariant before each patch applies; a genuine
 * non-additive break (a patch kind that doesn't preserve the frame, or an
 * onBeforeApply hook that swapped ctx.code) throws, while a successful self-heal
 * nets out via hookDelta and does NOT trip the gate.
 */

/**
 * Owns the original bundle length and the cumulative out-of-band `hookDelta`
 * (byte-length changes from onVerifyFail heals) for one applyNamedPatches run.
 * All arithmetic reproduces the exact prior inline math byte-for-byte.
 */
export class CoordinateFrame {
  /**
   * @param {number} origLength the original bundle's `.length` (code.length).
   */
  constructor(origLength) {
    this.origLength = origLength;
    // Finding #2 (hook ordering): cumulative byte-length change introduced
    // OUTSIDE patch apply() — specifically an onVerifyFail heal that reassigns
    // nextCode to its returned (possibly differently-sized) string at a
    // phase-boundary flush. Those bytes are NOT reflected in any trace's
    // apply-delta accounting, so the additive-frame invariant (which models
    // nextCode as original + sum of patch apply deltas) would otherwise mis-add
    // them and could falsely throw on a SUCCESSFUL self-heal. We thread this
    // into the invariant's expected-delta so a heal is accounted for explicitly
    // rather than mistaken for a broken frame.
    this.hookDelta = 0;
  }

  /**
   * Net delta introduced before this patch ran (the shared-frame shift):
   * preCode.length minus the original bundle length. preCode is exactly
   * original + the cumulative net length change of every prior patch, so this
   * is the offset that maps preCode coordinates back to the original frame.
   *
   * @param {string} preCode the code this patch will see (== beforeCode frame).
   * @returns {number}
   */
  deltaBefore(preCode) {
    return preCode.length - this.origLength;
  }

  /**
   * Translate [start, end] spans from the preCode frame into the shared
   * original-bundle frame by subtracting `deltaBefore` from both ends.
   *
   * @param {Array<[number, number]>} spans
   * @param {number} deltaBefore
   * @returns {Array<[number, number]>}
   */
  shiftToOriginal(spans, deltaBefore) {
    return spans.map(([s, e]) => [s - deltaBefore, e - deltaBefore]);
  }

  /**
   * Translate @At sites (resolved on beforeCode == preCode frame) into the
   * shared original-bundle frame. Mirrors the per-site object shape: start and
   * end shift by `deltaBefore`, end defaults to start when absent.
   *
   * @param {Array<{start: number, end?: number}>|null} atSites
   * @param {number} deltaBefore
   * @returns {Array<object>|null}
   */
  shiftSites(atSites, deltaBefore) {
    return atSites
      ? atSites.map(s => ({ ...s, start: s.start - deltaBefore, end: (s.end ?? s.start) - deltaBefore }))
      : null;
  }

  /**
   * Record an onVerifyFail heal that replaced the running code with a new
   * (possibly differently-sized) string. The out-of-band length change is
   * accumulated into `hookDelta` so the overlap-frame invariant can subtract it
   * back out instead of treating it as a broken additive frame and aborting a
   * successful self-heal.
   *
   * @param {number} oldLen length of the code being replaced (nextCode.length).
   * @param {number} newLen length of the heal's returned string.
   */
  recordHookDelta(oldLen, newLen) {
    this.hookDelta += newLen - oldLen;
  }

  /**
   * Assert the additive overlap-coordinate invariant BEFORE applying a patch.
   * `nextCode` is the accumulated result of all prior patches, so its delta from
   * the original `code` is the EXPECTED deltaBefore; `beforeCode` is what this
   * patch will actually see. They diverge only if the additive frame was broken
   * — e.g. a non-additive patch kind, or an onBeforeApply hook that replaced
   * ctx.code with an unrelated string. Subtracting both deltas from preCode would
   * then mis-translate every span and silently mis-detect overlaps.
   *
   * Finding #2: subtract `hookDelta` (cumulative out-of-band length change from
   * onVerifyFail heals) from BOTH sides so the invariant measures the PURE
   * patch-apply frame. nextCode and beforeCode both carry the heal bytes equally,
   * so a successful self-heal nets out and does NOT trip the gate; a genuine
   * non-additive break still diverges and throws.
   *
   * @param {string} beforeCode the code this patch will see.
   * @param {string} nextCode   the accumulated result of all prior patches.
   * @param {string} origCode   the original bundle.
   * @param {string} patchName  for the error message.
   * @throws {Error} with the exact historical message on violation.
   */
  assertAdditive(beforeCode, nextCode, origCode, patchName) {
    const expectedDeltaBefore = (nextCode.length - origCode.length) - this.hookDelta;
    const actualDeltaBefore = (beforeCode.length - origCode.length) - this.hookDelta;
    if (actualDeltaBefore !== expectedDeltaBefore) {
      throw new Error(
        `Overlap-frame invariant violated at patch "${patchName}": beforeCode.length-origLength-hookDelta=${actualDeltaBefore} ` +
        `but cumulative prior patch delta=${expectedDeltaBefore} (hookDelta=${this.hookDelta}). The shared-frame overlap math ` +
        `(A2) assumes an additive frame (preCode === original + sum of prior patch deltas + heal deltas). A non-additive ` +
        `patch kind, or an onBeforeApply hook that replaced ctx.code with an unrelated string, broke it — overlap ` +
        `detection would silently mis-translate spans. Fix the patch so it preserves the additive frame.`
      );
    }
  }
}
