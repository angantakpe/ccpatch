/**
 * Best-effort sidecar artifact writers for the apply path, extracted out of
 * runner.mjs (task 4 — pure refactor, no behavior change). runner.mjs
 * re-exports these so the existing public surface (and importing tests) is
 * unchanged.
 *
 * All three are fs-isolated and non-fatal: a failed write routes through the
 * run-scoped warn-once latch (S5) rather than throwing.
 */

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { getResolvedVariant } from './loader.mjs';
import { PROJECT_ROOT } from './paths.mjs';

/**
 * S5: build a run-scoped "warn once" reporter for storage-write failures. The
 * FIRST failed artifact write in a run emits one logger.warn; subsequent ones
 * stay quiet so a broken storage dir doesn't spam the log. State lives on the
 * returned closure (run-scoped), NOT a module global — concurrent runs each get
 * their own latch.
 *
 * @param {object} logger
 * @returns {(label: string, err: Error) => void}
 */
export function makeStorageWarnOnce(logger) {
  let warned = false;
  return (label, err) => {
    if (warned) return;
    warned = true;
    logger.warn?.(`  [!] Storage write failed (${label}): ${err.message}. Further storage-write failures this run will be silent.`);
  };
}

/**
 * Append the overlap-conflicts JSONL sidecar. Best-effort; the first failure of
 * the run is surfaced via warnStorageOnce (S5), the rest stay quiet.
 * Kept separate from the coverage/results writes because it must run BEFORE the
 * strict-mode failure throw (the original code wrote conflicts pre-throw and
 * coverage/results post-throw).
 */
export function writeConflictsArtifact(allConflicts, warnStorageOnce) {
  if (allConflicts.length === 0) return;
  try {
    mkdirSync(join(PROJECT_ROOT, 'storage', 'outputs'), { recursive: true });
    const out = allConflicts.map(c => JSON.stringify(c)).join('\n') + '\n';
    appendFileSync(join(PROJECT_ROOT, 'storage', 'outputs', 'patch-conflicts.jsonl'), out, 'utf8');
  } catch (err) { warnStorageOnce?.('patch-conflicts.jsonl', err); }
}

/**
 * Consolidate the two post-success apply-time sidecar writes (coverage manifest,
 * patch-results catalog) into one fs-isolated helper. Returns nothing; each
 * write is best-effort and failures are logged but non-fatal.
 *
 * ARCH5: reads the resolved variant via getResolvedVariant(patch) instead of
 * patch.__resolvedVariant.
 *
 * @param {object} args
 * @param {Record<string,string>} args.results  per-patch status map
 * @param {Record<string,object>} args.patches  loaded patch modules
 * @param {object} args.phaseTraces   per-phase trace arrays (for diffSpans count)
 * @param {object} args.patchOptions  carries .version
 * @param {(p:object)=>string} args.phaseOf  phase resolver
 * @param {object} args.logger
 */
export function writeApplyArtifacts({ results, patches, phaseTraces, patchOptions, phaseOf, logger, warnStorageOnce }) {
  // 1) Apply-time coverage manifest. Always emitted; versioned filename when
  // version is known so multiple builds don't clobber each other.
  // Cross-referenced by `ccpatch coverage` against runtime hits.
  try {
    mkdirSync(join(PROJECT_ROOT, 'storage', 'outputs'), { recursive: true });
    const coverageManifest = {
      ccVersion: patchOptions.version ?? null,
      appliedAt: new Date().toISOString(),
      patches: {},
    };
    for (const name of Object.keys(results)) {
      const status = results[name];
      const patch = patches[name];
      const phase = phaseOf(patch);
      const applied = status === 'applied' || status === 'applied-fallback' || status === 'no-change-ok';
      const phaseTrace = (phaseTraces[phase] || []).find(t => t.name === name);
      // S4: prefer the cheap diffSpanCount (1/0, or exact strict count) — the
      // full span array may never have been materialised in non-strict mode.
      // Fall back to diffSpans.length for traces that carry only the array
      // (e.g. hand-built traces in unit tests / external callers).
      const diffSpans = phaseTrace
        ? (phaseTrace.diffSpanCount ?? (Array.isArray(phaseTrace.diffSpans) ? phaseTrace.diffSpans.length : 0))
        : 0;
      let reason = null;
      if (status === 'no-change') reason = 'no-change';
      else if (status === 'skipped') reason = 'skipped';
      else if (status === 'error') reason = 'error';
      const entry = { phase, applied, status, diffSpans };
      if (reason) entry.reason = reason;
      if (patch && patch.coverageMarker) entry.coverageMarker = patch.coverageMarker;
      coverageManifest.patches[name] = entry;
    }
    const tag = patchOptions.version ? `v${patchOptions.version}` : 'unknown';
    const covPath = join(PROJECT_ROOT, 'storage', 'outputs', `coverage-apply-${tag}.json`);
    writeFileSync(covPath, JSON.stringify(coverageManifest, null, 2), 'utf8');
  } catch (err) {
    // S5: route through the run-scoped warn-once latch.
    warnStorageOnce?.('coverage-apply manifest', err);
  }

  // 2) Patch-results catalog (only when version is known). Decorated with the
  // resolved variant per patch (ARCH5: via getResolvedVariant, not __resolvedVariant).
  if (patchOptions.version) {
    try {
      mkdirSync(join(PROJECT_ROOT, 'storage', 'outputs'), { recursive: true });
      const outPath = join(PROJECT_ROOT, 'storage', 'outputs', `patch-results-v${patchOptions.version}.json`);
      const decorated = {};
      for (const name of Object.keys(results)) {
        const status = results[name];
        const variant = getResolvedVariant(patches[name]);
        decorated[name] = { status, resolvedVariant: variant };
      }
      writeFileSync(outPath, JSON.stringify({
        version: patchOptions.version,
        timestamp: new Date().toISOString(),
        patches: decorated,
      }, null, 2), 'utf8');
      logger.log(`  [+] Patch results written to ${outPath}`);
    } catch (err) {
      // S5: route through the run-scoped warn-once latch.
      warnStorageOnce?.('patch-results catalog', err);
    }
  }
}
