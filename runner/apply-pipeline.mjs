/**
 * Apply pipeline — apply → verify → record stages extracted from runner.mjs.
 *
 * Stages:
 *   - applySinglePatch  : call apply(), classify outcome, build overlap trace
 *   - recordStage       : coverage injection + reverse-diff capture (post-hook)
 *   - makeVerifyFlusher : deferred-verify phase-flush closure
 *
 * Public helpers re-exported by tests directly:
 *   - applyFallbackDiff : stored unified-diff fallback when apply() no-ops
 *   - detectDrift       : anchor-drift forensics (pure, no fs/logging)
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { structuredPatch, applyPatch } from 'diff';
import { diffSpansFromPatch } from './conflict.mjs';
import { buildDriftRecord } from './drift-record.mjs';
import { fireHook } from './lifecycle.mjs';
import { injectCoverageHit } from './coverage.mjs';
import { captureReverseDiff } from './reverse-diff.mjs';
import { verifyBatch } from './verify-batch.mjs';
import { phaseOf } from './apply-order.mjs';
import { toList } from './verify-core.mjs';
import { PROJECT_ROOT } from './paths.mjs';

/**
 * True when a normalized verify block declares at least one non-empty present
 * literal. An empty-string present is NOT a real assertion (used as a
 * manifest-valid placeholder) and does not trigger the no-change-is-fatal gate.
 */
function declaresPresent(verify) {
  if (!verify) return false;
  return toList(verify.present).some((s) => typeof s === 'string' && s.length > 0);
}

/**
 * Attempt the stored unified-diff fallback when structured apply() no-op'd.
 * Pure except for logging. Returns the fallback-applied code or null.
 *
 * Only called when the patch has something to inject (not verify.absent-only).
 *
 * @returns {string|null}
 */
export function applyFallbackDiff(preCode, normalized, name, patchOptions, logger) {
  if (!normalized.fallbackDiff || patchOptions.disableFallback) return null;
  const fd = normalized.fallbackDiff;
  try {
    const fuzz = typeof fd.fuzz === 'number' ? fd.fuzz : 3;
    const result = applyPatch(preCode, fd.patch, { fuzzFactor: fuzz });
    if (typeof result === 'string') {
      logger.log(`  [fallback] ${name}: stored-diff applied (fuzz=${fuzz}, capturedAgainst=${fd.capturedAgainst})`);
      return result;
    }
    logger.warn(`  [fallback] ${name}: stored-diff did not apply (capturedAgainst=${fd.capturedAgainst})`);
  } catch (err) {
    logger.warn(`  [fallback] ${name}: stored-diff threw: ${err.message}`);
  }
  return null;
}

/**
 * Compute anchor-drift forensics for a patch whose apply() produced no change.
 * Pure: no fs writes, no logging. Caller persists alertLine and logs candidates.
 *
 * Probes anchor.literal + verify.present + verify.absent (in priority order),
 * fuzzy-matches each against preCode, dedupes within 50-byte buckets, keeps top 3.
 *
 * @returns {{candidates: object[], verifyFailed: string[], probesCount: number, alertLine: string}}
 */
export function detectDrift(preCode, normalized, name, patchOptions) {
  // Delegates to buildDriftRecord(); this wrapper preserves the legacy return
  // shape and the runner JSONL schema (no source/status/detail fields).
  const { candidates, verifyFailed, probesCount, record } = buildDriftRecord(
    preCode,
    {
      literal: normalized.anchor?.literal ?? null,
      present: normalized.verify?.present,
      absent: normalized.verify?.absent,
    },
    { patchName: name, version: patchOptions.version ?? null },
  );
  return { candidates, verifyFailed, probesCount, alertLine: JSON.stringify(record) };
}

/**
 * Apply ONE patch's synchronous body and return an ApplyResult struct.
 *
 * Calls apply() (declarative kinds via compileKind, free kinds via patch.apply),
 * classifies the outcome, runs drift forensics on a real no-change, and builds
 * the per-phase overlap trace. Coverage injection and reverse-diff capture run
 * in the CALLER (recordStage) after the async onAfterApply hook finalizes code.
 *
 * @param {object} args
 * @param {(patch:object)=>Function} args.compileKind  declarative-kind apply synthesizer
 *
 * Returns ApplyResult:
 *   { name, status, effectiveCode, timingMs, failReason, forceFail, trace, driftEntry }
 */
