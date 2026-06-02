/**
 * Apply pipeline — the apply → verify → record stages of applyNamedPatches,
 * extracted out of runner.mjs (Item 2 — pure refactor, NO behavior change).
 *
 * runner.mjs re-exports the public helpers (applyFallbackDiff, detectDrift) so
 * the runner.mjs public surface — and the tests that import them from there —
 * stay byte-for-byte unchanged. The stage functions (applySinglePatch,
 * recordStage, makeVerifyFlusher) are internal collaborators that applyNamedPatches
 * orchestrates in a clean loop.
 *
 * Each stage is an independently-testable unit:
 *   - applySinglePatch : apply ONE patch's body → ApplyResult struct (apply stage)
 *   - recordStage      : coverage injection + reverse-diff capture (record stage)
 *   - makeVerifyFlusher : builds the deferred-verify phase-flush closure (verify stage)
 *
 * Behavior is identical to the inline code these replaced: same log strings,
 * same artifact contents, same ordering, same error messages.
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
 * True when a normalized verify block declares at least one NON-EMPTY present
 * literal — i.e. the patch had "a positive thing to inject". An empty-string
 * present (e.g. the `{ present: '', weak: true }` placeholder used by patches
 * that only want a manifest-valid verify) is NOT a real present assertion and
 * is treated as absent for the no-change-is-fatal decision in Finding #1.
 */
function declaresPresent(verify) {
  if (!verify) return false;
  return toList(verify.present).some((s) => typeof s === 'string' && s.length > 0);
}

/**
 * Attempt the stored unified-diff fallback when structured apply() no-op'd.
 * Pure except for logging. Returns the fallback-applied code or null.
 *
 * A patch with only `verify.absent` describes a desired end-state (not a
 * transform), so a no-op there is correct — callers gate on hasOnlyAbsentVerify
 * before invoking this.
 *
 * @returns {string|null} fallback result, or null when no fallback applied
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
 * Pure: derives data only from `preCode` + `normalized` (no fs, no logging).
 * The caller is responsible for persisting `alertLine`, logging candidates, and
 * pushing into the drift report.
 *
 * Strategy: collect every stable string the patch told us to look for
 * (declared anchor.literal + verify.present + verify.absent, in that priority),
 * fuzzy-match each against preCode, dedupe within 50-byte buckets, keep top 3.
 *
 * DX2: reads only `normalized.*` (the post-validation truth), never raw patch.*.
 *
 * @returns {{candidates: object[], verifyFailed: string[], probesCount: number, alertLine: string}}
 */
