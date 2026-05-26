import { structuredPatch } from 'diff';

/**
 * Inject a `__ccpCovHit('<marker>')` call into the post-apply code so this
 * patch's runtime coverage can be tracked. Best-effort:
 *   1. If the patch resolved an @At HEAD/AFTER/BEFORE/INVOKE site, splice the
 *      call immediately at that site in the post-apply code (mapped by line
 *      content match — atSites point into the pre-apply code).
 *   2. Otherwise, prepend the call onto the first inserted line of the diff.
 *   3. Otherwise, return null to signal "no place to instrument" — the runner
 *      logs a notice and proceeds.
 *
 * Returns the modified code string on success or null on skip.
 */
export function injectCoverageHit(preCode, postCode, marker, atSites) {
  if (!marker || typeof postCode !== 'string') return null;
  const hitCall = `(globalThis.__ccpCovHit&&globalThis.__ccpCovHit(${JSON.stringify(marker)}));`;
  // Strategy 1: anchor in the post-apply diff. Find the first hunk of inserted
  // text (a line present in postCode but not preCode) and prepend the call.
  try {
    const sp = structuredPatch('a', 'b', preCode, postCode, '', '', { context: 0 });
    for (const h of sp.hunks || []) {
      for (const ln of h.lines || []) {
        if (ln.startsWith('+') && ln.length > 1) {
          const insertedLine = ln.slice(1);
          // Skip pure-whitespace inserts; we want real code to wrap.
          if (!insertedLine.trim()) continue;
          const idx = postCode.indexOf(insertedLine);
          if (idx !== -1) {
            return postCode.slice(0, idx) + hitCall + postCode.slice(idx);
          }
        }
      }
    }
  } catch (_) { /* fall through */ }
  // Strategy 2: at-site fallback (atSites refer to preCode offsets, but if
  // postCode === preCode + injection that didn't show up in the diff, this
  // still produces a runnable hit). Splice into postCode at the same offset
  // when possible.
  if (Array.isArray(atSites) && atSites.length > 0) {
    const site = atSites[0];
    const off = typeof site.start === 'number' ? site.start : null;
    if (off !== null && off <= postCode.length) {
      return postCode.slice(0, off) + hitCall + postCode.slice(off);
    }
  }
  return null;
}
