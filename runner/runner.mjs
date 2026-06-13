import { PROJECT_ROOT } from './paths.mjs';
import { validateManifest } from './manifest.mjs';
import { resolveAt } from './at-selector.mjs';
import { compileKind } from './patch-kinds.mjs';
import { structuredPatch } from 'diff';
import { diffSpansFromPatch, detectOverlapsInPhase } from './conflict.mjs';
import { sha256 } from './reverse-diff.mjs';
import { CoordinateFrame } from './coordinate-frame.mjs';
import { fireHook } from './lifecycle.mjs';
import { checkVerifyCore, toList } from './verify-core.mjs';
import { getResolvedVariant } from './loader.mjs';
import { compareVersions } from './version-resolver.mjs';
import { PHASE_ORDER, phaseOf, orderPatches } from './apply-order.mjs';
import { style, icon, isVerbose } from './cli/style.mjs';
import {
  makeStorageWarnOnce,
  writeConflictsArtifact,
  writeApplyArtifacts,
} from './apply-artifacts.mjs';
import {
  applySinglePatch,
  recordStage,
  makeVerifyFlusher,
  makeHarnessBuckets,
} from './apply-pipeline.mjs';
import { collectBootInjects, spliceBootRegistry } from './boot-registry.mjs';
import { captureReverseDiff } from './reverse-diff.mjs';


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
 * @param {object} [harness] — per-build harness-timing buckets (ms)
 * @returns {{ timings, drifts, verifyIssues, noChange, appliedFallback, harness? }}
 */
export function buildPatchReport(timings, drifts, verifyIssuesReport, results, harness = null) {
  const noChange = Object.values(results).filter(s => s === 'no-change').length;
  const appliedFallback = Object.values(results).filter(s => s === 'applied-fallback').length;
  const report = { timings, drifts, verifyIssues: verifyIssuesReport, noChange, appliedFallback };
  if (harness) report.harness = harness;
  return report;
}

/**
 * Log one overlap conflict and (in strict mode) collect its failure line.
 * Shared by the fresh detection path (detectAndRecordOverlaps) and the
 * cache-replay path (replayCachedConflicts) so both produce IDENTICAL log
 * output and strict-gate behavior for the same conflict record.
 *
 * @param {{phase,a,b,overlap:{kind,rangeA,rangeB},allowed:boolean}} record
 */
function logConflict(record, globalStrict, logger, failures) {
  const { phase, a, b, allowed } = record;
  const { kind, rangeA, rangeB } = record.overlap;
  const msg = `overlap (${kind}) phase="${phase}" ${a} <-> ${b}` +
              ` rangeA=[${rangeA[0]},${rangeA[1]}] rangeB=[${rangeB[0]},${rangeB[1]}]`;
  if (allowed) {
    // An allowlisted overlap is explicitly acknowledged (via allowOverlapWith)
    // and harmless — it fires every build for the known pairs. Demote it from
    // a warning to debug so the compact stream isn't crying wolf; --verbose
    // (--log-level=debug) still surfaces it with full ranges.
    (logger.debug || logger.warn)(`  [overlap] ${msg} (allowlisted)`);
  } else if (globalStrict) {
    // Strict: FATAL overlaps stay loud and unchanged.
    logger.warn(`  [overlap] ${msg}`);
    failures.push(
      `overlap: ${a} and ${b} touch overlapping ranges (${kind}) in phase="${phase}". ` +
      `Add allowOverlapWith: ['${b}'] to ${a} (or vice versa) to acknowledge.`
    );
  } else {
    // Non-strict mode: an unacknowledged overlap is a real WARNING (two
    // patches touched the same bytes without declaring it) — it does not
    // abort the build here, but --strict turns this exact condition into a
    // failure. Boot-point overlaps between bootInject patches no longer
    // occur at all (the registry performs one combined splice), so any
    // overlap that still fires deserves attention: either separate the
    // anchors or acknowledge with allowOverlapWith.
    logger.warn(`  [overlap] WARNING: unacknowledged overlap ${a} <-> ${b} phase="${phase}" — fix the anchors or add allowOverlapWith; --strict fails the build on this (run --log-level=debug for ranges)`);
    logger.debug?.(`  [overlap] ${msg} (unacknowledged — warning; fatal under --strict)`);
  }
}

