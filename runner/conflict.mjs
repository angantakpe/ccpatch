/**
 * Conflict detection helpers extracted from runner.mjs.
 *
 * These functions compute approximate byte-range "spans" that a patch touched
 * (from a structured unified diff) and detect overlapping ranges between
 * patches that ran in the same phase.
 *
 * Pure, side-effect free. Imported by runner.mjs.
 */

// Perf#3: lineStarts cache. diffSpansFromPatch is called once per changed patch
// (~24x on a real build), and each call previously rescanned the entire ~15MB
// preCode to rebuild the line-start index. Since every call in a phase shares
// the same preCode string, memoise the index keyed by string identity — same
// last-seen pattern as runner/ast-cache.mjs (JS can't weak-ref a string, so we
// keep the last `code` seen plus its index and drop it when `code` changes).
let cachedLineStartsCode = null;
let cachedLineStarts = null;

function lineStartsFor(preCode) {
  if (cachedLineStartsCode === preCode && cachedLineStarts !== null) {
    return cachedLineStarts;
  }
  const lineStarts = [0];
  for (let i = 0; i < preCode.length; i++) {
    if (preCode.charCodeAt(i) === 10 /* \n */) lineStarts.push(i + 1);
  }
  cachedLineStartsCode = preCode;
  cachedLineStarts = lineStarts;
  return lineStarts;
}

/**
 * Clear the lineStarts cache. Useful for test isolation; not required for
 * correctness in production since the identity check invalidates automatically
 * when the bundle string changes.
 */
export function resetLineStartsCache() {
  cachedLineStartsCode = null;
  cachedLineStarts = null;
}

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
  // Build (or reuse) the line-start index. Perf#3: memoised by preCode identity
  // so a phase's worth of diffSpansFromPatch calls share one ~15MB scan.
  const lineStarts = lineStartsFor(preCode);
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
 * Arch#1: a range whose shifted start is negative lives in the "prepend region"
 * — a patch that injected near offset 0 (esm_compat / fetch_interceptor /
 * bun_shim / contracts). Subtracting the shared-frame delta drives such a span
 * NEGATIVE, collapsing every prepend onto a sentinel range like [-233,-232], so
 * they all falsely intersect each other. A prepend has no meaningful original-
 * bundle coordinate, so it cannot meaningfully conflict — drop it before
 * comparison.
 */
function isPrependRange(r) {
  return r[0] < 0;
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
  // Arch#1: drop prepend-region ranges (shifted start < 0) up front. These are
  // near-offset-0 injections whose shared-frame translation made them negative;
  // they share a meaningless sentinel range and would all false-overlap. A
  // prepend has no original-bundle coordinate, so it can't truly conflict.
  const cleaned = traces.map((t) => ({
    ...t,
    atSites: Array.isArray(t.atSites)
      ? t.atSites.filter((s) => (s.start ?? 0) >= 0)
      : t.atSites,
    diffSpans: Array.isArray(t.diffSpans)
      ? t.diffSpans.filter((r) => !isPrependRange(r))
      : t.diffSpans,
  }));
  for (let i = 0; i < cleaned.length; i++) {
    for (let j = i + 1; j < cleaned.length; j++) {
      const A = cleaned[i];
      const B = cleaned[j];
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
