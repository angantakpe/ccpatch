// cmd-fallback.mjs — `ccpatch fallback-capture` handler, extracted from cli.mjs (#1).

import fs from 'node:fs';
import path from 'node:path';

export async function runFallbackCapture(options, logger = console) {
  const { patchedPath, againstPath, patchName } = options;
  if (!fs.existsSync(patchedPath)) {
    logger.error(`Error: patched bundle not found: ${patchedPath}`);
    return 1;
  }
  if (!fs.existsSync(againstPath)) {
    logger.error(`Error: unpatched bundle not found: ${againstPath}`);
    return 1;
  }
  const unpatched = fs.readFileSync(againstPath, 'utf8');
  const patched = fs.readFileSync(patchedPath, 'utf8');
  const { createPatch } = await import('diff');
  const label = patchName || path.basename(patchedPath);
  const diffOutput = createPatch(label, unpatched, patched, 'unpatched', 'patched');
  process.stdout.write(diffOutput);
  return 0;
}
