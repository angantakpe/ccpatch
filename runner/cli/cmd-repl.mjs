// cmd-repl.mjs — `ccpatch repl` handler, extracted from cli.mjs (#1).

import fs from 'node:fs';

import { isBinaryTarget } from './sidecar.mjs';

export async function runReplCommand(options, logger = console) {
  const { patchedPath } = options;
  if (!fs.existsSync(patchedPath)) {
    logger.error(`Error: file not found: ${patchedPath}`);
    return 1;
  }
  if (isBinaryTarget(patchedPath)) {
    logger.error(`Error: repl only supports JavaScript bundles (.mjs/.js/.cjs) in v1. ` +
      `Bun-compiled binaries are out of scope.`);
    return 1;
  }
  const { runRepl } = await import('../../tools/repl.mjs');
  return await runRepl(patchedPath, options.replIo || {});
}
