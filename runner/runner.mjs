import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { structuredPatch, applyPatch } from 'diff';
import { validateManifest } from './manifest.mjs';
import { resolveAt } from './at-selector.mjs';
import { compileKind } from './patch-kinds.mjs';
import { diffSpansFromPatch, detectOverlapsInPhase } from './conflict.mjs';
import { buildDriftRecord } from './drift-record.mjs';
import { fireHook } from './lifecycle.mjs';
import { injectCoverageHit } from './coverage.mjs';
import { captureReverseDiff } from './reverse-diff.mjs';
import { verifyBatch } from './verify-batch.mjs';
import { checkVerifyCore } from './verify-core.mjs';
import { getResolvedVariant } from './loader.mjs';
import { compareVersions } from './version-resolver.mjs';
import { PHASE_ORDER, phaseOf, orderPatches } from './apply-order.mjs';
import {
  makeStorageWarnOnce,
  writeConflictsArtifact,
  writeApplyArtifacts,
} from './apply-artifacts.mjs';

// Re-export the apply-artifact sidecar writers (extracted to apply-artifacts.mjs
// in the task-4 refactor) so the runner.mjs public surface — and the tests that
// import them from here — stay unchanged.
export { makeStorageWarnOnce, writeConflictsArtifact, writeApplyArtifacts };

