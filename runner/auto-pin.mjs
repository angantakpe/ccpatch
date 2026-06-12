/**
 * Auto-pin after the first verified build — closes the TOFU window that the
 * manual `ccpatch pin <ver>` flow left open forever (nobody runs it).
 *
 * Handshake:
 *   1. scripts/verify-bundle-sha.mjs runs BEFORE the build (Makefile gate).
 *      On a TOFU acceptance — npm tarball integrity verified, version not yet
 *      pinned — it drops a marker file storage/outputs/tofu-pending-v<ver>.json
 *      recording the bundle's sha256 it just vouched for.
 *   2. The build path (runner/cli/cmd-build.mjs) calls maybeAutoPin() after a
 *      build that (a) applied patches with verify OK, (b) passed the output
 *      integrity check, and (c) wrote the .sha256 sidecar. If the marker exists
 *      and matches the input bundle that was actually patched, the pin is
 *      recorded — exactly what `ccpatch pin <ver>` would record — and the
 *      marker is consumed.
 *
 * Security posture preserved:
 *   - CCPATCH_NO_AUTOPIN=1 disables the auto-pin (the marker is left in place).
 *   - An EXISTING pin with a DIFFERENT sha is NEVER overwritten — that is the
 *     attack the pin exists to catch. writePin() fails closed; the caller must
 *     surface it loudly.
 *   - Without a marker (i.e. the supply-chain gate never vouched for this
 *     bundle in this build cycle) nothing is pinned.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PROJECT_ROOT } from './paths.mjs';
import { lookupVersion, writePin } from './known-shas.mjs';

/** Marker path convention shared with scripts/verify-bundle-sha.mjs. */
export function tofuMarkerPathFor(version, storageRoot = PROJECT_ROOT) {
  return path.join(storageRoot, 'storage', 'outputs', `tofu-pending-v${version}.json`);
}

/** Env kill-switch: CCPATCH_NO_AUTOPIN=1 disables the auto-pin. */
export function isAutoPinDisabled(env = process.env) {
  return env.CCPATCH_NO_AUTOPIN === '1';
}

/**
 * Attempt the auto-pin for `version` after a verified build.
 *
 * @param {object} opts
 * @param {string} opts.version        upstream version that was built
 * @param {string} opts.inputPath      the bundle file that was patched
 * @param {string} [opts.markerPath]   override (tests)
 * @param {string} [opts.registryPath] override (tests) — forwarded to known-shas
 * @param {object} [opts.env]          override (tests)
 * @returns {{ status: 'pinned'|'noop'|'skipped'|'mismatch',
 *             reason?: string, sha256?: string, error?: string }}
 *
 * Never throws. 'mismatch' means an existing pin disagrees with the verified
 * bundle — the CALLER must fail loud (this is the tamper signal the pin
 * registry exists for).
 */
export function maybeAutoPin({ version, inputPath, markerPath, registryPath, env = process.env }) {
  if (!version) return { status: 'skipped', reason: 'no version' };
  if (isAutoPinDisabled(env)) return { status: 'skipped', reason: 'CCPATCH_NO_AUTOPIN=1' };

  const mPath = markerPath ?? tofuMarkerPathFor(version);
  let marker;
  try {
    if (!fs.existsSync(mPath)) return { status: 'skipped', reason: 'no TOFU marker (supply-chain gate did not vouch for this bundle)' };
    marker = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  } catch (err) {
    return { status: 'skipped', reason: `TOFU marker unreadable: ${err.message}` };
  }
  if (!marker || marker.version !== version || !/^[0-9a-f]{64}$/i.test(String(marker.sha256 || ''))) {
    return { status: 'skipped', reason: 'TOFU marker malformed or for a different version' };
  }

  // Bind the marker to the bundle that was ACTUALLY patched: the marker only
  // vouches for the exact bytes the supply-chain gate hashed.
  let inputSha256;
  let sizeBytes;
  try {
    const buf = fs.readFileSync(inputPath);
    inputSha256 = createHash('sha256').update(buf).digest('hex');
    sizeBytes = buf.length;
  } catch (err) {
    return { status: 'skipped', reason: `could not hash input bundle: ${err.message}` };
  }
  if (inputSha256 !== String(marker.sha256).toLowerCase()) {
    return {
      status: 'skipped',
      reason: 'input bundle does not match the TOFU-verified sha256 — not pinning',
    };
  }

  const lookupArgs = registryPath ? [version, registryPath] : [version];
  const existing = lookupVersion(...lookupArgs);
  if (existing) {
    if (String(existing.cliSha256 || '').toLowerCase() === inputSha256) {
      consumeMarker(mPath);
      return { status: 'noop', sha256: inputSha256 };
    }
    // Existing pin DISAGREES — never overwrite; surface as the tamper signal.
    return {
      status: 'mismatch',
      sha256: inputSha256,
      error:
        `v${version} is already pinned with a DIFFERENT sha256.\n` +
        `  pinned:   ${String(existing.cliSha256 || '').toLowerCase()}\n` +
        `  computed: ${inputSha256}\n` +
        `Refusing to auto-pin over it — this may indicate tampering. ` +
        `Inspect storage/known-shas.json; re-pin manually with \`ccpatch pin ${version} --force\` only if intentional.`,
    };
  }

  try {
    writePin({
      version,
      cliSha256: inputSha256,
      sizeBytes,
      source: marker.source || 'auto-pin (TOFU-accepted, verified build)',
      ...(registryPath ? { registryPath } : {}),
    });
  } catch (err) {
    // A race (pin appeared between lookup and write) lands here via writePin's
    // own fail-closed mismatch guard.
    return { status: 'mismatch', sha256: inputSha256, error: err.message };
  }
  consumeMarker(mPath);
  return { status: 'pinned', sha256: inputSha256 };
}

function consumeMarker(mPath) {
  try { fs.unlinkSync(mPath); } catch { /* best effort */ }
}
