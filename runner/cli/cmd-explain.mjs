// U2: `ccpatch explain` — print the FINAL resolved patch set and, for EVERY
// known patch, WHY it is in or out (profile, ccpatch.yml flag, --patch list,
// required infra, native-incompatible, ...).
//
// This MUST reuse the exact resolution logic the default build path uses, so
// the two can't drift. Both call resolveEffectivePatches() in runner/config.mjs;
// this command only renders its {selected, reasons} output.

import path from 'node:path';

import { resolveEffectivePatches } from '../config.mjs';

/**
 * `ccpatch explain [--profile <name>] [--patch <name>...] [--json]`.
 *
 * ctx = { options, patches, logger }. `options` carries `requestedPatches`,
 * `profile`, and `json` from the parser in cli/commands.mjs.
 */
export async function runExplain(ctx) {
  const { options, patches, logger } = ctx;
  const yamlPath = path.resolve(process.cwd(), 'ccpatch.yml');

  const { selected, reasons } = resolveEffectivePatches({
    patches,
    requested: options.requestedPatches || [],
    profile: options.profile || null,
    yamlPath,
  });

  const selectedSet = new Set(selected);
  // Stable, predictable order: every known patch, sorted by name.
  const names = Object.keys(patches).sort();
  const rows = names.map(name => ({
    name,
    included: selectedSet.has(name),
    reason: reasons[name] ?? (selectedSet.has(name) ? 'in' : 'out'),
  }));

  if (options.json) {
    logger.log(JSON.stringify({
      profile: options.profile || null,
      requested: options.requestedPatches || [],
      selected,
      patches: rows,
    }, null, 2));
    return 0;
  }

  const nameW = Math.max(22, ...rows.map(r => r.name.length));
  logger.log(`${'Patch'.padEnd(nameW)}  In   Reason`);
  for (const r of rows) {
    const mark = r.included ? 'yes' : 'no ';
    logger.log(`${r.name.padEnd(nameW)}  ${mark}  ${r.reason}`);
  }
  logger.log(`\nResolved ${selected.length} patch(es) to apply` +
    (options.profile ? ` (profile=${options.profile})` : '') + '.');
  return 0;
}
