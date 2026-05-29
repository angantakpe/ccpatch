// A1: `ccpatch ack` handler + THREAT_MODEL.md table parsing unit, split out of
// cli.mjs.

import fs from 'node:fs';
import path from 'node:path';

import { readAcks, writeAck } from '../config.mjs';
import { classifyRisk } from '../manifest.mjs';
import { PROJECT_ROOT } from '../paths.mjs';
import { ACK_REQUIRED_CAPS } from './capabilities.mjs';

/**
 * Parse the per-patch risk table from THREAT_MODEL.md into a name → row map.
 *
 * The doc contains GitHub-flavored markdown tables whose first column is the
 * patch name wrapped in backticks (e.g. `| `fetch_interceptor` | global ... |`).
 * We pull out the header row (to label the columns) and every data row keyed by
 * the de-backticked patch name. Best-effort: a malformed/absent file yields an
 * empty map and callers degrade gracefully.
 *
 * Returns { headers: string[]|null, rows: { [patchName]: string[] } } where each
 * row is the list of trimmed cell strings (including the leading patch-name cell).
 */
export function parseThreatModelTable(src) {
  const out = { headers: null, rows: {} };
  if (typeof src !== 'string' || src.length === 0) return out;
  const splitRow = (line) =>
    line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = splitRow(line);
    if (cells.length < 2) continue;
    // Header row: first cell literally "Patch".
    if (!out.headers && /^patch$/i.test(cells[0])) {
      out.headers = cells;
      continue;
    }
    // Separator row (| --- | --- |).
    if (cells.every(c => /^:?-{2,}:?$/.test(c) || c === '')) continue;
    const m = cells[0].match(/^`([^`]+)`$/);
    if (!m) continue;
    out.rows[m[1]] = cells;
  }
  return out;
}

/**
 * Render the THREAT_MODEL.md row for a patch as human-readable lines. Falls
 * back to a "not documented" notice when the patch has no table row.
 */
function formatThreatModelEntry(table, patchName) {
  const row = table.rows[patchName];
  if (!row) {
    return [`  (no THREAT_MODEL.md row found for "${patchName}")`];
  }
  const headers = table.headers || [];
  const lines = [];
  // Skip the first column (the patch name itself); pair the rest with headers.
  for (let i = 1; i < row.length; i++) {
    const label = headers[i] || `col${i}`;
    lines.push(`  ${label}: ${row[i]}`);
  }
  return lines.length ? lines : [`  ${row.join(' | ')}`];
}

/**
 * `ccpatch ack <patch>` — show the THREAT_MODEL.md row + declared capabilities
 * for a patch, then write/update its `ack:` entry in ccpatch.yml.
 *
 * Acknowledges the ack-required capabilities (network/exec/env) the patch
 * declares. With --dry-run it prints what would be written without touching the
 * file. ctx = { options, patches, logger }.
 */
export async function runAck(ctx) {
  const { options, patches, logger } = ctx;
  const patchName = options.ackPatch;
  if (!patchName) {
    logger.error('Usage: ccpatch ack <patch> [--all-caps] [--dry-run]');
    return 1;
  }
  const p = patches[patchName];
  if (!p) {
    logger.error(`Error: unknown patch "${patchName}". Run \`ccpatch --list\` to see available patches.`);
    return 1;
  }

  const caps = Array.isArray(p.capabilities) ? p.capabilities : [];
  const risk = classifyRisk(caps);
  const ackTargets = caps.filter(c => ACK_REQUIRED_CAPS.includes(c));
  // By default we ack only the ack-required caps; --all-caps acks the full set.
  const toAck = options.ackAllCaps ? [...caps] : ackTargets;

  // Show the THREAT_MODEL.md context.
  const tmPath = path.resolve(PROJECT_ROOT, 'THREAT_MODEL.md');
  let table = { headers: null, rows: {} };
  if (fs.existsSync(tmPath)) {
    table = parseThreatModelTable(fs.readFileSync(tmPath, 'utf8'));
  }
  logger.log(`Patch: ${patchName}`);
  logger.log(`Capabilities: ${caps.length ? caps.join(', ') : '(none)'} — risk: ${risk}`);
  logger.log('THREAT_MODEL.md:');
  for (const line of formatThreatModelEntry(table, patchName)) logger.log(line);

  if (toAck.length === 0) {
    logger.log(
      `\n"${patchName}" declares no acknowledgement-required capabilities ` +
      `(${ACK_REQUIRED_CAPS.join('/')}); nothing to write.`
    );
    return 0;
  }

  const yamlPath = path.resolve(process.cwd(), 'ccpatch.yml');
  if (options.ackDryRun) {
    const existing = readAcks(yamlPath) || {};
    const prior = Array.isArray(existing[patchName]) ? existing[patchName] : [];
    const merged = [...prior];
    for (const c of toAck) if (!merged.includes(c)) merged.push(c);
    logger.log(`\n[dry-run] would write to ${yamlPath}:`);
    logger.log(`  ${patchName}: [${merged.join(', ')}]`);
    return 0;
  }

  const res = writeAck(yamlPath, patchName, toAck);
  logger.log(
    `\nAcknowledged ${patchName} → [${res.caps.join(', ')}] ` +
    `(${res.created ? 'created' : 'updated'} ${path.basename(yamlPath)}).`
  );
  return 0;
}