export function applySinglePatch({
  name, patch, normalized, preCode, beforeOpts, atSites,
  frame, globalStrict, patchOptions, logger, warnStorageOnce, compileKind,
  storageRoot = PROJECT_ROOT,
}) {
  const bestEffort = patchOptions.bestEffort === true;
  const _patchStart = Date.now();
  // Declarative kinds (prefix/postfix/transpiler) synthesize apply() from the manifest.
  const applyFn = (normalized.kind && normalized.kind !== 'free')
    ? compileKind(patch)
    : patch.apply;
  const callOpts = atSites ? { ...beforeOpts, atSites } : beforeOpts;
  const appliedCode = applyFn(preCode, callOpts);
  const timingMs = Date.now() - _patchStart;
  if (timingMs > 5000) {
    logger.warn(`  [!] SLOW PATCH: "${name}" took ${timingMs}ms — check for catastrophic regex backtracking`);
  } else if (timingMs > 1000) {
    logger.log(`  [~] ${name}: ${timingMs}ms`);
  }
  if (typeof appliedCode !== 'string') {
    logger.error(`  [!] Patch "${name}" returned non-string (${typeof appliedCode}) — keeping code unchanged`);
    return {
      name, status: 'error', effectiveCode: null, timingMs,
      failReason: `apply() returned non-string (${typeof appliedCode})`,
      forceFail: false, trace: null, driftEntry: null,
    };
  }

  const noChange = appliedCode === preCode;
  // verify.absent-only patches describe a desired end state: no-op is correct when
  // the bad string is already absent. Only flag drift when the patch has something to inject.
  const hasOnlyAbsentVerify = normalized.verify
    && !normalized.verify.present
    && normalized.verify.absent;
  // When structured apply() no-ops, try the stored unified diff as a stop-gap.
  let fallbackAppliedCode = null;
  if (noChange && !hasOnlyAbsentVerify) {
    fallbackAppliedCode = applyFallbackDiff(preCode, normalized, name, patchOptions, logger);
  }

  let effectiveCode = appliedCode;
  let usedFallback = false;
  if (noChange && !hasOnlyAbsentVerify && fallbackAppliedCode !== null
      && fallbackAppliedCode !== preCode) {
    effectiveCode = fallbackAppliedCode;
    usedFallback = true;
  }

  let status;
  let failReason = null;
  let forceFail = false;
  let driftEntry = null;
  if (usedFallback) {
    // Stale fallback: structured apply() no-op'd; only the stored diff kept us going.
    // Strict/required treats this as FATAL; default mode warns and counts it separately.
    status = 'applied-fallback';
    failReason = 'applied via stale fallback diff (anchors have drifted — fix anchors)';
    logger.warn(`  [!] Patch "${name}" applied via STALE FALLBACK DIFF — anchors have drifted (capturedAgainst=${normalized.fallbackDiff?.capturedAgainst}). Fix anchors.`);
    if (globalStrict) forceFail = true;
  } else if (noChange && !hasOnlyAbsentVerify) {
    logger.warn(`  [!] Patch "${name}" produced no changes. (check anchors)`);
    status = 'no-change';
    failReason = 'no-change (anchor likely drifted)';
    // A patch with a real verify.present failed to inject — fatal by default unless
    // --best-effort downgrades to a warning.
    if (declaresPresent(normalized.verify) && !bestEffort) {
      forceFail = true;
    }
    // Write drift forensics to anchor-drift.jsonl and log candidates.
    try {
      const { candidates, probesCount, alertLine } = detectDrift(preCode, normalized, name, patchOptions);
      // First storage failure warns; subsequent ones are suppressed (S5).
      try {
        mkdirSync(join(storageRoot, 'storage', 'outputs'), { recursive: true });
        appendFileSync(join(storageRoot, 'storage', 'outputs', 'anchor-drift.jsonl'), alertLine + '\n', 'utf8');
      } catch (err) { warnStorageOnce('anchor-drift.jsonl', err); }

      if (candidates.length > 0) {
        driftEntry = { name, candidates: candidates.slice() };
        for (const c of candidates) {
          logger.warn(`      Closest candidate (score ${c.score.toFixed(2)}, from ${c.source}): \`${c.snippet.slice(0, 80)}\` at offset ${c.offset}`);
        }
      } else if (probesCount === 0) {
        logger.warn(`      [drift] no anchor.literal or verify.present declared — cannot offer candidates. Add verify.present to "${name}" to enable drift hints.`);
      }
    } catch (_) { /* non-fatal */ }
  } else {
    status = noChange ? 'no-change-ok' : 'applied';
  }

  // Build per-patch overlap trace.
  // Coverage and reverse-diff are captured in the CALLER (after onAfterApply);
  // the trace is based on this patch's raw apply footprint, not hook fixups.
  //
  // All ranges are translated into the shared original-bundle coordinate frame
  // by subtracting deltaBefore (net length change from all prior patches).
  // In non-strict mode diffSpans are deferred: computed only when the phase has
  // ≥2 patches (strict mode computes them eagerly to back FATAL overlap checks).
  let trace = null;
  try {
    const phaseKey = phaseOf(patch);
    const changed = typeof effectiveCode === 'string' && effectiveCode !== preCode;
    const deltaBefore = frame.deltaBefore(preCode);
    let diffSpans = null;        // null => deferred (non-strict)
    let diffSpanCount = changed ? 1 : 0;
    // Cache structuredPatch result so the lazy materialization path never recomputes it.
    let _sp = null;
    if (changed && globalStrict) {
      _sp = structuredPatch(name, name, preCode, effectiveCode, 'pre', 'post', { context: 0 });
      diffSpans = frame.shiftToOriginal(diffSpansFromPatch(preCode, _sp), deltaBefore);
      diffSpanCount = diffSpans.length;
    } else if (changed) {
      _sp = structuredPatch(name, name, preCode, effectiveCode, 'pre', 'post', { context: 0 });
    }
    const atSitesShifted = frame.shiftSites(atSites, deltaBefore);
    trace = {
      name,
      phase: phaseKey,
      atSites: atSitesShifted,
      diffSpans,
      diffSpanCount,
      changed,
      _preCode: changed ? preCode : null,
      _effectiveCode: changed ? effectiveCode : null,
      _sp,
      _deltaBefore: deltaBefore,
      allowOverlapWith: Array.isArray(normalized.allowOverlapWith) ? normalized.allowOverlapWith : [],
    };
  } catch (err) {
    // Trace build failure degrades overlap detection for this patch but never aborts the build.
    trace = null;
    (logger.debug || logger.warn)?.(`  [trace] ${name}: overlap-trace build failed (non-fatal): ${err.message}`);
  }

  return { name, status, effectiveCode, timingMs, failReason, forceFail, trace, driftEntry };
}

