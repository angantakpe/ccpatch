/**
 * Conflict detection helpers extracted from runner.mjs.
 *
 * These functions compute approximate byte-range "spans" that a patch touched
 * (from a structured unified diff) and detect overlapping ranges between
 * patches that ran in the same phase.
 *
 * Pure, side-effect free. Imported by runner.mjs.
 */

/**
 * Convert a structuredPatch into approximate byte ranges in the *pre-apply*
 * code. We currently use line resolution: each hunk produces one range
 * spanning from the start of `oldStart` to the start of `oldStart + oldLines`.
 * That's imperfect — a small edit inside a long line produces a too-wide span —
 * but it's a sane first approximation. A future revision can compute
 * byte-exact spans by diffing within hunks.
 */
export function diffSpansFromPatch(preCode, sp) {
  const ranges = [];
  if (!sp || !Array.isArray(sp.hunks)) return ranges;
  // Build a line-start index once.
  const lineStarts = [0];
  for (let i = 0; i < preCode.length; i++) {
    if (preCode.charCodeAt(i) === 10 /* \n */) lineStarts.push(i + 1);
  }
  const lineOffset = (lineNum1) => {
    const idx = Math.max(0, Math.min(lineStarts.length - 1, lineNum1 - 1));
    return lineStarts[idx];
  };
  for (const h of sp.hunks) {
    const start = lineOffset(h.oldStart);
    const endLine = h.oldStart + (h.oldLines || 0);
    const end = endLine >= lineStarts.length ? preCode.length : lineOffset(endLine);
    if (end > start) ranges.push([start, end]);
  }
  return ranges;
}

export function rangesIntersect(a, b) {
  return a[0] < b[1] && b[0] < a[1];
}

/**
 * Detect overlap conflicts among patches that ran in the same phase.
 *   trace: array of { name, phase, atSitesOriginal, diffSpansPre, preCodeLen, allowOverlapWith }
 * Where:
 *   atSitesOriginal — atSites recorded in the code state immediately before
 *                     this patch applied (post-previous-patches code state).
 *   diffSpansPre    — byte ranges in the pre-apply code that the patch touched.
 *
 * Returns array of conflicts: { phase, a, b, kind, rangeA, rangeB }.
 *
 * Note: because each patch sees a different code state, "comparing ranges
 * across patches" is approximate. We compare A's diff span (in A's preCode) to
 * B's at/diff span (in B's preCode = post-A code). Offsets shift by the net
 * delta A introduced; we don't correct for that. The check is a smell detector,
 * not a proof — false positives are possible when ranges incidentally align.
 */
export function detectOverlapsInPhase(traces) {
  const conflicts = [];
  for (let i = 0; i < traces.length; i++) {
    for (let j = i + 1; j < traces.length; j++) {
      const A = traces[i];
      const B = traces[j];
      // at-vs-at: compare resolved sites (in their respective code states).
      if (A.atSites && B.atSites) {
        for (const sa of A.atSites) {
          for (const sb of B.atSites) {
            if (rangesIntersect([sa.start, sa.end || sa.start + 1], [sb.start, sb.end || sb.start + 1])) {
              conflicts.push({
                phase: A.phase, a: A.name, b: B.name, kind: 'at-vs-at',
                rangeA: [sa.start, sa.end ?? sa.start],
                rangeB: [sb.start, sb.end ?? sb.start],
              });
            }
          }
        }
      }
      // at-vs-diff: B's resolved at-sites intersect A's diff span.
      if (B.atSites && A.diffSpans) {
        for (const sb of B.atSites) {
          for (const ra of A.diffSpans) {
            if (rangesIntersect(ra, [sb.start, sb.end || sb.start + 1])) {
              conflicts.push({
                phase: A.phase, a: A.name, b: B.name, kind: 'at-vs-diff',
                rangeA: ra,
                rangeB: [sb.start, sb.end ?? sb.start],
              });
            }
          }
        }
      }
      // diff-vs-diff: both patches touched overlapping byte ranges (approx).
      if (A.diffSpans && B.diffSpans) {
        for (const ra of A.diffSpans) {
          for (const rb of B.diffSpans) {
            if (rangesIntersect(ra, rb)) {
              conflicts.push({
                phase: A.phase, a: A.name, b: B.name, kind: 'diff-vs-diff',
                rangeA: ra, rangeB: rb,
              });
            }
          }
        }
      }
    }
  }
  return conflicts;
}