function toList(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

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
 * Run a verify block against post-apply code. Returns an array of failure
 * descriptions (empty when all assertions pass). Supports:
 *   verify.present  string|string[]   — substrings that MUST exist.
 *   verify.absent   string|string[]   — substrings that MUST NOT exist.
 *   verify.count    number | { present?, absent? }
 *                                     — exact totals across all present/absent strings.
 *
 * Thin wrapper over checkVerifyCore() preserving this site's exact issue
 * strings ('expected present: ' / 'expected absent: ' / count with the
 * '(across K string(s))' suffix) via the 'default' message style.
 */
export function checkVerify(verify, code) {
  return checkVerifyCore(verify, code, { style: 'default' });
}

export function resolvePatchNames(patches, requestedPatches) {
  if (!requestedPatches.length) return [];
  if (requestedPatches.includes('all')) return Object.keys(patches);
  return requestedPatches;
}

export function topoSort(names, patches) {
  const visited = new Set();
  const result = [];
  const enabledSet = new Set(names);
  function visit(name, chain = []) {
    if (visited.has(name)) return;
    if (chain.includes(name)) {
      const cycle = [...chain.slice(chain.indexOf(name)), name].join(' -> ');
      throw new Error(`Circular patch dependency: ${cycle}`);
    }
    const nextChain = [...chain, name];
    const patch = patches[name];
    const deps = (patch && patch.dependsOn) ? patch.dependsOn : [];
    for (const dep of deps) {
      if (!patches[dep]) {
        throw new Error(`Patch "${name}" declares dependsOn "${dep}", but no such patch is loaded. Check for typos in core/ or extensions/.`);
      }
      if (!enabledSet.has(dep)) {
        throw new Error(`Patch "${name}" requires "${dep}", but "${dep}" is not enabled. Enable "${dep}" in ccpatch.yml or remove it from "${name}"'s dependsOn.`);
      }
      visit(dep, nextChain);
    }
    visited.add(name);
    result.push(name);
  }
  for (const name of names) visit(name);
  return result;
}

// ── ARCH1: pure helpers extracted from applyNamedPatches ────────────────────
// These are side-effect-light (or fs-isolated) functions lifted out of the main
// loop so they can be unit-tested in isolation. Behavior is identical to the
// inline code they replaced.

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
 * @returns {{candidates: Array, verifyFailed: string[], probesCount: number, alertLine: string}}
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
 * Returns an ApplyResult:
 *   { name, status, effectiveCode, timingMs, failReason, forceFail, trace, driftEntry }
 * where `status` is the results[name] value, `failReason` (or null) is passed
 * to the caller's fail(), `forceFail` (Finding #1/#2) requests the caller push
 * `failReason` into failures REGARDLESS of per-patch strictness (so the build
 * exits non-zero in default mode too), `trace` (or null) is pushed into the
 * phase's trace array, and `driftEntry` (or null) is pushed into `drifts`.
 */
function applySinglePatch({
  name, patch, normalized, preCode, beforeOpts, atSites,
  origLength, globalStrict, patchOptions, logger, warnStorageOnce,
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
        mkdirSync('storage/outputs', { recursive: true });
        appendFileSync(join('storage/outputs', 'anchor-drift.jsonl'), alertLine + '\n', 'utf8');
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
    const deltaBefore = preCode.length - origLength;
    const shift = (spans) => spans.map(([s, e]) => [s - deltaBefore, e - deltaBefore]);
    let diffSpans = null;        // null => not yet computed (non-strict, lazy)
    let diffSpanCount = changed ? 1 : 0; // cheap count for the coverage manifest
    if (changed && globalStrict) {
      const sp = structuredPatch(name, name, preCode, effectiveCode, 'pre', 'post', { context: 0 });
      diffSpans = shift(diffSpansFromPatch(preCode, sp));
      diffSpanCount = diffSpans.length;
    }
    // at-sites resolved on beforeCode (== preCode frame) → shift to original.
    const atSitesShifted = atSites
      ? atSites.map(s => ({ ...s, start: s.start - deltaBefore, end: (s.end ?? s.start) - deltaBefore }))
      : null;
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

export async function applyNamedPatches(code, patches, patchNames, logger = console, patchOptions = {}) {
  let nextCode = code;
  const results = {};
  // S5: run-scoped latch — first storage-write failure warns, rest stay quiet.
  const warnStorageOnce = makeStorageWarnOnce(logger);
  const globalStrict = patchOptions.strict === true;
  const failures = [];
  // Per-phase trace for overlap detection.
  const phaseTraces = { pre: [], main: [], post: [] };

  const topoOrdered = topoSort(patchNames, patches);

  // Report buckets — populated as patches apply, returned to caller for
  // downstream tooling (dashboards, timing budgets, drift triage).
  const timings = [];
  const drifts = [];
  const verifyIssuesReport = [];

  // Deferred verify queue, flushed at phase boundaries and at the very end.
  // Each entry snapshots the code as it was IMMEDIATELY after its own apply()
  // returned — so verify sees only that patch's contribution, never a later
  // patch's rewrite of the same span. At flush we group entries by snapshot
  // identity: consecutive no-change patches share a snapshot and get batched;
  // mutating patches each form their own group. verifyBatch then walks each
  // unique snapshot exactly once, scanning the union of all present/absent
  // literals in a single pass — replacing the old 2×N per-patch indexOf walks.
  //
  // PERF2 (MEASURED — do not collapse to a single verify-against-final):
  // The per-snapshot guarantee is load-bearing. Each mutating patch forms its
  // own snapshot group, so N mutating patches = N walks — which superficially
  // looks like the batching is "defeated". But collapsing to one end-of-phase
  // verifyBatch against the FINAL code changes outcomes: a patch P1 that injects
  // sentinel S and is then legitimately rewritten by a later same-phase P2 (S
  // removed) PASSES per-snapshot (S was present when P1 ran) but would NEWLY
  // FAIL "expected present: S" against the final code. Reproduced 2026-05:
  //   P1 apply c->c+'SENTINEL' verify.present 'SENTINEL'  => per-snapshot PASS
  //   P2 apply removes 'SENTINEL'                          => final lacks 'SENTINEL'
  //   checkVerify(P1.verify, finalCode) => ['expected present: SENTINEL']  (false fail)
  // i.e. verifying against final cannot distinguish "P1 never worked" from "P1
  // worked then P2 superseded it". Per-snapshot is the correct semantic
  // ("did THIS patch do what it claimed when it ran"), so the batching stays.
  let pendingVerify = [];
  let currentPhase = null;
  // Finding #2 (hook ordering): cumulative byte-length change introduced OUTSIDE
  // patch apply() — specifically an onVerifyFail heal that reassigns nextCode to
  // its returned (possibly differently-sized) string at a phase-boundary flush.
  // Those bytes are NOT reflected in any trace's apply-delta accounting, so the
  // additive-frame invariant (which models nextCode as original + sum of patch
  // apply deltas) would otherwise mis-add them and could falsely throw on a
  // SUCCESSFUL self-heal. We thread this into the invariant's expected-delta so a
  // heal is accounted for explicitly rather than mistaken for a broken frame.
  let hookDelta = 0;
  async function flushPendingVerify(_reasonPhase) {
    if (pendingVerify.length === 0) return;
    const batch = pendingVerify;
    pendingVerify = [];
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
            hookDelta += hookRes.result.length - nextCode.length;
            nextCode = hookRes.result;
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
  }

  // Enforce phase-respecting dependencies: a patch may only depend on patches
  // in the same or an earlier phase. (pre < main < post)
  for (const name of topoOrdered) {
    const patch = patches[name];
    if (!patch) continue;
    const phaseIdx = PHASE_ORDER[phaseOf(patch)];
    for (const dep of patch.dependsOn ?? []) {
      const depIdx = PHASE_ORDER[phaseOf(patches[dep])];
      if (depIdx > phaseIdx) {
        throw new Error(
          `Patch "${name}" (phase="${phaseOf(patch)}") depends on "${dep}" (phase="${phaseOf(patches[dep])}"), ` +
          `which runs in a later phase. Cross-phase deps must point to same-or-earlier phases.`
        );
      }
    }
  }

  // Ordering: phase (asc) dominates, then dependsOn (topological) — a dependent
  // never precedes its dependency — then `priority` (lower first) breaks ties
  // between otherwise-independent same-phase peers, then enable-list index for
  // determinism. See runner/apply-order.mjs orderPatches() for the exact
  // guarantee. `topoOrdered` (from topoSort) supplies the cycle-free node set.
  const ordered = orderPatches(patchNames, patches, topoOrdered);

  for (const name of ordered) {
    const patch = patches[name];
    if (!patch) {
      logger.warn(`  [!] Patch not found: ${name} (skipping)`);
      results[name] = 'skipped';
      continue;
    }

    // Phase transition: flush any pending verify checks against the
    // end-of-phase code before moving on.
    const thisPhase = phaseOf(patch);
    if (currentPhase !== null && thisPhase !== currentPhase) {
      await flushPendingVerify(currentPhase);
    }
    currentPhase = thisPhase;

    const patchStrict = globalStrict || patch.required === true;
    const fail = (reason) => {
      const msg = `${name}: ${reason}`;
      if (patchStrict) failures.push(msg);
    };

    // Validate manifest — missing verify or preload inconsistencies are fatal.
    // ARCH5: variant comes from the loader's side-Map, not patch.__resolvedVariant.
    const variant = getResolvedVariant(patch);
    const { ok: manifestOk, errors: manifestErrors, normalized } = validateManifest(patch, name + '.mjs', { variant });
    if (!manifestOk) {
      logger.error(`  [!] Manifest errors for "${name}": ${manifestErrors.join('; ')}`);
      results[name] = 'skipped';
      fail(`manifest invalid (${manifestErrors.join('; ')})`);
      continue;
    }
    logger.log(`  [+] Applying: ${name} - ${patch.description}`);

    // Revisit marker: nudge the maintainer when a forensic patch has reached
    // the upstream version it was supposed to be re-evaluated at.
    if (normalized.revisit && normalized.revisit.until && patchOptions.version) {
      const cmp = compareVersions(patchOptions.version, normalized.revisit.until);
      if (cmp !== null && cmp >= 0) {
        const added = normalized.revisit.addedIn ? ` (added in v${normalized.revisit.addedIn})` : '';
        logger.warn(`  [revisit] ${name}${added}: re-evaluate at v${normalized.revisit.until} — ${normalized.revisit.note}`);
      }
    }

    // Per-patch lifecycle context — same object every hook fire.
    const lifecycleCtx = {
      name,
      phase: phaseOf(patch),
      code: nextCode,
      appliedCode: null,
      opts: { ...patchOptions },
      verify: { issues: [] },
      attempt: 1,
      logger,
    };

    // onBeforeApply: patch may mutate ctx.opts or ctx.code.
    {
      const hookRes = await fireHook(patch, 'onBeforeApply', lifecycleCtx, logger);
      if (!hookRes.ok) {
        results[name] = 'error';
        fail(`onBeforeApply threw: ${hookRes.error.message}`);
        continue;
      }
    }
    const beforeOpts = lifecycleCtx.opts;
    const beforeCode = lifecycleCtx.code;

    // Resolve @At selector (if declared) before calling apply().
    let atSites = null;
    if (normalized.at) {
      const resolved = resolveAt(normalized.at, beforeCode, beforeOpts);
      if (!resolved.ok) {
        logger.error(`  [!] @At resolution failed for "${name}": ${resolved.error}`);
        if (resolved.candidates && resolved.candidates.length > 0) {
          for (const c of resolved.candidates) {
            logger.warn(`      Candidate (score ${c.score.toFixed(2)}): \`${c.snippet.slice(0, 80)}\` at offset ${c.offset}`);
          }
        }
        results[name] = 'error';
        fail(`@At: ${resolved.error}`);
        continue;
      }
      atSites = resolved.sites;
    }

    // Finding #5: assert the additive overlap-coordinate invariant BEFORE applying
    // this patch — and OUTSIDE the apply try/catch below, so a violation throws a
    // clear diagnostic instead of being downgraded to a swallowed "apply() threw".
    // The shared-frame overlap math (A2) assumes preCode is exactly
    // original + the cumulative net length change of every prior patch. `nextCode`
    // is the accumulated result of those prior patches, so its delta from the
    // original `code` is the EXPECTED deltaBefore; `beforeCode` is what this patch
    // will actually see. They diverge only if the additive frame was broken — e.g.
    // a future non-additive patch kind, or an onBeforeApply hook that replaced
    // ctx.code with an unrelated string. Subtracting both deltas from preCode would
    // then mis-translate every span and silently mis-detect overlaps.
    {
      // Finding #2: subtract `hookDelta` (cumulative out-of-band length change
      // from onVerifyFail heals) from BOTH sides so the invariant measures the
      // PURE patch-apply frame. nextCode and beforeCode both carry the heal bytes
      // equally, so a successful self-heal nets out and does NOT trip the gate;
      // a genuine non-additive break (a patch kind that doesn't preserve the
      // frame, or an onBeforeApply that swapped ctx.code) still diverges and throws.
      const expectedDeltaBefore = (nextCode.length - code.length) - hookDelta;
      const actualDeltaBefore = (beforeCode.length - code.length) - hookDelta;
      if (actualDeltaBefore !== expectedDeltaBefore) {
        throw new Error(
          `Overlap-frame invariant violated at patch "${name}": beforeCode.length-origLength-hookDelta=${actualDeltaBefore} ` +
          `but cumulative prior patch delta=${expectedDeltaBefore} (hookDelta=${hookDelta}). The shared-frame overlap math ` +
          `(A2) assumes an additive frame (preCode === original + sum of prior patch deltas + heal deltas). A non-additive ` +
          `patch kind, or an onBeforeApply hook that replaced ctx.code with an unrelated string, broke it — overlap ` +
          `detection would silently mis-translate spans. Fix the patch so it preserves the additive frame.`
        );
      }
    }

    try {
      const preCode = beforeCode;
      // Arch#2: the ~10-things-in-one-try body now lives in applySinglePatch(),
      // which returns an ApplyResult struct. We drive the run-level state
      // (results / failures / timings / drifts / phaseTraces / nextCode) off the
      // struct here, then run the async onAfterApply hook + verify push (which
      // need `await` and loop control and so must stay in the loop).
      const r = applySinglePatch({
        name, patch, normalized, preCode, beforeOpts, atSites,
        origLength: code.length, globalStrict, patchOptions, logger, warnStorageOnce,
      });
      timings.push({ name, ms: r.timingMs });
      results[name] = r.status;
      // Finding #1/#2: forceFail escalates to a build failure REGARDLESS of
      // per-patch strictness (a verify.present no-change in default mode, or a
      // stale-fallback apply under strict). Otherwise fall back to the normal
      // strict/required gate via fail().
      if (r.failReason) {
        if (r.forceFail) failures.push(`${name}: ${r.failReason}`);
        else fail(r.failReason);
      }
      if (r.driftEntry) drifts.push(r.driftEntry);
      if (r.trace) {
        phaseTraces[r.trace.phase] = phaseTraces[r.trace.phase] || [];
        phaseTraces[r.trace.phase].push(r.trace);
      }

      // Only patches that produced a usable string continue into the
      // onAfterApply hook and verify push; an 'error' status (non-string apply
      // result) leaves nextCode untouched, matching the old else-branch.
      if (r.status !== 'error') {
        let effectiveCode = r.effectiveCode;
        // onAfterApply: patch may mutate ctx.appliedCode for last-mile fixups.
        lifecycleCtx.appliedCode = effectiveCode;
        {
          const hookRes = await fireHook(patch, 'onAfterApply', lifecycleCtx, logger);
          if (!hookRes.ok) {
            results[name] = 'error';
            fail(`onAfterApply threw: ${hookRes.error.message}`);
            continue;
          }
          if (typeof lifecycleCtx.appliedCode === 'string') {
            effectiveCode = lifecycleCtx.appliedCode;
          }
        }

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

        nextCode = effectiveCode;
        lifecycleCtx.appliedCode = effectiveCode;
      }

      // DX2: gate and source verify off `normalized.verify` (post-validation
      // truth), not the raw patch.verify. The entry also carries the normalized
      // verify block so the onVerifyFail retry re-checks against the same source.
      if (normalized.verify) {
        // Defer verify into the phase batch. End-of-phase flush runs verifyBatch
        // in one linear scan per snapshot, then dispatches onVerifyFail
        // per-patch as needed. `snapshot` captures the code immediately after
        // this patch's apply() so verify sees only this patch's contribution.
        pendingVerify.push({
          name,
          patch,
          patchStrict,
          lifecycleCtx,
          snapshot: nextCode,
          verify: normalized.verify,
          present: toList(normalized.verify.present),
          absent: toList(normalized.verify.absent),
          count: normalized.verify.count,
        });
      }
    } catch (err) {
      logger.error(`  [!] Error applying patch "${name}": ${err.message}`);
      results[name] = 'error';
      fail(`apply() threw: ${err.message}`);
    }
  }

  // Final flush — verify the last phase's accumulated assertions in one pass.
  await flushPendingVerify(currentPhase);

  // Overlap detection: scan each phase for pairs whose ranges intersect.
  // Conflicts are reported to the logger and a JSONL sidecar regardless of
  // strict mode; in strict mode they become fatal unless allowlisted.
  const allConflicts = [];
  for (const phaseKey of ['pre', 'main', 'post']) {
    const traces = phaseTraces[phaseKey] || [];
    if (traces.length < 2) continue;
    // S4: only NOW — with ≥2 patches in this phase, so an overlap is actually
    // possible — do we materialise the non-strict diffSpans that were deferred
    // at apply time. The structuredPatch scan is what we deferred to avoid
    // paying it for single-patch phases; running it lazily skips it entirely
    // there. Spans are translated into the shared original-bundle frame via the
    // stored _deltaBefore so detectOverlapsInPhase compares like-for-like (A2).
    for (const t of traces) {
      if (t.diffSpans !== null) continue; // strict already computed (and shifted)
      if (!t.changed || t._preCode === null) { t.diffSpans = []; continue; }
      // Arch#1(b): decompose into per-hunk spans the SAME way strict mode does
      // (structuredPatch context:0 → diffSpansFromPatch) instead of a single
      // first-to-last-changed-byte envelope. A scatter patch (e.g.
      // unhide_features) then yields many small REAL spans rather than one
      // ~3.5MB envelope that intersects almost anything — so non-strict overlaps
      // now match what strict mode would flag as FATAL.
      const sp = structuredPatch(t.name, t.name, t._preCode, t._effectiveCode, 'pre', 'post', { context: 0 });
      const raw = diffSpansFromPatch(t._preCode, sp);
      t.diffSpans = raw.map(([s, e]) => [s - t._deltaBefore, e - t._deltaBefore]);
    }
    const conflicts = detectOverlapsInPhase(traces);
    for (const c of conflicts) {
      const aTrace = traces.find(t => t.name === c.a);
      const bTrace = traces.find(t => t.name === c.b);
      const allowed = (aTrace && aTrace.allowOverlapWith.includes(c.b))
                   || (bTrace && bTrace.allowOverlapWith.includes(c.a));
      const record = {
        ts: new Date().toISOString(),
        phase: c.phase,
        a: c.a,
        b: c.b,
        overlap: { kind: c.kind, rangeA: c.rangeA, rangeB: c.rangeB },
        allowed: !!allowed,
      };
      allConflicts.push(record);
      const msg = `overlap (${c.kind}) phase="${c.phase}" ${c.a} <-> ${c.b}` +
                  ` rangeA=[${c.rangeA[0]},${c.rangeA[1]}] rangeB=[${c.rangeB[0]},${c.rangeB[1]}]`;
      if (allowed) {
        logger.warn(`  [overlap] ${msg} (allowlisted)`);
      } else if (globalStrict) {
        // Strict: FATAL overlaps stay loud and unchanged.
        logger.warn(`  [overlap] ${msg}`);
        failures.push(
          `overlap: ${c.a} and ${c.b} touch overlapping ranges (${c.kind}) in phase="${c.phase}". ` +
          `Add allowOverlapWith: ['${c.b}'] to ${c.a} (or vice versa) to acknowledge.`
        );
      } else {
        // DX#2: in non-strict mode an overlap is informational — it does not
        // abort the build. Keep a single concise line so a tail of the log still
        // shows something happened, and route the full range detail to the
        // verbose (debug-level) sink so a normal successful build isn't spammed.
        logger.warn(`  [overlap] ${c.a} <-> ${c.b} phase="${c.phase}" (informational — non-fatal; run --log-level=debug for ranges, or --strict to gate)`);
        logger.debug?.(`  [overlap] ${msg} (informational — non-fatal)`);
      }
    }
  }
  // Conflicts JSONL is written BEFORE the strict-failure throw (so a strict
  // build that aborts still leaves the conflict forensics behind). ARCH1.
  writeConflictsArtifact(allConflicts, warnStorageOnce);

  // Finding #1/#2: tally the loud outcomes so the build summary can surface
  // them. `noChange` patches silently injected nothing (anchors likely drifted);
  // `appliedFallback` patches only applied by replaying a stale stored diff.
  const noChangeCount = Object.values(results).filter(s => s === 'no-change').length;
  const fallbackCount = Object.values(results).filter(s => s === 'applied-fallback').length;
  if (fallbackCount > 0) {
    logger.warn('');
    logger.warn(`  [!] ${fallbackCount} patch(es) applied via STALE FALLBACK DIFF — anchors have drifted, fix anchors`);
    logger.warn('');
  }

  if (failures.length > 0) {
    // The gate that produced these failures may be global strict, per-patch
    // required, OR the default-mode Finding #1/#2 escalation (a verify.present
    // patch that no-op'd / a stale-fallback apply). Keep the historical
    // strict/required labels; append the --best-effort hint outside strict so a
    // default-mode no-op failure tells the user how to downgrade it to a warning.
    const mode = globalStrict ? 'strict mode' : 'required patches';
    const hint = globalStrict
      ? ''
      : '\n  (set --best-effort or CCPATCH_BEST_EFFORT=1 to downgrade no-op/fallback failures to warnings)';
    throw new Error(
      `${failures.length} patch failure(s) in ${mode}:\n  - ${failures.join('\n  - ')}${hint}`
    );
  }

  // ARCH1: coverage-apply manifest + patch-results catalog, consolidated.
  writeApplyArtifacts({ results, patches, phaseTraces, patchOptions, phaseOf, logger, warnStorageOnce });

  // Return shape (LOCKED contract — see cli.mjs apply path which reads .code +
  // .report defensively): the patched bundle (`code`), the per-patch outcome
  // map (`results`: name -> status string), and a structured `report` with
  // { timings, drifts, verifyIssues }. Callers that only need per-patch
  // outcomes can destructure: const { results } = await applyNamedPatches(...)
  // Finding #1/#2: `noChange` / `appliedFallback` counts let the build summary
  // print no-op and stale-fallback tallies prominently (see cli/build-report.mjs).
  const report = {
    timings, drifts, verifyIssues: verifyIssuesReport,
    noChange: noChangeCount,
    appliedFallback: fallbackCount,
  };
  return { code: nextCode, results, report };
}
