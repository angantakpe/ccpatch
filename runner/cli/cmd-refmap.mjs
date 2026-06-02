// cmd-refmap.mjs — `ccpatch refmap` handler, extracted from cli.mjs (#1).

import fs from 'node:fs';
import path from 'node:path';

export async function runRefmap(options, logger) {
  const { buildRefmap, defaultRefmapPath, refmapsEqual } = await import('../../tools/build-refmap.mjs');
  if (!fs.existsSync(options.bundlePath)) {
    logger.error(`Error: bundle not found: ${options.bundlePath}`);
    return 2;
  }
  const code = fs.readFileSync(options.bundlePath, 'utf8');
  const refmap = buildRefmap(code, { ccVersion: options.ccVersion });
  const outPath = options.outPath || defaultRefmapPath(options.ccVersion, refmap.bundleSha256);

  if (options.check) {
    if (!fs.existsSync(outPath)) {
      logger.error(`Error: --check expected refmap at ${outPath}; not found.`);
      return 1;
    }
    let existing;
    try { existing = JSON.parse(fs.readFileSync(outPath, 'utf8')); }
    catch (err) {
      logger.error(`Error: existing refmap at ${outPath} is not valid JSON: ${err.message}`);
      return 1;
    }
    if (!refmapsEqual(existing, refmap)) {
      logger.error(`Refmap drift detected at ${outPath}. Regenerate with: ccpatch refmap ${options.bundlePath}${options.ccVersion ? ` --cc-version ${options.ccVersion}` : ''}`);
      return 1;
    }
    logger.log(`Refmap matches on-disk file: ${outPath}`);
    return 0;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(refmap, null, 2) + '\n', 'utf8');
  logger.log(`Wrote refmap: ${outPath}`);
  logger.log(`  ccVersion:   ${refmap.ccVersion ?? '(unset)'}`);
  logger.log(`  bundleSha:   ${refmap.bundleSha256.slice(0, 16)}…`);
  logger.log(`  resolved:    ${Object.keys(refmap.anchors).length}`);
  logger.log(`  misses:      ${refmap.misses.length}${refmap.misses.length ? ` (${refmap.misses.join(', ')})` : ''}`);
  return 0;
}
