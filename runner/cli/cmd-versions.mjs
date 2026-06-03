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

  // #13: collect data for --json output
  const jsonSections = [];

  const targetLabel = targetVersion ? `for target version ${targetVersion}` : '(no target version supplied)';
  if (!options.json) {
    logger.log(`Per-version patch variants ${targetLabel}:\n`);
  }

  let anyVariants = false;
  for (const { label, dir } of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = enumeratePatchNames(dir);
    const versioned = entries.filter(e => e.hasVariantDir);
    if (versioned.length === 0) continue;
    anyVariants = true;
    if (!options.json) {
      logger.log(`[${label}/]`);
    }
    const sectionEntries = [];
    for (const entry of versioned) {
      let variants = [];
      try {
        variants = scanVariantDir(entry.variantDir);
      } catch (err) {
        if (!options.json) {
          logger.log(`  ${entry.name.padEnd(32)} ERROR — ${err.message}`);
        }
        sectionEntries.push({ name: entry.name, hasDefault: !!entry.hasDefault, variants: [], picked: null, error: err.message });
        continue;
      }
      const stems = variants.map(v => v.stem);
      let picked = 'default';
      if (targetVersion) {
        const best = pickBestVariant(variants, targetVersion);
        if (best) picked = best.stem;
      }
      sectionEntries.push({ name: entry.name, hasDefault: !!entry.hasDefault, variants: stems, picked });
      if (!options.json) {
        const hasDefault = entry.hasDefault ? 'default + ' : '';
        logger.log(`  ${entry.name.padEnd(32)} variants: ${hasDefault}${stems.join(', ') || '(none)'}`);
        logger.log(`  ${''.padEnd(32)} → would pick: ${picked}`);
      }
    }
    jsonSections.push({ label, entries: sectionEntries });
    if (!options.json) {
      logger.log('');
    }
  }
  if (!anyVariants && !options.json) {
    logger.log('(no patches have per-version variant directories)');
  }

  // #13: --json output
  if (options.json) {
    const payload = { targetVersion: targetVersion ?? null };
    for (const { label, entries } of jsonSections) {
      payload[label] = entries;
    }
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  }

  return 0;
}
