// cmd-versions.mjs — `ccpatch versions` handler, extracted from cli.mjs (#1).

import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT } from '../paths.mjs';
import {
  enumeratePatchNames,
  scanVariantDir,
  pickBestVariant,
} from '../version-resolver.mjs';

export function runVersions(options, logger) {
  const targetVersion = options.targetVersion;
  const dirs = [
    { label: 'core', dir: path.join(PROJECT_ROOT, 'core') },
    { label: 'extensions', dir: path.join(PROJECT_ROOT, 'extensions') },
  ];

  const targetLabel = targetVersion ? `for target version ${targetVersion}` : '(no target version supplied)';
  logger.log(`Per-version patch variants ${targetLabel}:\n`);

  let anyVariants = false;
  for (const { label, dir } of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = enumeratePatchNames(dir);
    const versioned = entries.filter(e => e.hasVariantDir);
    if (versioned.length === 0) continue;
    anyVariants = true;
    logger.log(`[${label}/]`);
    for (const entry of versioned) {
      let variants = [];
      try {
        variants = scanVariantDir(entry.variantDir);
      } catch (err) {
        logger.log(`  ${entry.name.padEnd(32)} ERROR — ${err.message}`);
        continue;
      }
      const stems = variants.map(v => v.stem);
      let picked = 'default';
      if (targetVersion) {
        const best = pickBestVariant(variants, targetVersion);
        if (best) picked = best.stem;
      }
      const hasDefault = entry.hasDefault ? 'default + ' : '';
      logger.log(`  ${entry.name.padEnd(32)} variants: ${hasDefault}${stems.join(', ') || '(none)'}`);
      logger.log(`  ${''.padEnd(32)} → would pick: ${picked}`);
    }
    logger.log('');
  }
  if (!anyVariants) {
    logger.log('(no patches have per-version variant directories)');
  }
  return 0;
}
