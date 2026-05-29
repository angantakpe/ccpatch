import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
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

const PHASE_ORDER = { pre: 0, main: 1, post: 2 };

function phaseOf(patch) {
  return patch?.phase ?? 'main';
}

function toList(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
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

// Tiny dotted-numeric comparator for CC versions like "2.1.148".
// Returns -1 | 0 | 1, or null if either input doesn't parse.
function compareVersions(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  const pa = a.split('.').map(n => Number.parseInt(n, 10));
  const pb = b.split('.').map(n => Number.parseInt(n, 10));
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
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
 * PERF1 cheap edit-range: an O(n) two-ended divergence scan that returns a
 * single span [firstDiff, lastDiffEndInPre) describing the region of `preCode`
 * that changed. Used in the non-strict overlap-trace path in place of the full
 * structuredPatch hunk decomposition. Returns [] when the strings are equal.
 *
 * The end offset is expressed in PRE-code coordinates (the trailing common
 * suffix length is subtracted from preCode.length), matching diffSpansFromPatch
 * which also yields preCode byte ranges.
 *
 * @returns {Array<[number, number]>} 0 or 1 span
 */
export function cheapEditSpans(preCode, postCode) {
  if (preCode === postCode) return [];
  const aLen = preCode.length;
  const bLen = postCode.length;
  let start = 0;
  const maxStart = Math.min(aLen, bLen);
  while (start < maxStart && preCode.charCodeAt(start) === postCode.charCodeAt(start)) start++;
  // Common suffix length, not overlapping the common prefix.
  let suffix = 0;
  const maxSuffix = Math.min(aLen, bLen) - start;
  while (suffix < maxSuffix
    && preCode.charCodeAt(aLen - 1 - suffix) === postCode.charCodeAt(bLen - 1 - suffix)) {
    suffix++;
  }
  const end = aLen - suffix;
  if (end <= start) {
    // Pure insertion (nothing of preCode was removed): mark a zero-width-ish
    // span at the insertion point so the change is still represented.
    return [[start, Math.min(start + 1, aLen)]];
  }
  return [[start, end]];
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
    mkdirSync('storage/outputs', { recursive: true });
    const out = allConflicts.map(c => JSON.stringify(c)).join('\n') + '\n';
    appendFileSync(join('storage/outputs', 'patch-conflicts.jsonl'), out, 'utf8');
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
    mkdirSync('storage/outputs', { recursive: true });
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
    const covPath = join('storage/outputs', `coverage-apply-${tag}.json`);
    writeFileSync(covPath, JSON.stringify(coverageManifest, null, 2), 'utf8');
  } catch (err) {
    // S5: route through the run-scoped warn-once latch.
    warnStorageOnce?.('coverage-apply manifest', err);
  }

  // 2) Patch-results catalog (only when version is known). Decorated with the
  // resolved variant per patch (ARCH5: via getResolvedVariant, not __resolvedVariant).
  if (patchOptions.version) {
    try {
      mkdirSync('storage/outputs', { recursive: true });
      const outPath = join('storage/outputs', `patch-results-v${patchOptions.version}.json`);
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

  // Ordering: (phase asc, topo index asc). topoSort already produced a valid
  // linear extension of the dependsOn graph, so within a phase we preserve its
  // order verbatim — guaranteeing a dependent never precedes its dependency.
  const topoIndex = new Map(topoOrdered.map((n, i) => [n, i]));
  const ordered = topoOrdered.slice().sort((a, b) => {
    const pa = PHASE_ORDER[phaseOf(patches[a])];
    const pb = PHASE_ORDER[phaseOf(patches[b])];
    if (pa !== pb) return pa - pb;
    return topoIndex.get(a) - topoIndex.get(b);
  });

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

    try {
      const _patchStart = Date.now();
      const preCode = beforeCode;
      // For declarative kinds (prefix/postfix/transpiler), synthesize apply()
      // from the manifest. Free-kind patches use their own apply unchanged.
      const applyFn = (normalized.kind && normalized.kind !== 'free')
        ? compileKind(patch)
        : patch.apply;
      const callOpts = atSites ? { ...beforeOpts, atSites } : beforeOpts;
      const appliedCode = applyFn(preCode, callOpts);
      const _patchMs = Date.now() - _patchStart;
      timings.push({ name, ms: _patchMs });
      if (_patchMs > 5000) {
        logger.warn(`  [!] SLOW PATCH: "${name}" took ${_patchMs}ms — check for catastrophic regex backtracking`);
      } else if (_patchMs > 1000) {
        logger.log(`  [~] ${name}: ${_patchMs}ms`);
      }
      if (typeof appliedCode !== 'string') {
        logger.error(`  [!] Patch "${name}" returned non-string (${typeof appliedCode}) — keeping code unchanged`);
        results[name] = 'error';
        fail(`apply() returned non-string (${typeof appliedCode})`);
      } else {
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

        if (usedFallback) {
          results[name] = 'applied-fallback';
        } else if (noChange && !hasOnlyAbsentVerify) {
          logger.warn(`  [!] Patch "${name}" produced no changes. (check anchors)`);
          results[name] = 'no-change';
          fail('no-change (anchor likely drifted)');
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
              drifts.push({ name, candidates: candidates.slice() });
              for (const c of candidates) {
                logger.warn(`      Closest candidate (score ${c.score.toFixed(2)}, from ${c.source}): \`${c.snippet.slice(0, 80)}\` at offset ${c.offset}`);
              }
            } else if (probesCount === 0) {
              logger.warn(`      [drift] no anchor.literal or verify.present declared — cannot offer candidates. Add verify.present to "${name}" to enable drift hints.`);
            }
          } catch (_) { /* non-fatal */ }
        } else {
          results[name] = noChange ? 'no-change-ok' : 'applied';
        }
        // Capture a reverse diff from the effective post-apply code back to
        // `preCode` so the patched bundle can be restored byte-for-byte later.
        // Skip no-change applies — they contribute nothing to a revert.
        captureReverseDiff(name, preCode, effectiveCode, patchOptions.captureReverse);
        // Auto-inject __ccpCovHit() for patches that opted in via coverageMarker.
        // Best-effort: only attempt when the patch actually changed code, and
        // skip silently (with a notice) when no hook site is findable.
        if (normalized.coverageMarker && effectiveCode !== preCode) {
          const instrumented = injectCoverageHit(
            preCode, effectiveCode, normalized.coverageMarker, atSites,
          );
          if (instrumented === null) {
            logger.log?.(`  [coverage] ${name}: marker "${normalized.coverageMarker}" — no instrumentation site found, skipping`);
          } else {
            effectiveCode = instrumented;
          }
        }
        // Record per-patch trace for overlap detection.
        //
        // A2: all recorded ranges are translated into ONE shared coordinate
        // frame — original-bundle offsets — by subtracting `deltaBefore`, the
        // net length change all prior patches introduced (preCode.length minus
        // the original bundle length). preCode for this patch is exactly
        // original+prior-deltas, so this collapses every patch's spans/at-sites
        // into the same frame and detectOverlapsInPhase() can compare them
        // like-for-like. (The old code compared A's preCode offsets to B's
        // post-A offsets and "corrected" by skipping wide envelopes via an
        // IMPRECISE_SPAN_BYTES heuristic; correct coordinates make that
        // unnecessary, so both the heuristic and the `imprecise` flag are gone.)
        //
        // S4: in non-strict mode the actual diffSpans scan is DEFERRED. Overlap
        // is impossible in a phase with <2 traced patches, so for those the scan
        // never runs — the trace only needs a cheap changed/0-or-1 count for the
        // coverage-apply manifest. We stash the raw inputs (preCode, effective
        // code, frame offset) and resolve spans lazily at detection time, and
        // only for phases that actually have ≥2 patches. Strict mode still
        // computes exact per-hunk spans eagerly (they back FATAL overlaps).
        try {
          const phaseKey = phaseOf(patch);
          const changed = typeof effectiveCode === 'string' && effectiveCode !== preCode;
          // Net delta introduced before this patch ran (shared-frame shift).
          const deltaBefore = preCode.length - code.length;
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
          phaseTraces[phaseKey] = phaseTraces[phaseKey] || [];
          phaseTraces[phaseKey].push({
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
          });
        } catch (_) { /* trace is best-effort */ }
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
    // at apply time. cheapEditSpans is the ~16MB two-ended scan we were trying
    // to avoid; running it lazily skips it entirely for single-patch phases.
    // Spans are translated into the shared original-bundle frame via the stored
    // _deltaBefore so detectOverlapsInPhase compares like-for-like (A2).
    for (const t of traces) {
      if (t.diffSpans !== null) continue; // strict already computed (and shifted)
      if (!t.changed || t._preCode === null) { t.diffSpans = []; continue; }
      const raw = cheapEditSpans(t._preCode, t._effectiveCode);
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
      } else {
        logger.warn(`  [overlap] ${msg}`);
        if (globalStrict) {
          failures.push(
            `overlap: ${c.a} and ${c.b} touch overlapping ranges (${c.kind}) in phase="${c.phase}". ` +
            `Add allowOverlapWith: ['${c.b}'] to ${c.a} (or vice versa) to acknowledge.`
          );
        }
      }
    }
  }
  // Conflicts JSONL is written BEFORE the strict-failure throw (so a strict
  // build that aborts still leaves the conflict forensics behind). ARCH1.
  writeConflictsArtifact(allConflicts, warnStorageOnce);

  if (failures.length > 0) {
    const mode = globalStrict ? 'strict mode' : 'required patches';
    throw new Error(
      `${failures.length} patch failure(s) in ${mode}:\n  - ${failures.join('\n  - ')}`
    );
  }

  // ARCH1: coverage-apply manifest + patch-results catalog, consolidated.
  writeApplyArtifacts({ results, patches, phaseTraces, patchOptions, phaseOf, logger, warnStorageOnce });

  // Return shape (LOCKED contract — see cli.mjs apply path which reads .code +
  // .report defensively): the patched bundle (`code`), the per-patch outcome
  // map (`results`: name -> status string), and a structured `report` with
  // { timings, drifts, verifyIssues }. Callers that only need per-patch
  // outcomes can destructure: const { results } = await applyNamedPatches(...)
  const report = { timings, drifts, verifyIssues: verifyIssuesReport };
  return { code: nextCode, results, report };
}
