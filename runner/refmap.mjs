/**
 * runner/refmap.mjs — Runtime refmap loader.
 *
 * A refmap (see tools/build-refmap.mjs) is a JSON sidecar mapping anchor IDs
 * to the resolved `{ fn, offset }` for a specific bundle version. Refmaps are
 * optional: when absent, `resolveAnchor` falls back to the regex registry in
 * `runner/anchors.mjs`. When present, they let `resolveAnchor` synthesize a
 * version-specific pattern without requiring a hand-written regex entry.
 *
 * Precedence (highest wins): explicit version-specific regex entry in
 * anchors.mjs → refmap entry for the bundle version → anchors.mjs default
 * regex. The regex registry remains authoritative — refmaps only augment.
 */

import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT } from './paths.mjs';

/**
 * Load the refmap for a given ccVersion. Returns null when the file is
 * absent or unreadable — refmaps are an optional augmentation, never a
 * load-time error.
 *
 * @param {string|null|undefined} ccVersion - Target Claude Code bundle version.
 * @param {string} [root] - Project root containing the refmaps/ directory.
 * @returns {object|null}
 */
export function loadRefmap(ccVersion, root = PROJECT_ROOT) {
  if (!ccVersion) return null;
  const filePath = path.join(root, 'refmaps', `${ccVersion}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data || typeof data !== 'object' || !data.anchors) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Look up an anchor ID inside a refmap. Returns the `{ fn, offset }` entry
 * or null when the anchor is not resolved by that refmap.
 *
 * @param {object|null} refmap
 * @param {string} anchorId
 * @returns {{ fn: string|null, offset: number }|null}
 */
export function resolveSymbol(refmap, anchorId) {
  if (!refmap || !refmap.anchors) return null;
  const hit = refmap.anchors[anchorId];
  if (!hit || typeof hit !== 'object') return null;
  if (typeof hit.fn !== 'string' || hit.fn.length === 0) return null;
  return { fn: hit.fn, offset: typeof hit.offset === 'number' ? hit.offset : -1 };
}