/**
 * Replay a CACHED conflict report instead of recomputing it. Only called after
 * the caller has proven the rebuilt bundle is byte-identical to the build the
 * cache entry was recorded from (output sha256 match), so the records are
 * exactly what detectAndRecordOverlaps would re-derive. Reproduces the same
 * logging, the same strict-mode failures, and the same JSONL artifact write.
 *
 * @param {Array<object>} cachedConflicts — records as written by detectAndRecordOverlaps
 * @returns {{ allConflicts: Array<object>, failures: string[] }}
 */
export function replayCachedConflicts(cachedConflicts, globalStrict, logger, warnStorageOnce, storageRoot = PROJECT_ROOT) {
  const allConflicts = [];
  const failures = [];
  for (const record of cachedConflicts) {
    if (!record || !record.overlap) continue; // tolerate malformed cache rows
    allConflicts.push(record);
    logConflict(record, globalStrict, logger, failures);
  }
  writeConflictsArtifact(allConflicts, warnStorageOnce, storageRoot);
  return { allConflicts, failures };
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
export function detectAndRecordOverlaps(phaseTraces, frame, globalStrict, logger, warnStorageOnce, storageRoot = PROJECT_ROOT, harness = null) {
  const allConflicts = [];
  const failures = [];
  // Time the whole overlap pass (lazy span materialization + per-phase scan)
  // into the harness 'conflict' bucket. Cheap when phases have <2 patches
  // (the loop short-circuits before any structuredPatch runs).
  const _conflictStart = Date.now();
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
      //
      // Perf#4 NOTE: windowing this diff to the changed region (via a prefix/
      // suffix scan) was tried and REVERTED — it diverges from the full-bundle
      // result when a patch makes multiple edits within ONE long line, which is
      // the norm in a minified bundle. diffSpansFromPatch is line-based, so a
      // correct window would have to snap to line boundaries — and a minified
      // line can be the whole bundle, yielding no savings. See the equivalence
      // test in tests/conflict.test.mjs for the failing shape.
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
      logConflict(record, globalStrict, logger, failures);
    }
  }
  if (harness) harness.conflict = (harness.conflict || 0) + (Date.now() - _conflictStart);
  // Conflicts JSONL is written BEFORE the strict-failure throw (so a strict
  // build that aborts still leaves the conflict forensics behind). ARCH1.
  writeConflictsArtifact(allConflicts, warnStorageOnce, storageRoot);
  return { allConflicts, failures };
}

