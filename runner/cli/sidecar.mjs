// A1: Reverse-diff sidecar helpers, split out of cli.mjs. Shared by the build
// path (writes the sidecar) and by the revert/diff commands (read it). cli.mjs
// re-exports these so legacy callers keep resolving.

import fs from 'node:fs';
import { sha256 } from '../reverse-diff.mjs';

export const REVERT_SIDECAR_VERSION = 1;

export { sha256 };

export function sidecarPathFor(outputPath) {
  return outputPath + '.ccp-revert.json';
}

export function isBinaryTarget(p) {
  // v1 supports JS bundles only; Bun-compiled binaries / .exe are out of scope.
  const lower = p.toLowerCase();
  if (lower.endsWith('.mjs') || lower.endsWith('.js') || lower.endsWith('.cjs')) return false;
  if (lower.endsWith('.exe')) return true;
  // No extension or unknown extension: sniff for an ELF / Mach-O / PE header.
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true; // ELF
    if (buf[0] === 0x4d && buf[1] === 0x5a) return true; // PE / MZ
    if (buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) return true; // Mach-O
    if (buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa) return true; // Mach-O (be)
  } catch (_) { /* ignore */ }
  return false;
}

export function readSidecar(patchedPath) {
  const sidecarPath = sidecarPathFor(patchedPath);
  if (!fs.existsSync(sidecarPath)) {
    return { error: `No reverse-diff sidecar at ${sidecarPath}. The bundle was not produced by a ccpatch version that captures reverse diffs, or the sidecar was deleted.` };
  }
  let sidecar;
  try {
    sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  } catch (err) {
    return { error: `Sidecar ${sidecarPath} is not valid JSON: ${err.message}` };
  }
  if (sidecar.version !== REVERT_SIDECAR_VERSION) {
    return { error: `Sidecar version mismatch: expected ${REVERT_SIDECAR_VERSION}, got ${sidecar.version}` };
  }
  if (!Array.isArray(sidecar.patches)) {
    return { error: `Sidecar at ${sidecarPath} has no patches[] array` };
  }
  return { sidecar, sidecarPath };
}
