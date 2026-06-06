// A1: `ccpatch diff` handler, split out of cli.mjs.

import fs from 'node:fs';

import { readSidecar } from './sidecar.mjs';

export async function runDiff(options, logger = console) {
  const { patchedPath } = options;
  if (!fs.existsSync(patchedPath)) {
    logger.error(`Error: file not found: ${patchedPath}`);
    return 1;
  }
  const read = readSidecar(patchedPath);
  if (read.error) {
    logger.error(`Error: ${read.error}`);
    return 1;
  }
  const { sidecar, sidecarPath } = read;
  logger.log(`Sidecar: ${sidecarPath}`);
  logger.log(`  ccVersion: ${sidecar.ccVersion ?? '(unset)'}`);
  logger.log(`  timestamp: ${sidecar.timestamp}`);
  logger.log(`  patches:   ${sidecar.patches.length}`);
  logger.log('');
  logger.log('  name'.padEnd(36) + '  +added  -removed');
  for (const entry of sidecar.patches) {
    let added = 0, removed = 0;
    if (entry.splice) {
      // v2: the record carries forward-direction line counts directly.
      added = entry.added ?? 0;
      removed = entry.removed ?? 0;
    } else if (typeof entry.reverseDiff === 'string') {
      // v1 legacy: the stored diff is reverse (patched -> original). Forward
      // line counts are the inverse: '-' in reverseDiff = added by the forward
      // patch, '+' in reverseDiff = removed by the forward patch.
      for (const line of entry.reverseDiff.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
        if (line.startsWith('-')) added++;
        else if (line.startsWith('+')) removed++;
      }
    }
    logger.log(`  ${entry.name.padEnd(34)}  ${String(added).padStart(5)}  ${String(removed).padStart(7)}`);
  }
  return 0;
}
