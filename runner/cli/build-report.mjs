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

  // Finding #1/#2: surface the loud no-op and stale-fallback tallies the runner
  // reported (default 0 when the runner predates these fields).
  const noChange = Number.isFinite(Number(r.noChange)) ? Number(r.noChange) : 0;
  const appliedFallback = Number.isFinite(Number(r.appliedFallback)) ? Number(r.appliedFallback) : 0;
  const out = {
    ok: !!ok,
    durationMs,
    patches,
    drifts,
    summary: { applied, skipped, failed, noChange, appliedFallback },
  };
  // Coarse wall-clock phase timers (ms), when the caller supplied them. These
  // attribute total wall time across phases the per-patch transform sums can't
  // see (apply orchestration, bundle write, sidecar write, etc.).
  if (r.phases && typeof r.phases === 'object') {
    out.phases = { ...r.phases };
  }
  return out;
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
  const phases = (r.phases && typeof r.phases === 'object') ? r.phases : null;

  const lines = [];
  lines.push('─'.repeat(64));
  lines.push(`Build ${ok ? 'OK' : 'FAILED'} in ${durationMs} ms`);

  if (timings.length > 0) {
    timings.sort((a, b) => (b.ms || 0) - (a.ms || 0));
    const top = timings.slice(0, 3);
    // These are PER-PATCH transform times only (the apply() of each patch),
    // NOT wall-clock. Historically this said "Slowest patches" which implied
    // patches dominated the build — but the bulk of wall time is harness work
    // (doctor pre-pass, diff, verify, bundle write). Make that explicit below.
    lines.push('Slowest patch transforms (apply() only):');
    const w = Math.max(...top.map(t => (t.name || '').length), 8);
    for (const t of top) {
      lines.push(`  ${String(t.name).padEnd(w)}  ${String(t.ms ?? '?').padStart(5)} ms`);
    }

    // Harness overhead = total wall-clock minus the sum of per-patch transform
    // times. This is the doctor/diff/verify/write scaffolding around the actual
    // patching. Surface it so "2.3s of patches" doesn't get blamed for a 28s build.
    const patchMsTotal = timings.reduce((sum, t) => sum + (Number(t.ms) || 0), 0);
    const overheadMs = Math.max(0, (Number(durationMs) || 0) - patchMsTotal);
    lines.push(
      `Harness overhead: ${(overheadMs / 1000).toFixed(1)}s ` +
      `(doctor/diff/verify/write; patches summed ${(patchMsTotal / 1000).toFixed(1)}s)`
    );
  }

  // Coarse wall-clock phase breakdown, when the build path supplied phase
  // timers. Shown even without per-patch timings so users still see where the
  // big phases went. Labels are friendly; unknown keys fall back to the key.
  if (phases) {
    const labels = {
      apply: 'apply patches',
      bundleWrite: 'bundle write',
      sidecarWrite: 'sidecar write',
    };
    const entries = Object.entries(phases)
      .filter(([, ms]) => Number.isFinite(Number(ms)))
      .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0));
    if (entries.length > 0) {
      lines.push('Phase wall-clock:');
      const w = Math.max(...entries.map(([k]) => (labels[k] || k).length), 8);
      for (const [k, ms] of entries) {
        lines.push(`  ${String(labels[k] || k).padEnd(w)}  ${String(Math.round(Number(ms))).padStart(6)} ms`);
      }
    }
  }

  if (drifts.length > 0) {
    lines.push(`Drift: ${drifts.length} patch(es) — run \`ccpatch doctor <input.js> --suggest\` for fuzzy candidates.`);
  } else if (timings.length > 0) {
    lines.push('Drift: none.');
  }

  // Finding #1/#2: prominently surface no-op and stale-fallback tallies. A
  // no-change patch injected nothing (anchor likely drifted); an applied-fallback
  // patch only applied by replaying a diff captured against an older bundle.
  const noChange = Number.isFinite(Number(r.noChange)) ? Number(r.noChange) : 0;
  const appliedFallback = Number.isFinite(Number(r.appliedFallback)) ? Number(r.appliedFallback) : 0;
  if (appliedFallback > 0) {
    lines.push(`Stale fallback: ${appliedFallback} patch(es) applied via stale fallback diff — anchors have drifted, fix anchors.`);
  }
  if (noChange > 0) {
    lines.push(`No-op: ${noChange} patch(es) produced no changes (anchors likely drifted).`);
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
