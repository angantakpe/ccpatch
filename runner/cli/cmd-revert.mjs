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

  let current = fs.readFileSync(patchedPath, 'utf8');
  // v1 sidecars store a unified-diff string applied via the `diff` library; v2
  // stores a minimal splice applied directly. Load applyPatch lazily, only if a
  // legacy record actually needs it.
  let applyPatch = null;

  // Apply reverse records in reverse order: last-applied patch is undone first.
  const inOrder = sidecar.patches.slice().reverse();
  for (const entry of inOrder) {
    const beforeSha = sha256(current);
    if (entry.postSha256 && entry.postSha256 !== beforeSha) {
      logger.warn(`  [!] sha mismatch before reverting "${entry.name}": expected ${entry.postSha256.slice(0, 12)}, got ${beforeSha.slice(0, 12)} — proceeding, but the bundle may have been edited since patching.`);
    }
    let restored;
    if (entry.splice) {
      // v2: exact splice. Replace the patched middle with the original middle.
      const { at, removeLen, insert } = entry.splice;
      if (
        !Number.isInteger(at) || !Number.isInteger(removeLen) ||
        at < 0 || removeLen < 0 || at + removeLen > current.length ||
        typeof insert !== 'string'
      ) {
        logger.error(`Error: malformed splice record for "${entry.name}" (at=${at}, removeLen=${removeLen}, bundle=${current.length}). The sidecar is corrupted or the bundle was modified since apply.`);
        return 1;
      }
      restored = current.slice(0, at) + insert + current.slice(at + removeLen);
    } else if (typeof entry.reverseDiff === 'string') {
      // v1 legacy: unified-diff string.
      if (!applyPatch) ({ applyPatch } = await import('diff'));
      restored = applyPatch(current, entry.reverseDiff);
      if (restored === false) {
        logger.error(`Error: failed to apply reverse diff for "${entry.name}". The patched bundle has been modified since apply, or the sidecar is corrupted.`);
        return 1;
      }
    } else {
      logger.error(`Error: revert record for "${entry.name}" has neither a splice nor a reverseDiff — sidecar is corrupted or from an unsupported version.`);
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
