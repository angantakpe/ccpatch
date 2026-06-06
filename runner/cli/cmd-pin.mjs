// cmd-pin.mjs — `ccpatch pin <version>` subcommand.
//
// Computes the sha256 of the extracted cli bundle for <version> (the same hash
// the verifier checks) and records it in storage/known-shas.json via the
// programmatic reader/writer in runner/known-shas.mjs.
//
// Usage:
//   ccpatch pin <version> [--source "<desc>"] [--force] [--input <path>] [--verbose]
//
// --source    Human description of the bundle origin (default: "npm cli.cjs").
// --force     Overwrite an existing pin even when the sha differs (re-pin).
// --input     Explicit path to the cli bundle to hash. Default: the standard
//             storage/archives location for the given version.
// --verbose   Also print the raw JSON entry that was written.

import fs from 'node:fs';
import path from 'node:path';
import { sha256OfFile, writePin } from '../known-shas.mjs';
import { PROJECT_ROOT } from '../paths.mjs';

/** Resolve the standard bundle path for a version if --input is not given. */
function defaultBundlePath(version) {
  // Convention: storage/archives/claude-code-v<ver>/cli.v<ver>.cjs
  return path.join(
    PROJECT_ROOT,
    'storage', 'archives',
    `claude-code-v${version}`,
    `cli.v${version}.cjs`
  );
}

/**
 * Main handler for `ccpatch pin`.
 * @param {object} ctx - { options, logger }
 * @returns {number} exit code
 */
export async function runPin(ctx) {
  const { options, logger } = ctx;

  const version = options.pinVersion;
  if (!version) {
    logger.error('Usage: ccpatch pin <version> [--source "<desc>"] [--force] [--input <path>] [--verbose]');
    return 2;
  }

  const inputPath = options.pinInput
    ? path.resolve(options.pinInput)
    : defaultBundlePath(version);

  if (!fs.existsSync(inputPath)) {
    logger.error(
      `[pin] Bundle not found for v${version}: ${inputPath}\n` +
      `  Download the version first (ccpatch build) or supply --input <path>.`
    );
    return 1;
  }

  const stat = fs.statSync(inputPath);
  const sizeBytes = stat.size;

  let cliSha256;
  try {
    cliSha256 = sha256OfFile(inputPath);
  } catch (err) {
    logger.error(`[pin] Failed to hash bundle: ${err.message}`);
    return 1;
  }

  const source = options.pinSource || 'npm cli.cjs';
  const force = !!options.pinForce;

  let result;
  try {
    result = writePin({ version, cliSha256, sizeBytes, source, force });
  } catch (err) {
    logger.error(`[pin] ${err.message}`);
    return 1;
  }

  if (result.status === 'noop') {
    logger.log(`[pin] v${version} already pinned with the same sha — nothing to do.`);
    logger.log(`  sha256: ${cliSha256}`);
    return 0;
  }

  // status === 'pinned'
  logger.log(`[pin] Pinned v${version} successfully.`);
  logger.log(`  bundle:  ${inputPath}`);
  logger.log(`  sha256:  ${cliSha256}`);
  logger.log(`  size:    ${sizeBytes} bytes`);
  logger.log(`  source:  ${source}`);

  if (options.pinVerbose) {
    const entry = { cliSha256, sizeBytes, source };
    logger.log(`\n  JSON entry written to storage/known-shas.json:`);
    logger.log(`    "${version}": ${JSON.stringify(entry, null, 4).replace(/\n/g, '\n    ')}`);
  }

  return 0;
}