/**
 * Record stage: inject coverage marker and capture reverse diff for one patch.
 *
 * Runs AFTER the async onAfterApply hook so both operations target the
 * hook-finalized code. Coverage runs first so its bytes are included in
 * the reverse diff. Both are no-ops when effectiveCode === preCode.
 *
 * @param {object} args
 * @param {string} args.name
 * @param {object} args.normalized        post-validation manifest (coverageMarker)
 * @param {string} args.preCode           code this patch saw before apply
 * @param {string} args.effectiveCode     hook-finalized applied code
 * @param {object[]|null} args.atSites    resolved At-selector sites (for coverage anchor)
 * @param {object} args.lifecycleCtx      per-patch lifecycle ctx
 * @param {object} args.patchOptions      carries .dryRun / .captureReverse
 * @param {object} args.logger
 * @returns {string} final effectiveCode (coverage-instrumented when applicable)
 */
export function recordStage({
  name, normalized, preCode, effectiveCode, atSites, lifecycleCtx, patchOptions, logger,
}) {
  if (normalized.coverageMarker && effectiveCode !== preCode) {
    const instrumented = injectCoverageHit(
      preCode, effectiveCode, normalized.coverageMarker, atSites,
    );
    if (instrumented === null) {
      logger.log?.(`  [coverage] ${name}: marker "${normalized.coverageMarker}" — no instrumentation site found, skipping`);
    } else {
      effectiveCode = instrumented;
      lifecycleCtx.appliedCode = effectiveCode;
    }
  }
  // Skip the expensive createPatch call on dry runs (bundle is never written anyway).
  const reverseSink = patchOptions.dryRun ? undefined : patchOptions.captureReverse;
  captureReverseDiff(name, preCode, effectiveCode, reverseSink);

  return effectiveCode;
}

