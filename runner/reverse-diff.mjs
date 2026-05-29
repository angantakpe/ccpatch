import { createHash } from 'node:crypto';
import { createPatch } from 'diff';

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Capture a reverse diff from the effective post-apply code back to the
 * pre-apply code so the patched bundle can be restored byte-for-byte later.
 *
 * Skips no-change applies (effectiveCode === preCode) — they contribute
 * nothing to a revert. Pushes a sidecar record into `captureReverse` (the
 * caller's array) when a meaningful change exists.
 *
 * Perf#2: `createPatch` over a ~15MB minified bundle is expensive, and it ran
 * for every changed patch (~24x per build). The gate below is the EXPLICIT
 * request signal: the diff is computed only when the caller hands us an array
 * to collect into. Callers that don't want the cost (and don't need a revert
 * sidecar) pass nothing / a non-array and pay zero. The sidecar schema is
 * unchanged — every pushed record still carries { name, reverseDiff,
 * preSha256, postSha256 } so runner/cli/cmd-revert.mjs keeps working verbatim.
 *
 * No-op when `captureReverse` isn't an array or `effectiveCode` is not a
 * string. Mutates `captureReverse` in place.
 */
export function captureReverseDiff(name, preCode, effectiveCode, captureReverse) {
  // EXPLICIT-request gate: no array → capture was not requested → skip the
  // expensive full-bundle createPatch entirely.
  if (!Array.isArray(captureReverse)) return;
  if (typeof effectiveCode !== 'string') return;
  if (effectiveCode === preCode) return;
  const reverseDiff = createPatch(name, effectiveCode, preCode, 'patched', 'original');
  captureReverse.push({
    name,
    reverseDiff,
    preSha256: sha256(preCode),
    postSha256: sha256(effectiveCode),
  });
}
