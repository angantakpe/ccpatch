import { structuredPatch } from 'diff';

/**
 * Inject a `__ccpCovHit('<marker>')` call into the post-apply code so this
 * patch's runtime coverage can be tracked. Best-effort:
 *   1. If the patch resolved an @At HEAD/AFTER/BEFORE/INVOKE site, splice the
 *      call immediately at that site offset in the post-apply code. This is the
 *      primary path: it's an O(1) splice and avoids diffing the ~16MB bundle.
 *   2. Otherwise (no usable atSites), fall back to an O(n) line-diff: find the
 *      first hunk of inserted text (a line present in postCode but not preCode)
 *      and prepend the call onto it.
 *   3. Otherwise, return null to signal "no place to instrument" — the runner
 *      logs a notice and proceeds.
 *
 * Returns the modified code string on success or null on skip.
 */
export function injectCoverageHit(preCode, postCode, marker, atSites) {
  if (!marker || typeof postCode !== 'string') return null;
  const hitCall = `(globalThis.__ccpCovHit&&globalThis.__ccpCovHit(${JSON.stringify(marker)}));`;
  // Strategy 1 (primary): at-site splice. atSites refer to preCode offsets, but
  // for the @At-resolved sites we instrument here the offset lands in the same
  // place in postCode, so this produces a runnable hit without diffing. O(1).
  if (Array.isArray(atSites) && atSites.length > 0) {
    const site = atSites[0];
    const off = typeof site.start === 'number' ? site.start : null;
    if (off !== null && off <= postCode.length) {
      return postCode.slice(0, off) + hitCall + postCode.slice(off);
    }
  }
  // Strategy 2 (fallback): anchor in the post-apply diff. Only reached when
  // atSites is empty/unusable, since structuredPatch is an O(n) line-diff over
  // the full minified bundle. Find the first hunk of inserted text (a line
  // present in postCode but not preCode) and prepend the call.
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
  return null;
}