export function detectDrift(preCode, normalized, name, patchOptions) {
  // A5: forensics now live in the shared buildDriftRecord() helper. This wrapper
  // keeps detectDrift's existing return shape (the caller reads candidates,
  // probesCount, alertLine) and the legacy runner JSONL schema (no source/
  // status/detail fields) by NOT passing those meta keys.
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
 * Arch#2: apply ONE patch's synchronous body and return an ApplyResult struct.
 *
 * This is the ~10-things-in-one-try block extracted verbatim: call apply()
 * (declarative kinds via compileKind, free kinds via patch.apply), classify the
 * outcome (applied / applied-fallback / no-change / no-change-ok / error),
 * compute anchor-drift forensics on a real no-change, capture the reverse diff,
 * inject the coverage marker, and build the overlap trace. Side-effects that
 * were already inline (slow-patch logging, the anchor-drift.jsonl append,
 * drift-candidate logging) stay here so behavior is byte-identical; the CALLER
 * drives `results`/`failures`/`nextCode`/`phaseTraces`/`drifts`/`timings` off
 * the returned struct, plus the async onAfterApply hook and the verify push
 * which must stay in the loop (they need `await` and loop control).
 *
 * @param {object} args
 * @param {(patch:object)=>Function} args.compileKind  declarative-kind apply synthesizer
 *
 * Returns an ApplyResult:
 *   { name, status, effectiveCode, timingMs, failReason, forceFail, trace, driftEntry }
 * where `status` is the results[name] value, `failReason` (or null) is passed
 * to the caller's fail(), `forceFail` (Finding #1/#2) requests the caller push
 * `failReason` into failures REGARDLESS of per-patch strictness (so the build
 * exits non-zero in default mode too), `trace` (or null) is pushed into the
 * phase's trace array, and `driftEntry` (or null) is pushed into `drifts`.
 */
export function applySinglePatch({
  name, patch, normalized, preCode, beforeOpts, atSites,
  frame, globalStrict, patchOptions, logger, warnStorageOnce, compileKind,
}) {
  const bestEffort = patchOptions.bestEffort === true;
  const _patchStart = Date.now();
  // For declarative kinds (prefix/postfix/transpiler), synthesize apply()
  // from the manifest. Free-kind patches use their own apply unchanged.
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
  // A patch with only `verify.absent` describes a *desired end state*, not
  // a transformation — if the bad string is already absent upstream, the
  // correct outcome is no-change. Only flag no-change as drift when the
  // patch lacks a verify (it must have transformed something) or declares
  // `verify.present` (it had a positive thing to inject).
  // DX2: read normalized.verify (post-validation truth), not raw patch.verify.
  const hasOnlyAbsentVerify = normalized.verify
    && !normalized.verify.present
    && normalized.verify.absent;
  // Fallback diff: when structured apply() returns no change, attempt the
  // stored unified diff captured against a known bundle version. This is
  // a stop-gap — drift is still real, but a good build shouldn't fail
  // when one patch's anchor moved if the textual diff still applies.
  // ARCH1: extracted into applyFallbackDiff() (pure except logging).
  let fallbackAppliedCode = null;
  if (noChange && !hasOnlyAbsentVerify) {
    fallbackAppliedCode = applyFallbackDiff(preCode, normalized, name, patchOptions, logger);
  }

  // If the fallback succeeded, treat the fallback result as the effective
  // applied code for the rest of this iteration (verify, capture, etc.).
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
    // Finding #2: a stale stored unified diff masked anchor drift. The structured
    // apply() no-op'd and we only kept going by replaying a diff captured against
    // an older bundle — a near-silent "success" that hides real drift. Make it a
    // loud, separately-counted outcome: strict mode (or required) treats it as
    // FATAL; default mode applies it but warns prominently and counts it.
    status = 'applied-fallback';
    failReason = 'applied via stale fallback diff (anchors have drifted — fix anchors)';
    logger.warn(`  [!] Patch "${name}" applied via STALE FALLBACK DIFF — anchors have drifted (capturedAgainst=${normalized.fallbackDiff?.capturedAgainst}). Fix anchors.`);
    if (globalStrict) forceFail = true;
  } else if (noChange && !hasOnlyAbsentVerify) {
    logger.warn(`  [!] Patch "${name}" produced no changes. (check anchors)`);
    status = 'no-change';
    failReason = 'no-change (anchor likely drifted)';
    // Finding #1: a patch that declared a real verify.present clearly had a
    // positive thing to inject and failed to do so. That is a build failure by
    // DEFAULT (not just under strict / required) — push it to failures so the
    // build throws and exits non-zero — UNLESS --best-effort (CCPATCH_BEST_EFFORT)
    // restores the lenient warn-only behavior. Patches with only verify.absent
    // (or no real present) keep today's no-change-is-fine semantics.
    if (declaresPresent(normalized.verify) && !bestEffort) {
      forceFail = true;
    }
    // Tag anchor-drift alert with patch name so patch-heal can route it.
    // ARCH1: forensic computation lives in the pure detectDrift() helper;
    // this block keeps the fs write + logging + report push.
    try {
      const { candidates, probesCount, alertLine } = detectDrift(preCode, normalized, name, patchOptions);
      // S5: surface only the FIRST storage failure of the run; the
      // candidate logging below still runs regardless of the write.
      try {
        mkdirSync(join(PROJECT_ROOT, 'storage', 'outputs'), { recursive: true });
        appendFileSync(join(PROJECT_ROOT, 'storage', 'outputs', 'anchor-drift.jsonl'), alertLine + '\n', 'utf8');
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
  // Finding #3 (hook ordering): the reverse-diff capture and coverage-marker
  // injection used to run HERE — against `effectiveCode` BEFORE the async
  // onAfterApply hook ran in the caller. A last-mile onAfterApply that returns
  // fresh code (different length) then left a reverse diff that no longer
  // restores byte-for-byte, and silently dropped coverage instrumentation. Both
  // now run in the CALLER, after onAfterApply resolves, against the FINAL
  // effectiveCode. The trace below is intentionally built on this patch's raw
  // apply footprint (pre-hook) — overlap detection is about what apply() touched,
  // not hook fixups.
  //
  // Record per-patch trace for overlap detection.
  //
  // A2: all recorded ranges are translated into ONE shared coordinate
  // frame — original-bundle offsets — by subtracting `deltaBefore`, the
  // net length change all prior patches introduced (preCode.length minus
  // the original bundle length). preCode for this patch is exactly
  // original+prior-deltas, so this collapses every patch's spans/at-sites
  // into the same frame and detectOverlapsInPhase() can compare them
  // like-for-like.
  //
  // S4: in non-strict mode the actual diffSpans scan is DEFERRED. Overlap
  // is impossible in a phase with <2 traced patches, so for those the scan
  // never runs — the trace only needs a cheap changed/0-or-1 count for the
  // coverage-apply manifest. Strict mode still computes exact per-hunk spans
  // eagerly (they back FATAL overlaps).
  let trace = null;
  try {
    const phaseKey = phaseOf(patch);
    const changed = typeof effectiveCode === 'string' && effectiveCode !== preCode;
    // Net delta introduced before this patch ran (shared-frame shift). The
    // additive-frame invariant (preCode === original + sum of prior deltas) is
    // asserted by the CALLER before this patch runs (Finding #5), so here it is
    // safe to derive the shift directly from preCode's length.
    const deltaBefore = frame.deltaBefore(preCode);
    let diffSpans = null;        // null => not yet computed (non-strict, lazy)
    let diffSpanCount = changed ? 1 : 0; // cheap count for the coverage manifest
    if (changed && globalStrict) {
      const sp = structuredPatch(name, name, preCode, effectiveCode, 'pre', 'post', { context: 0 });
      diffSpans = frame.shiftToOriginal(diffSpansFromPatch(preCode, sp), deltaBefore);
      diffSpanCount = diffSpans.length;
    }
    // at-sites resolved on beforeCode (== preCode frame) → shift to original.
    const atSitesShifted = frame.shiftSites(atSites, deltaBefore);
    trace = {
      name,
      phase: phaseKey,
      atSites: atSitesShifted,
      diffSpans,        // resolved now (strict) or lazily (non-strict, see below)
      diffSpanCount,    // S4: cheap 1/0 count for coverage-apply manifest
      changed,
      // Lazy-span inputs (non-strict): kept so detectOverlaps can compute
      // spans only when the phase has ≥2 patches.
      _preCode: changed ? preCode : null,
      _effectiveCode: changed ? effectiveCode : null,
      _deltaBefore: deltaBefore,
      allowOverlapWith: Array.isArray(normalized.allowOverlapWith) ? normalized.allowOverlapWith : [],
    };
  } catch (err) {
    // Finding #6: trace building is best-effort (a failure here only degrades
    // overlap detection for this patch, never the apply itself), but a silent
    // /dev/null swallow hid real bugs. Route it to the debug sink (falling back
    // to warn) so it is observable without aborting the build.
    trace = null;
    (logger.debug || logger.warn)?.(`  [trace] ${name}: overlap-trace build failed (non-fatal): ${err.message}`);
  }

  return { name, status, effectiveCode, timingMs, failReason, forceFail, trace, driftEntry };
}

/**
 * Record stage: finalize `effectiveCode` for a single applied patch by injecting
 * the coverage marker (if declared) and capturing the reverse diff. Runs AFTER
 * the async onAfterApply hook in the caller, against the hook-finalized code
 * (Finding #3). Pure except for the captureReverseDiff sidecar and the one
 * coverage-skip log line. Returns the final code to assign to nextCode.
 *
 * @param {object} args
 * @param {string} args.name
 * @param {object} args.normalized        post-validation manifest (coverageMarker)
 * @param {string} args.preCode           code this patch saw before apply
 * @param {string} args.effectiveCode     hook-finalized applied code
 * @param {object[]|null} args.atSites     resolved At-selector sites (for coverage anchor)
 * @param {object} args.lifecycleCtx       per-patch lifecycle ctx (appliedCode set on coverage)
 * @param {object} args.patchOptions       carries .dryRun / .captureReverse
 * @param {object} args.logger
 * @returns {string} the final effectiveCode (coverage-instrumented when applicable)
 */
export function recordStage({
  name, normalized, preCode, effectiveCode, atSites, lifecycleCtx, patchOptions, logger,
}) {
  // Finding #3: capture the reverse diff and inject the coverage marker
  // AFTER onAfterApply has finalized `effectiveCode`, against that final
  // string — not the pre-hook apply result. Capturing earlier (inside
  // applySinglePatch) left a reverse diff that no longer restored
  // byte-for-byte when a hook mutated the code, and dropped coverage
  // instrumentation that a hook rewrite would discard.
  //
  // Coverage runs FIRST so its marker bytes are themselves part of the
  // final bundle the reverse diff is captured against (so a revert removes
  // them too). Both are no-ops on a no-change apply (effectiveCode === preCode).
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
  // Perf#2: createPatch over the ~15MB bundle is the most expensive thing
  // per patch. A --dry-run never writes the bundle OR the .ccp-revert.json
  // sidecar, so pass nothing to skip the whole computation via
  // captureReverseDiff's explicit-request gate.
  const reverseSink = patchOptions.dryRun ? undefined : patchOptions.captureReverse;
  captureReverseDiff(name, preCode, effectiveCode, reverseSink);

  return effectiveCode;
}

/**
 * Verify stage: build the deferred-verify phase-flush closure. The returned
 * `flushPendingVerify` drains the pending-verify queue, runs verifyBatch per
 * unique snapshot, dispatches onVerifyFail heals, and records failures/reports.
 *
 * State that crosses the apply loop and the flush (nextCode for heals, the
 * failures and verifyIssuesReport buckets, the frame for hook-delta accounting)
 * is shared via the `state` handle — the closure reads/writes
 * `state.pendingVerify` and `state.nextCode` and pushes into the report arrays.
 * This keeps the orchestration loop thin while preserving the exact behavior of
 * the original inline closure (same log strings, ordering, failure messages).
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
          // DX2: re-verify against the normalized verify carried on the entry,
          // not the raw patch.verify — `normalized` is the post-validation truth.
          const retryIssues = checkVerify(entry.verify, hookRes.result);
          if (retryIssues.length === 0) {
            // Finding #2: a heal replaces nextCode with the hook's returned
            // string. Record the out-of-band length change so the overlap-frame
            // invariant can subtract it back out instead of treating it as a
            // broken additive frame and aborting a successful self-heal.
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