export async function applyNamedPatches(code, patches, patchNames, logger = console, patchOptions = {}) {
  // ── Boot-injection registry (arch item #6) ────────────────────────────────
  // Collect every enabled patch's declarative `bootInject` block and perform
  // EXACTLY ONE insertion at the canonical boot anchor, BEFORE any per-patch
  // apply() runs. Doing it first means every later pre-IIFE splice (contracts,
  // extension hooks, …) lands BETWEEN the registry block and the IIFE head —
  // i.e. it executes AFTER the registry's hooks, preserving the standing
  // invariant that fetch_interceptor's bus / bun_shim's polyfill exist before
  // any later boot code runs. Patches whose sentinel is already in the input
  // are skipped (per-patch idempotency: applying twice == applying once,
  // byte-identical). An anchor miss leaves the code unchanged; the affected
  // patches are then recorded as no-change below, so their verify.present
  // gate fails the build like any other anchor drift.
  const bootCollect = collectBootInjects(patches, patchNames, {
    code, options: patchOptions, logger,
  });
  const bootInjected = new Set();
  const bootSkipped = new Set(bootCollect.skipped);
  if (bootCollect.entries.length > 0) {
    const preBoot = code;
    code = spliceBootRegistry(code, bootCollect.entries, logger);
    if (code !== preBoot) {
      for (const e of bootCollect.entries) bootInjected.add(e.name);
      // Keep --emit-revert complete: the registry splice is harness work that
      // runs outside any patch's apply(), so it needs its own reverse record
      // (first in the sidecar — its preSha256 is the original bundle's hash).
      if (!patchOptions.dryRun) {
        captureReverseDiff('__boot_registry__', preBoot, code, patchOptions.captureReverse);
      }
    }
  }

  // Item 2 / Arch review: ONE apply-state struct (`run`) carries every piece of
  // mutable run state the loop stages read and write, instead of 5+ loose `let`/
  // `const` collections threaded through the phase loop. The stages already
  // half-formalized this — applySinglePatch returns an ApplyResult the loop
  // drives state off, recordStage takes the shared handle — so the struct just
  // names what was implicitly shared:
  //   nextCode      — the threaded bundle string (an onVerifyFail heal rewrites it)
  //   pendingVerify — deferred-verify queue (loop pushes, phase flush drains)
  //   carriedSha    — recordStage's carried sha256 (postSha(N) reused as preSha(N+1))
  //   results       — name -> status string map (returned to the caller)
  //   failures      — strict/required/forceFail failure lines (throws at the end)
  //   timings/drifts/verifyIssuesReport — report buckets for downstream tooling
  //   phaseTraces   — per-phase overlap traces
  //   harness       — per-build harness-timing buckets (ms): the per-patch work
  //                   that runs OUTSIDE apply() (coverage injection, reverse-diff/
  //                   hash capture, conflict span materialization, verify scans),
  //                   previously lumped into one opaque "overhead" number.
  const run = {
    nextCode: code,
    pendingVerify: [],
    carriedSha: undefined,
    results: {},
    failures: [],
    timings: [],
    drifts: [],
    verifyIssuesReport: [],
    phaseTraces: { pre: [], main: [], post: [] },
    harness: makeHarnessBuckets(),
  };
  // S5: run-scoped latch — first storage-write failure warns, rest stay quiet.
  // Also collects every failed artifact label for report.artifactsDegraded.
  const warnStorageOnce = makeStorageWarnOnce(logger);
  const globalStrict = patchOptions.strict === true;
  const storageRoot = patchOptions.storageRoot ?? PROJECT_ROOT;
  // --no-verify (fast-dev): skip the verify literal scan entirely. Patches still
  // apply; we just don't defer their verify.present/absent assertions into the
  // phase batch, so flushPendingVerify has nothing to scan. Strict mode keeps
  // verify on — silently dropping assertions there would defeat the gate.
  const skipVerify = patchOptions.skipVerify === true && !globalStrict;

  const topoOrdered = topoSort(patchNames, patches);

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
  // apply-pipeline.mjs; it reads/writes run.pendingVerify and run.nextCode
  // (heals) and pushes into run.failures / run.verifyIssuesReport. The flusher
  // takes the apply-state struct plus a slim context — not a positional list of
  // loose collections. Behavior is identical to the former inline closure.
  const flushPendingVerify = makeVerifyFlusher({
    state: run, frame, checkVerify, logger,
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
      run.results[name] = 'skipped';
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
      if (patchStrict) run.failures.push(msg);
    };

    // Validate manifest — missing verify or preload inconsistencies are fatal.
    // ARCH5: variant comes from the loader's side-Map, not patch.__resolvedVariant.
    const variant = getResolvedVariant(patch);
    const { ok: manifestOk, errors: manifestErrors, normalized } = validateManifest(patch, name + '.mjs', { variant });
    if (!manifestOk) {
      logger.error(`  [!] Manifest errors for "${name}": ${manifestErrors.join('; ')}`);
      run.results[name] = 'skipped';
      fail(`manifest invalid (${manifestErrors.join('; ')})`);
      continue;
    }
    // Per-patch roll-call is VERBOSE-only: in compact mode the build path prints
    // a single `✨ N patches applied` rollup (see cli/build-report.mjs / the
    // post-apply summary in cmd-build.mjs), so emitting one ✨ line per patch
    // here just adds 28 lines of noise. Under --verbose we still show the full
    // per-patch narrative (name + prose description) for progress tracing.
    if (isVerbose()) {
      logger.log(`  ${style.green(icon.apply)} ${style.bold(name)} ${style.dim('· ' + patch.description)}`);
    }

    // Revisit marker: nudge the maintainer when a forensic patch has reached
    // the upstream version it was supposed to be re-evaluated at.
    if (normalized.revisit && normalized.revisit.until && patchOptions.version) {
      const cmp = compareVersions(patchOptions.version, normalized.revisit.until);
      if (cmp !== null && cmp >= 0) {
        const added = normalized.revisit.addedIn ? ` (added in v${normalized.revisit.addedIn})` : '';
        logger.warn(`  [revisit] ${name}${added}: re-evaluate at v${normalized.revisit.until} — ${normalized.revisit.note}`);
      }
    }

    // Boot-only patches (a bootInject declaration with no apply()) were
    // handled by the single registry splice above — there is nothing left to
    // apply here, and no per-patch trace to feed overlap detection (the whole
    // point: same-anchor boot overlaps disappear structurally). Verify still
    // runs against the current snapshot so each patch's own sentinels and
    // counts are asserted exactly as before.
    const isBootOnly = !!patch.bootInject
      && typeof patch.apply !== 'function'
      && (normalized.kind ?? 'free') === 'free';
    if (isBootOnly) {
      run.timings.push({ name, ms: 0 });
      if (bootInjected.has(name)) {
        run.results[name] = 'applied';
      } else if (bootSkipped.has(name)) {
        // Sentinel already present in the input — idempotent re-apply.
        run.results[name] = 'no-change-ok';
      } else {
        // Collected but never injected: the registry splice found no anchor
        // (or the code fn failed). Mirror the no-change semantics of a normal
        // apply(): fatal when the patch declares verify.present, unless
        // --best-effort downgrades it (and always fatal for strict/required).
        logger.warn(`  [!] Patch "${name}" boot hook not injected (boot-registry anchor miss).`);
        run.results[name] = 'no-change';
        const reason = 'boot hook not injected (boot-registry anchor miss)';
        const hasPresent = toList(normalized.verify?.present)
          .some((s) => typeof s === 'string' && s.length > 0);
        if ((hasPresent && patchOptions.bestEffort !== true) || patchStrict) {
          run.failures.push(`${name}: ${reason}`);
        }
      }
      if (normalized.verify && !skipVerify) {
        run.pendingVerify.push({
          name,
          patch,
          patchStrict,
          lifecycleCtx: {
            name, phase: phaseOf(patch), code: run.nextCode,
            appliedCode: run.nextCode, opts: { ...patchOptions },
            verify: { issues: [] }, attempt: 1, logger,
          },
          snapshot: run.nextCode,
          verify: normalized.verify,
          present: toList(normalized.verify.present),
          absent: toList(normalized.verify.absent),
          count: normalized.verify.count,
        });
      }
      continue;
    }

    // Per-patch lifecycle context — same object every hook fire.
    const lifecycleCtx = {
      name,
      phase: phaseOf(patch),
      code: run.nextCode,
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
        run.results[name] = 'error';
        fail(`onBeforeApply threw: ${hookRes.error.message}`);
        continue;
      }
    }
    const beforeOpts = lifecycleCtx.opts;
    const beforeCode = lifecycleCtx.code;

    // String-identity threading (see runner/reverse-diff.mjs captureReverseDiff):
    // `beforeCode` must be the SAME string reference as run.nextCode — the
    // previous patch's effectiveCode — unless an onBeforeApply hook deliberately
    // replaced ctx.code. recordStage keys its carried-sha reuse
    // (postSha256(N) === preSha256(N+1)) off exactly that reference identity;
    // an accidental copy here (slice/concat/`String()`) stays CORRECT but
    // silently doubles the sha256 work, which is the dominant build cost.
    // Cheap dev-mode guard (one === compare): break loudly instead.
    if (process.env.CCPATCH_DEBUG
        && beforeCode !== run.nextCode
        && typeof patch.onBeforeApply !== 'function') {
      throw new Error(
        `[ccpatch dev] string-identity invariant broken before "${name}": preCode is not ` +
        `the same reference as run.nextCode and no onBeforeApply hook explains it. ` +
        `Thread the previous effectiveCode through unchanged — a copy silently doubles ` +
        `reverse-diff hashing (see runner/reverse-diff.mjs).`
      );
    }

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
        run.results[name] = 'error';
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
    frame.assertAdditive(beforeCode, run.nextCode, code, name);

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
      run.timings.push({ name, ms: r.timingMs });
      run.results[name] = r.status;
      // Finding #1/#2: forceFail escalates to a build failure REGARDLESS of
      // per-patch strictness (a verify.present no-change in default mode, or a
      // stale-fallback apply under strict). Otherwise fall back to the normal
      // strict/required gate via fail().
      if (r.failReason) {
        if (r.forceFail) run.failures.push(`${name}: ${r.failReason}`);
        else fail(r.failReason);
      }
      if (r.driftEntry) run.drifts.push(r.driftEntry);
      if (r.trace) {
        run.phaseTraces[r.trace.phase] = run.phaseTraces[r.trace.phase] || [];
        run.phaseTraces[r.trace.phase].push(r.trace);
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
            run.results[name] = 'error';
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
          lifecycleCtx, patchOptions, logger, state: run, harness: run.harness,
        });

        run.nextCode = effectiveCode;
        lifecycleCtx.appliedCode = effectiveCode;
      }

      // DX2: gate and source verify off `normalized.verify` (post-validation
      // truth), not the raw patch.verify. The entry also carries the normalized
      // verify block so the onVerifyFail retry re-checks against the same source.
      if (normalized.verify && !skipVerify) {
        // Defer verify into the phase batch. End-of-phase flush runs verifyBatch
        // in one linear scan per snapshot, then dispatches onVerifyFail
        // per-patch as needed. `snapshot` captures the code immediately after
        // this patch's apply() so verify sees only this patch's contribution.
        run.pendingVerify.push({
          name,
          patch,
          patchStrict,
          lifecycleCtx,
          snapshot: run.nextCode,
          verify: normalized.verify,
          present: toList(normalized.verify.present),
          absent: toList(normalized.verify.absent),
          count: normalized.verify.count,
        });
      }
    } catch (err) {
      logger.error(`  [!] Error applying patch "${name}": ${err.message}`);
      run.results[name] = 'error';
      fail(`apply() threw: ${err.message}`);
    }
  }

  // Final flush — verify the last phase's accumulated assertions in one pass.
  await flushPendingVerify(currentPhase);

  // Overlap detection: scan each phase for pairs whose ranges intersect.
  // Conflicts are reported to the logger and a JSONL sidecar regardless of
  // strict mode; in strict mode they become fatal unless allowlisted.
  // Delegated to detectAndRecordOverlaps() — independently testable.
  //
  // BUILD CACHE: when the caller (cmd-build) resolved a cache entry for this
  // exact (input, patch set, options) key AND the rebuilt bundle's sha256
  // matches the entry's recorded outputSha256 — a full end-to-end determinism
  // proof, not just a key match — the conflict report is REPLAYED from the
  // entry instead of re-deriving the per-patch diff spans (the dominant
  // harness cost on multi-patch phases). Any doubt (no entry, sha mismatch,
  // malformed records) falls open into the normal recompute below.
  const bc = patchOptions.buildCache && typeof patchOptions.buildCache === 'object'
    ? patchOptions.buildCache
    : null;
  let overlapOutcome = null;
  if (bc && bc.entry && Array.isArray(bc.entry.conflicts)) {
    try {
      const finalSha = sha256(run.nextCode);
      bc.finalSha256 = finalSha;
      if (finalSha === bc.entry.outputSha256) {
        overlapOutcome = replayCachedConflicts(
          bc.entry.conflicts, globalStrict, logger, warnStorageOnce, storageRoot,
        );
        bc.conflictsFromCache = true;
      }
    } catch (err) {
      // Cache infrastructure must never fail the build — recompute below.
      (logger.debug || logger.warn)?.(`  [cache] conflict replay failed (non-fatal, recomputing): ${err.message}`);
      overlapOutcome = null;
    }
  }
  if (!overlapOutcome) {
    overlapOutcome = detectAndRecordOverlaps(
      run.phaseTraces, frame, globalStrict, logger, warnStorageOnce, storageRoot, run.harness,
    );
  }
  // Hand the (fresh or replayed) conflict records back to the caller so a
  // fresh build can persist them into the cache entry.
  if (bc) bc.conflicts = overlapOutcome.allConflicts;
  for (const f of overlapOutcome.failures) run.failures.push(f);

  // Finding #1/#2: tally the loud outcomes so the build summary can surface
  // them. `noChange` patches silently injected nothing (anchors likely drifted);
  // `appliedFallback` patches only applied by replaying a stale stored diff.
  // Assembled into a structured report via buildPatchReport().
  const report = buildPatchReport(
    run.timings, run.drifts, run.verifyIssuesReport, run.results, run.harness,
  );
  if (report.appliedFallback > 0) {
    logger.warn('');
    logger.warn(`  [!] ${report.appliedFallback} patch(es) applied via STALE FALLBACK DIFF — anchors have drifted, fix anchors`);
    logger.warn('');
  }

  if (run.failures.length > 0) {
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
      `${run.failures.length} patch failure(s) in ${mode}:\n  - ${run.failures.join('\n  - ')}${hint}`
    );
  }

  // ARCH1: coverage-apply manifest + patch-results catalog, consolidated.
  writeApplyArtifacts({
    results: run.results, patches, phaseTraces: run.phaseTraces,
    patchOptions, phaseOf, logger, warnStorageOnce, storageRoot,
  });

  // Task 4: surface degraded sidecar writes. Every best-effort artifact write
  // (conflicts JSONL, anchor-drift JSONL, coverage-apply manifest, patch-results
  // catalog) routes its failure through the run-scoped warn-once latch, which
  // also COLLECTS each failed artifact (deduped by label). A degraded run still
  // succeeds — the bundle is fine, the forensics are incomplete — but callers
  // (build summary, --json report) can now tell the difference. Absent on the
  // happy path so the report shape is unchanged when nothing failed.
  if (warnStorageOnce.failures.length > 0) {
    report.artifactsDegraded = warnStorageOnce.failures.slice();
  }

  // Return shape (LOCKED contract — see cli.mjs apply path which reads .code +
  // .report defensively): the patched bundle (`code`), the per-patch outcome
  // map (`results`: name -> status string), and a structured `report` with
  // { timings, drifts, verifyIssues }. Callers that only need per-patch
  // outcomes can destructure: const { results } = await applyNamedPatches(...)
  // Finding #1/#2: `noChange` / `appliedFallback` counts let the build summary
  // print no-op and stale-fallback tallies prominently (see cli/build-report.mjs).
  return { code: run.nextCode, results: run.results, report };
}
