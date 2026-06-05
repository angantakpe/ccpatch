import { structuredPatch } from 'diff';
import { PROJECT_ROOT } from './paths.mjs';
import { validateManifest } from './manifest.mjs';
import { resolveAt } from './at-selector.mjs';
import { compileKind } from './patch-kinds.mjs';
import { diffSpansFromPatch, detectOverlapsInPhase } from './conflict.mjs';
import { CoordinateFrame } from './coordinate-frame.mjs';
import { fireHook } from './lifecycle.mjs';
import { checkVerifyCore, toList } from './verify-core.mjs';
import { getResolvedVariant } from './loader.mjs';
import { compareVersions } from './version-resolver.mjs';
import { PHASE_ORDER, phaseOf, orderPatches } from './apply-order.mjs';
import {
  makeStorageWarnOnce,
  writeConflictsArtifact,
  writeApplyArtifacts,
} from './apply-artifacts.mjs';
import {
  applySinglePatch,
  recordStage,
  makeVerifyFlusher,
} from './apply-pipeline.mjs';


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

/**
 * Validate that all dependsOn edges in topoOrdered respect phase ordering.
 * A patch may only depend on patches in the same or an earlier phase
 * (pre < main < post). Throws on violation. Pure — reads only patches data.
 *
 * @param {string[]} topoOrdered — cycle-free patch names from topoSort
 * @param {Record<string, object>} patches — patch modules (reads .phase / .dependsOn)
 */
export function validatePhaseDepOrder(topoOrdered, patches) {
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
}

/**
 * Assemble the structured report object returned by applyNamedPatches. Pure.
 *
 * @param {Array<{name:string,ms:number}>} timings — per-patch timing entries
 * @param {Array<object>} drifts — anchor-drift entries
 * @param {object[]} verifyIssuesReport — per-patch verify failure records
 * @param {Record<string,string>} results — name -> status string map
 * @returns {{ timings, drifts, verifyIssues, noChange, appliedFallback }}
 */
export function buildPatchReport(timings, drifts, verifyIssuesReport, results) {
  const noChange = Object.values(results).filter(s => s === 'no-change').length;
  const appliedFallback = Object.values(results).filter(s => s === 'applied-fallback').length;
  return { timings, drifts, verifyIssues: verifyIssuesReport, noChange, appliedFallback };
}

/**
 * Scan each phase for overlapping patch ranges, record them in allConflicts[],
 * log them, and write the conflicts JSONL artifact.
 *
 * @param {object} phaseTraces — { pre, main, post } arrays of trace objects
 * @param {CoordinateFrame} frame
 * @param {boolean} globalStrict
 * @param {object} logger
 * @param {Function} warnStorageOnce — first-write-failure guard
 * @returns {Array<object>} allConflicts — array of conflict records
 */
export function detectAndRecordOverlaps(phaseTraces, frame, globalStrict, logger, warnStorageOnce, storageRoot = PROJECT_ROOT) {
  const allConflicts = [];
  const failures = [];
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
      // first-to-last-changed-byte envelope.
      const spResult = structuredPatch(t.name, t.name, t._preCode, t._effectiveCode, 'pre', 'post', { context: 0 });
      const raw = diffSpansFromPatch(t._preCode, spResult);
      t.diffSpans = frame.shiftToOriginal(raw, t._deltaBefore);
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
        // abort the build.
        logger.warn(`  [overlap] ${c.a} <-> ${c.b} phase="${c.phase}" (informational — non-fatal; run --log-level=debug for ranges, or --strict to gate)`);
        logger.debug?.(`  [overlap] ${msg} (informational — non-fatal)`);
      }
    }
  }
  // Conflicts JSONL is written BEFORE the strict-failure throw (so a strict
  // build that aborts still leaves the conflict forensics behind). ARCH1.
  writeConflictsArtifact(allConflicts, warnStorageOnce, storageRoot);
  return { allConflicts, failures };
}

