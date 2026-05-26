// `ccpatch doctor --suggest` — read storage/outputs/anchor-drift.jsonl (the
// stream both doctor and the runner append to on anchor drift), group entries
// by patch, and print the top-3 fuzzy candidates plus a copy-pasteable patch
// stub for each drifted patch.
//
// Kept independent from runDoctor so the structural split goal of the cluster
// A review is satisfied: each doctor concern lives in its own file under
// runner/cli/.

import fs from 'node:fs';
import path from 'node:path';

const DRIFT_JSONL_PATHS = [
  // The doctor itself writes here.
  path.join('storage', 'diagnostics', 'anchor-drift.jsonl'),
  // The applyNamedPatches runner writes here.
  path.join('storage', 'outputs', 'anchor-drift.jsonl'),
];

/**
 * Read every drift entry from the known anchor-drift.jsonl paths. Returns a
 * flat array; non-existent files are silently skipped.
 */
export function readDriftEntries(extraPaths = []) {
  const out = [];
  const all = [...DRIFT_JSONL_PATHS, ...extraPaths];
  for (const p of all) {
    if (!fs.existsSync(p)) continue;
    let txt;
    try { txt = fs.readFileSync(p, 'utf8'); }
    catch (_) { continue; }
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); }
      catch (_) { /* skip malformed */ }
    }
  }
  return out;
}

/**
 * Group drift entries by patch name, keeping only the most recent entry per
 * patch (anchor-drift.jsonl is append-only; we want today's signal, not last
 * week's).
 */
export function latestByPatch(entries) {
  const byName = new Map();
  for (const e of entries) {
    if (!e || !e.patch) continue;
    const prev = byName.get(e.patch);
    const ts = e.ts || '';
    if (!prev || (prev.ts || '') < ts) byName.set(e.patch, e);
  }
  return byName;
}

/**
 * Format a top-3 candidates block + copy-pasteable patch stub for a single
 * drifted patch entry. Returns the multi-line string.
 */
export function formatSuggestion(entry) {
  const lines = [];
  const candidates = Array.isArray(entry.candidates) ? entry.candidates.slice(0, 3) : [];
  lines.push(`▸ ${entry.patch}${entry.detail ? ` — ${entry.detail}` : ''}`);
  if (candidates.length === 0) {
    lines.push('    (no fuzzy candidates recorded — try re-running doctor against a fresh bundle)');
    return lines.join('\n');
  }
  for (const c of candidates) {
    const score = typeof c.score === 'number' ? c.score.toFixed(2) : '?';
    const off = typeof c.offset === 'number' ? c.offset : '?';
    lines.push(`    @${off}  score=${score}  via ${c.source}`);
    lines.push(`      probe   : ${String(c.probe || '').slice(0, 90)}`);
    lines.push(`      snippet : ${String(c.snippet || '').slice(0, 90)}`);
  }

  // Copy-pasteable stub. Use the highest-scoring candidate's snippet as the
  // proposed new anchor.literal; users can refine before committing.
  const best = candidates[0];
  const proposedLiteral = String(best.snippet || best.probe || '').slice(0, 60);
  lines.push('');
  lines.push('    Suggested patch stub:');
  lines.push('      // patches/' + entry.patch + '.mjs');
  lines.push('      anchor: {');
  lines.push(`        literal: ${JSON.stringify(proposedLiteral)},`);
  lines.push('      },');
  lines.push('      verify: {');
  lines.push(`        present: [${JSON.stringify(proposedLiteral)}],`);
  lines.push('      },');
  return lines.join('\n');
}

/**
 * The entry point invoked by `ccpatch doctor --suggest`. Aggregates drift
 * data and prints suggestions. Returns 0 unconditionally — this is an
 * advisory command, not a gate.
 */
export function runDoctorSuggest(logger = console, opts = {}) {
  const entries = readDriftEntries(opts.extraPaths || []);
  if (entries.length === 0) {
    logger.log('[suggest] no anchor-drift.jsonl entries found. Run `ccpatch doctor <bundle>` first.');
    return 0;
  }
  const byName = latestByPatch(entries);
  const drifted = [...byName.values()].filter(e => e.status && e.status !== 'ok');
  if (drifted.length === 0) {
    logger.log('[suggest] every recorded patch is healthy — nothing to suggest.');
    return 0;
  }
  logger.log(`[suggest] ${drifted.length} drifted patch(es):\n`);
  for (const entry of drifted) {
    logger.log(formatSuggestion(entry));
    logger.log('');
  }
  return 0;
}
