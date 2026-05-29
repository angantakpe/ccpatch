// A1: `ccpatch revert` handler, split out of cli.mjs.

import fs from 'node:fs';

import { sha256, isBinaryTarget, readSidecar } from './sidecar.mjs';

export async function runRevert(options, logger = console) {
  const { patchedPath } = options;
  if (!fs.existsSync(patchedPath)) {
    logger.error(`Error: file not found: ${patchedPath}`);
    return 1;
  }
  if (isBinaryTarget(patchedPath)) {
    logger.error(`Error: revert only supports JavaScript bundles (.mjs/.js/.cjs) in v1. ` +
      `Binary repack reversal is out of scope — re-extract from the original Bun executable instead.`);
    return 1;
  }
  const read = readSidecar(patchedPath);
  if (read.error) {
    logger.error(`Error: ${read.error}`);
    return 1;
  }
  const { sidecar } = read;

  const { applyPatch } = await import('diff');
  let current = fs.readFileSync(patchedPath, 'utf8');

  // Apply reverse diffs in reverse order: last-applied patch is undone first.
  const inOrder = sidecar.patches.slice().reverse();
  for (const entry of inOrder) {
    const beforeSha = sha256(current);
    if (entry.postSha256 && entry.postSha256 !== beforeSha) {
      logger.warn(`  [!] sha mismatch before reverting "${entry.name}": expected ${entry.postSha256.slice(0, 12)}, got ${beforeSha.slice(0, 12)} — proceeding, but the bundle may have been edited since patching.`);
    }
    const restored = applyPatch(current, entry.reverseDiff);
    if (restored === false) {
      logger.error(`Error: failed to apply reverse diff for "${entry.name}". The patched bundle has been modified since apply, or the sidecar is corrupted.`);
      return 1;
    }
    if (entry.preSha256 && sha256(restored) !== entry.preSha256) {
      logger.error(`Error: post-revert sha256 mismatch for "${entry.name}": expected ${entry.preSha256.slice(0, 12)}, got ${sha256(restored).slice(0, 12)}`);
      return 1;
    }
    current = restored;
    logger.log(`  [+] reverted: ${entry.name}`);
  }

  // The pre-state of patches[0] is the original input. Verify against the
  // recorded inputSha256 (and against patches[0].preSha256 for redundancy).
  const finalSha = sha256(current);
  const expectedSha = sidecar.inputSha256 ?? sidecar.patches[0]?.preSha256;
  if (expectedSha && finalSha !== expectedSha) {
    logger.error(`Error: restored bundle sha256 ${finalSha.slice(0, 12)} does not match original ${expectedSha.slice(0, 12)}`);
    return 1;
  }

  const outPath = options.outputPath ?? patchedPath;
  fs.writeFileSync(outPath, current, 'utf8');
  try { fs.chmodSync(outPath, 0o755); } catch (_) { /* ignore on platforms that reject */ }
  logger.log(`\nRestored ${sidecar.patches.length} patch(es). Wrote: ${outPath}`);
  return 0;
}
