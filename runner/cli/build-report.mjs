// End-of-build summary helpers.
//
// Two consumers:
//   1. The default text path prints a compact box showing slow patches, drift
//      counts, and a suggested next command.
//   2. The --json path emits a single machine-readable object matching the
//      schema requested in the cluster A review:
//        { ok, durationMs, patches: [{name, status, ms, drift?, verifyIssues?}],
//          drifts, summary: { applied, skipped, failed } }
//
// applyNamedPatches now returns { code, results, report }. Every helper below
// still treats `report` defensively (`report ?? {}`) so old-shape callers and
// partial reports do not crash the build path.

/**
 * Build a JSON build report from whatever data the runner exposed. Inputs:
 *   - ok:          overall success boolean
 *   - durationMs:  total wall time of the build
 *   - report:      runner.report (may be undefined / partial)
 *   - patchNames:  the resolved patch list we tried to apply
 *
 * Output schema documented in cluster A review (see file header).
 */
export function buildJsonReport({ ok, durationMs, report, patchNames }) {
  const r = report || {};
  const timings = Array.isArray(r.timings) ? r.timings : [];
  const drifts = Array.isArray(r.drifts) ? r.drifts : [];
  const verifyIssues = Array.isArray(r.verifyIssues) ? r.verifyIssues : [];
  const statusOf = r.statuses || {}; // { name -> 'applied' | 'skipped' | 'failed' }

  const msByName = new Map(timings.map(t => [t.name, t.ms]));
  const driftByName = new Map(drifts.map(d => [d.name, d]));
  const issuesByName = new Map();
  for (const issue of verifyIssues) {
    const n = issue.name || issue.patch;
    if (!n) continue;
    if (!issuesByName.has(n)) issuesByName.set(n, []);
    issuesByName.get(n).push(issue);
  }

  let applied = 0, skipped = 0, failed = 0;
  const patches = [];
  for (const name of patchNames) {
    const status = statusOf[name] || 'applied';
    if (status === 'applied') applied++;
    else if (status === 'skipped') skipped++;
    else if (status === 'failed') failed++;
    const entry = { name, status, ms: msByName.get(name) ?? null };
    if (driftByName.has(name)) entry.drift = driftByName.get(name);
    if (issuesByName.has(name)) entry.verifyIssues = issuesByName.get(name);
    patches.push(entry);
  }

  return {
    ok: !!ok,
    durationMs,
    patches,
    drifts,
    summary: { applied, skipped, failed },
  };
}

/**
 * Render a compact text summary box. Returns a multi-line string ready to be
 * passed to logger.log().
 *
 * Includes:
 *   - top-3 slowest patches (only when timing data is available)
 *   - drift count (zero shows a friendly "no drift" line)
 *   - a suggested next command, tailored to the build state
 */
export function renderTextSummary({ ok, durationMs, report, outputPath, drySuggest }) {
  const r = report || {};
  const timings = Array.isArray(r.timings) ? r.timings.slice() : [];
  const drifts = Array.isArray(r.drifts) ? r.drifts : [];

  const lines = [];
  lines.push('─'.repeat(64));
  lines.push(`Build ${ok ? 'OK' : 'FAILED'} in ${durationMs} ms`);

  if (timings.length > 0) {
    timings.sort((a, b) => (b.ms || 0) - (a.ms || 0));
    const top = timings.slice(0, 3);
    lines.push('Slowest patches:');
    const w = Math.max(...top.map(t => (t.name || '').length), 8);
    for (const t of top) {
      lines.push(`  ${String(t.name).padEnd(w)}  ${String(t.ms ?? '?').padStart(5)} ms`);
    }
  }

  if (drifts.length > 0) {
    lines.push(`Drift: ${drifts.length} patch(es) — run \`ccpatch doctor <input.js> --suggest\` for fuzzy candidates.`);
  } else if (timings.length > 0) {
    lines.push('Drift: none.');
  }

  if (!ok) {
    lines.push('Next: re-run with `--dry-run --strict` to inspect failures.');
  } else if (drySuggest) {
    lines.push('Next: drop --dry-run (or add --write-on-clean) to write the bundle.');
  } else if (outputPath) {
    lines.push(`Next: \`ccpatch coverage ${outputPath}\` to confirm patches execute at runtime.`);
  }

  lines.push('─'.repeat(64));
  return lines.join('\n');
}
