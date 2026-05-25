#!/usr/bin/env node

import { runPatchCli } from '../runner/cli.mjs';

try {
  process.exitCode = await runPatchCli(process.argv.slice(2));
} catch (err) {
  console.error(`Critical Error: ${err.message}`);
  process.exitCode = 1;
}