/**
 * Verify stage: return the deferred-verify phase-flush closure.
 *
 * The returned flushPendingVerify drains state.pendingVerify, runs verifyBatch
 * grouped by snapshot identity, dispatches onVerifyFail heals, and records
 * failures. Sharing state via the `state` handle (nextCode + pendingVerify)
 * keeps the orchestration loop thin.
 *
 * @param {object} args
 * @param {object} args.state    mutable shared handle: { pendingVerify, nextCode }
 * @param {string[]} args.failures
 * @param {object[]} args.verifyIssuesReport
 * @param {object} args.frame    CoordinateFrame (records onVerifyFail heal deltas)
 * @param {(verify:object, code:string)=>string[]} args.checkVerify
 * @param {object} args.logger
 * @returns {(reasonPhase: string|null)=>Promise<void>}
 */
export function makeVerifyFlusher({
  state, failures, verifyIssuesReport, frame, checkVerify, logger,
}) {
  return async function flushPendingVerify(_reasonPhase) {
    if (state.pendingVerify.length === 0) return;
    logger.debug?.(`  [verify] flushing phase "${_reasonPhase}" (${state.pendingVerify.length} pending)`);
    const batch = state.pendingVerify;
    state.pendingVerify = [];
    const groups = new Map(); // snapshot -> array of entries
    for (const e of batch) {
      const arr = groups.get(e.snapshot);
      if (arr) arr.push(e); else groups.set(e.snapshot, [e]);
    }
    const issuesByEntry = new Map();
    for (const [snapshot, entries] of groups) {
      const items = entries.map((b) => ({
        patchName: b.name,
        present: b.present,
        absent: b.absent,
        count: b.count,
      }));
      const batchResults = verifyBatch(snapshot, items);
      for (let i = 0; i < entries.length; i++) {
        issuesByEntry.set(entries[i], batchResults[i].issues);
      }
    }
    for (let i = 0; i < batch.length; i++) {
      const entry = batch[i];
      let issues = issuesByEntry.get(entry) || [];
      if (issues.length > 0 && typeof entry.patch.onVerifyFail === 'function') {
        entry.lifecycleCtx.verify.issues = issues.slice();
        entry.lifecycleCtx.attempt = 2;
        const hookRes = await fireHook(entry.patch, 'onVerifyFail', entry.lifecycleCtx, logger);
        if (!hookRes.ok) {
          if (entry.patchStrict) failures.push(`${entry.name}: onVerifyFail threw: ${hookRes.error.message}`);
        } else if (typeof hookRes.result === 'string') {
          // Re-verify against normalized.verify (post-validation truth), not raw patch.verify.
          const retryIssues = checkVerify(entry.verify, hookRes.result);
          if (retryIssues.length === 0) {
            // Record the out-of-band length change so the additive overlap-frame
            // invariant can subtract it back out for a successful self-heal.
            frame.recordHookDelta(state.nextCode.length, hookRes.result.length);
            state.nextCode = hookRes.result;
            entry.lifecycleCtx.appliedCode = hookRes.result;
            issues = [];
            logger.log(`  [hook] ${entry.name}.onVerifyFail healed verify`);
          } else {
            issues = retryIssues;
          }
        }
      }
      if (issues.length > 0) {
        verifyIssuesReport.push({ name: entry.name, issues: issues.slice() });
        for (const issue of issues) {
          logger.warn(`  [!] VERIFY FAILED: ${entry.name} — ${issue}`);
          if (entry.patchStrict) failures.push(`${entry.name}: verify: ${issue}`);
        }
      }
    }
  };
}