export async function applyNamedPatches(code, patches, patchNames, logger = console, patchOptions = {}) {
  // Item 2: `nextCode` and the deferred-verify queue (`pendingVerify`) are the
  // two pieces of mutable state shared between the apply loop and the verify
  // flush stage (an onVerifyFail heal rewrites nextCode; the loop pushes into
  // pendingVerify, the flush drains it). They live on a single `state` handle so
  // makeVerifyFlusher() can read/write them without the loop and the closure
  // closing over two separate `let` bindings.
  const state = { nextCode: code, pendingVerify: [] };
  const results = {};
  // S5: run-scoped latch — first storage-write failure warns, rest stay quiet.
  const warnStorageOnce = makeStorageWarnOnce(logger);
  const globalStrict = patchOptions.strict === true;
  const storageRoot = patchOptions.storageRoot ?? PROJECT_ROOT;
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
  let currentPhase = null;
  // The additive overlap-coordinate frame owns origLength and the cumulative
  // out-of-band `hookDelta` (byte-length changes from onVerifyFail heals). See
  // runner/coordinate-frame.mjs — the span/at-site shifting and the additive
  // invariant assertion below delegate to it.
  const frame = new CoordinateFrame(code.length);
  // Verify stage (Item 2): the deferred-verify phase-flush closure. Extracted to
  // apply-pipeline.mjs; it reads/writes state.pendingVerify and state.nextCode
  // (heals) and pushes into failures / verifyIssuesReport. Behavior is identical
  // to the former inline closure.
  const flushPendingVerify = makeVerifyFlusher({
    state, failures, verifyIssuesReport, frame, checkVerify, logger,
  });

  // Enforce phase-respecting dependencies: a patch may only depend on patches
  // in the same or an earlier phase. (pre < main < post)
  // Delegated to validatePhaseDepOrder() — pure, independently testable.
  validatePhaseDepOrder(topoOrdered, patches);

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
      code: state.nextCode,
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
    // Finding #2: the frame subtracts `hookDelta` (cumulative out-of-band length
    // change from onVerifyFail heals) from BOTH sides so the invariant measures
    // the PURE patch-apply frame. nextCode and beforeCode both carry the heal
    // bytes equally, so a successful self-heal nets out and does NOT trip the
    // gate; a genuine non-additive break (a patch kind that doesn't preserve the
    // frame, or an onBeforeApply that swapped ctx.code) still diverges and throws.
    frame.assertAdditive(beforeCode, state.nextCode, code, name);

    try {
      const preCode = beforeCode;
      // Arch#2: the ~10-things-in-one-try body now lives in applySinglePatch(),
      // which returns an ApplyResult struct. We drive the run-level state
      // (results / failures / timings / drifts / phaseTraces / nextCode) off the
      // struct here, then run the async onAfterApply hook + verify push (which
      // need `await` and loop control and so must stay in the loop).
      const r = applySinglePatch({
        name, patch, normalized, preCode, beforeOpts, atSites,
        frame, globalStrict, patchOptions, logger, warnStorageOnce, compileKind,
        storageRoot,
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

        // Record stage (Item 2 — extracted to apply-pipeline.mjs recordStage):
        // inject the coverage marker and capture the reverse diff AFTER
        // onAfterApply finalized `effectiveCode`, against that final string
        // (Finding #3). Returns the coverage-instrumented final code.
        effectiveCode = recordStage({
          name, normalized, preCode, effectiveCode, atSites,
          lifecycleCtx, patchOptions, logger,
        });

        state.nextCode = effectiveCode;
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
        state.pendingVerify.push({
          name,
          patch,
          patchStrict,
          lifecycleCtx,
          snapshot: state.nextCode,
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
  // Delegated to detectAndRecordOverlaps() — independently testable.
  const { failures: overlapFailures } = detectAndRecordOverlaps(
    phaseTraces, frame, globalStrict, logger, warnStorageOnce, storageRoot,
  );
  for (const f of overlapFailures) failures.push(f);

  // Finding #1/#2: tally the loud outcomes so the build summary can surface
  // them. `noChange` patches silently injected nothing (anchors likely drifted);
  // `appliedFallback` patches only applied by replaying a stale stored diff.
  // Assembled into a structured report via buildPatchReport().
  const report = buildPatchReport(timings, drifts, verifyIssuesReport, results);
  if (report.appliedFallback > 0) {
    logger.warn('');
    logger.warn(`  [!] ${report.appliedFallback} patch(es) applied via STALE FALLBACK DIFF — anchors have drifted, fix anchors`);
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
  writeApplyArtifacts({ results, patches, phaseTraces, patchOptions, phaseOf, logger, warnStorageOnce, storageRoot });

  // Return shape (LOCKED contract — see cli.mjs apply path which reads .code +
  // .report defensively): the patched bundle (`code`), the per-patch outcome
  // map (`results`: name -> status string), and a structured `report` with
  // { timings, drifts, verifyIssues }. Callers that only need per-patch
  // outcomes can destructure: const { results } = await applyNamedPatches(...)
  // Finding #1/#2: `noChange` / `appliedFallback` counts let the build summary
  // print no-op and stale-fallback tallies prominently (see cli/build-report.mjs).
  return { code: state.nextCode, results, report };
}
