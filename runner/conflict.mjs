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
 * Convert a structuredPatch into byte ranges in the *pre-apply* code.
 *
 * Each hunk is first located at line resolution ([oldStart, oldStart+oldLines)),
 * then TIGHTENED to the bytes that genuinely changed by a two-ended common
 * prefix/suffix scan of the hunk's old vs new content. This matters on minified
 * bundles, where a single source line can be megabytes long: a line-resolution
 * span would cover the whole line and manufacture false overlaps with every
 * other patch that happens to edit the same line. Byte-exact spans collapse a
 * scatter-edit patch's footprint to its real edit points, so the strict-mode
 * overlap gate stops flagging non-conflicting patches.
 *
 * A hunk with multiple internal edit segments yields a single span covering
 * from its first to its last changed byte (conservative — may over-report a
 * little, never under-reports). With `context: 0` (how the runner calls
 * structuredPatch) hunks are minimal, so in practice each is one contiguous edit.
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
    const base = lineOffset(h.oldStart);
    const endLine = h.oldStart + (h.oldLines || 0);
    const endOff = endLine >= lineStarts.length ? preCode.length : lineOffset(endLine);
    // Authoritative old bytes for this hunk's line range, taken verbatim from
    // preCode (so offsets are exact regardless of how `diff` framed the lines).
    const oldStr = preCode.slice(base, endOff);
    // New bytes for this hunk: context (' ') + additions ('+'), joined by '\n'.
    const newParts = [];
    for (const ln of (h.lines || [])) {
      const tag = ln[0];
      if (tag === ' ' || tag === '+') newParts.push(ln.slice(1));
    }
    let newStr = newParts.join('\n');
    // The preCode slice ends at the next line's start, so it carries the
    // trailing '\n'; mirror it so the common-suffix scan aligns.
    if (oldStr.endsWith('\n') && !newStr.endsWith('\n')) newStr += '\n';

    const aLen = oldStr.length, bLen = newStr.length;
    const maxPre = Math.min(aLen, bLen);
    let pre = 0;
    while (pre < maxPre && oldStr.charCodeAt(pre) === newStr.charCodeAt(pre)) pre++;
    let suf = 0;
    const maxSuf = maxPre - pre;
    while (suf < maxSuf && oldStr.charCodeAt(aLen - 1 - suf) === newStr.charCodeAt(bLen - 1 - suf)) suf++;

    const start = base + pre;
    const end = base + (aLen - suf);
    if (end > start) {
      ranges.push([start, end]);
    } else {
      // Pure insertion (no preCode bytes removed) — mark a 1-byte point at the
      // seam so two patches injecting at the same offset still register.
      ranges.push([start, Math.min(start + 1, preCode.length)]);
    }
  }
  return ranges;
}

export function rangesIntersect(a, b) {
  return a[0] < b[1] && b[0] < a[1];
}

/**
 * Detect overlap conflicts among patches that ran in the same phase.
 *   trace: array of { name, phase, atSites, diffSpans, allowOverlapWith }
 * Where:
 *   atSites   — resolved @At sites, TRANSLATED to original-bundle offsets.
 *   diffSpans — byte ranges the patch touched, TRANSLATED to original-bundle
 *               offsets.
 *
 * Returns array of conflicts: { phase, a, b, kind, rangeA, rangeB }.
 *
 * A2: every range in every trace is expressed in a SINGLE shared coordinate
 * frame (original-bundle offsets) — the caller (runner.applyNamedPatches)
 * subtracts each patch's cumulative net-length delta before pushing here. So
 * comparing A's spans to B's spans is now like-for-like, not approximate: a
 * later patch editing inside an earlier patch's original envelope only
 * intersects if it genuinely touches the same original bytes.
 */
export function detectOverlapsInPhase(traces) {
  const conflicts = [];
  for (let i = 0; i < traces.length; i++) {
    for (let j = i + 1; j < traces.length; j++) {
      const A = traces[i];
      const B = traces[j];
      // at-vs-at: compare resolved sites (in the shared original frame).
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
      // diff-vs-diff: both patches touched overlapping byte ranges.
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
