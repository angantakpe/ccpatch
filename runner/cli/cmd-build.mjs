// A1: default (no-subcommand) build invocation, split out of cli.mjs. Applies
// patches and writes the patched bundle (plus overlay/sidecar/preload/report),
// including the capability gate and config/profile resolution it calls.

import fs from 'node:fs';
import path from 'node:path';

import { renderBuildStatusHeader } from './banner.mjs';
import { buildJsonReport, renderTextSummary } from './build-report.mjs';
import { isVerbose, icon } from './style.mjs';
import { strictVersionGate, capabilityGate, bunApiScanGate } from './build-gates.mjs';
import {
  writeShaSidecarAndAutoPin,
  copyEmbeddedSea,
  writeCapGateSentinel,
  emitOverlayArtifact,
  emitAgentsArtifacts,
  writeRevertSidecar,
  writePreloadArtifact,
} from './build-artifacts.mjs';
import { sha256 } from './sidecar.mjs';
import { applyNamedPatches } from '../runner.mjs';
import { resolveEffectivePatches } from '../config.mjs';
import {
  parseRepackSkip,
  nativeGrowPathAvailable,
  hostPlatformLabel,
  formatPlatformDegradation,
} from './native-profile.mjs';
import {
  setupBuildCache,
  storeCacheEntry,
  markNondeterministic,
  isCacheDisabled,
} from '../build-cache.mjs';

/**
 * The default (no-subcommand) build invocation: apply patches and write the
 * patched bundle (plus overlay/sidecar/preload/report). Extracted from the old
 * runPatchCli tail so the command table (DEFAULT_KEY) can dispatch to it.
 * ctx = { options, patches, logger }.
 */
export async function runBuild(ctx) {
  const { options, patches, logger } = ctx;
  let code = fs.readFileSync(options.inputPath, 'utf8');

  // ── Fast-dev / sidecar flags ────────────────────────────────────────────────
  // Three flags govern how much per-patch HARNESS work the build does. They are
  // resolved from patchOptions first (when parseBuildArgs in cli.mjs wires them)
  // and otherwise from process.argv directly, so this path works standalone:
  //   --emit-revert  emit the .ccp-revert.json reverse-diff sidecar (default OFF).
  //                  When OFF we skip reverse-diff splice capture AND its ~16MB
  //                  sha256 hashing entirely — the dominant inner-loop cost. The
  //                  release build target passes --emit-revert; `make dev` does not.
  //   --no-sidecar   skip ALL sidecar writes (.sha256 + .ccp-revert.json). Implies
  //                  no reverse-diff capture (nothing consumes it).
  //   --no-verify    skip the verify literal scan (verify.present/absent batching).
  const po = options.patchOptions || (options.patchOptions = {});
  const rawArgs = Array.isArray(process.argv) ? process.argv : [];
  const emitRevert = po.emitRevert === true || rawArgs.includes('--emit-revert');
  const noSidecar = po.noSidecar === true || rawArgs.includes('--no-sidecar');
  const noVerify = po.noVerify === true || rawArgs.includes('--no-verify');
  // Normalize back onto patchOptions so downstream (and the runner) see a single
  // source of truth regardless of which surface set the flag.
  po.emitRevert = emitRevert;
  po.noSidecar = noSidecar;
  po.noVerify = noVerify;

  // ── Feature flags / profile / --patch resolution ───────────────────────────
  // U2: precedence (explicit --patch > --profile > ccpatch.yml enabled flags,
  // plus required-infra auto-include and --profile=native auto-exclusion) lives
  // in the shared resolveEffectivePatches() so `ccpatch explain` reports the
  // SAME selection this path applies. We emit the resolver's notices verbatim to
  // preserve the historical log output.
  const yamlPath = path.resolve(process.cwd(), 'ccpatch.yml');
  const resolution = resolveEffectivePatches({
    patches,
    requested: options.requestedPatches,
    profile: options.profile,
    yamlPath,
    noRequired: po.noRequired === true,
  });
  let patchesToApply = resolution.selected;

  // Single-patch dry-run iteration: when an author dry-runs exactly ONE explicit
  // `--patch X` (not a profile, not `all`), they're iterating on that one patch.
  // Don't drag in unrelated required-infra patches and don't make them clear an
  // ack wall about capabilities those infra patches declare — that's noise for a
  // read-only preview. We narrow back to the single requested patch and relax the
  // ack gate to warn-only below. Non-dry-run and profile runs are unaffected.
  const requested = Array.isArray(options.requestedPatches) ? options.requestedPatches : [];
  const isSinglePatchDryRun =
    !!options.patchOptions?.dryRun &&
    !options.profile &&
    requested.length === 1 &&
    requested[0] !== 'all';
  let narrowedSinglePatch = false;
  if (isSinglePatchDryRun) {
    const only = requested.filter(n => patchesToApply.includes(n));
    if (only.length === 1 && patchesToApply.length > only.length) {
      patchesToApply = only;
      narrowedSinglePatch = true;
    }
  }

  // Build status header — a compact one-liner that identifies what is being
  // built. Deliberately NOT a full box: scripts/print-banner.mjs already emits
  // the project/help box at make level. Repeating a second box of the same shape
  // here reads as a duplicate header. Instead we emit a single styled line so the
  // two are visually distinct — make banner = project overview; this line = "build
  // is starting, here's the job".
  if (patchesToApply.length > 0) {
    const bannerVersion = options.patchOptions?.version || process.env.CCPATCH_CLI_VERSION || null;
    logger.log(renderBuildStatusHeader({
      version: bannerVersion,
      profile: options.profile || 'default',
      patchCount: patchesToApply.length,
      outputName: path.basename(options.outputPath),
    }));
    logger.log('');
  }

  for (const line of resolution.notices) {
    // When we've narrowed to a single dry-run patch, the resolver's
    // "auto-including N required patch(es)" notice is now stale (we just undid
    // it) — suppress it and emit a matching counter-notice instead.
    if (narrowedSinglePatch && line.includes('auto-including')) continue;
    logger.log(line);
  }
  if (narrowedSinglePatch) {
    logger.log(`  [dry-run] single --patch ${patchesToApply[0]}: not auto-including required infra patches (preview of this patch only)`);
  }

  if (patchesToApply.length === 0) {
    logger.log(`No patches specified. Use --patch <name> or --patch all.`);
    return 0;
  }

  logger.log(`Applying ${patchesToApply.length} patches...`);
  const buildStartedAt = Date.now();

  const patchOptions = options.patchOptions || {};
  if (!patchOptions.version && process.env.CCPATCH_CLI_VERSION) {
    patchOptions.version = process.env.CCPATCH_CLI_VERSION;
  }
  // Finding #1: --best-effort (parsed in cli.mjs parseBuildArgs) downgrades a
  // verify.present no-op — and a stale-fallback apply outside strict — from a
  // build FAILURE back to a warn-only no-op. Honour the CCPATCH_BEST_EFFORT=1
  // env here too, mirroring how --strict reads CCPATCH_STRICT, so the env opt-out
  // works even when the flag is set via the environment rather than the CLI.
  if (!patchOptions.bestEffort && process.env.CCPATCH_BEST_EFFORT === '1') {
    patchOptions.bestEffort = true;
  }

  // ── Pre-build gates (see runner/cli/build-gates.mjs) ─────────────────────
  // strict-version → capability ack → Bun API scan, all fail-fast before any
  // apply work. Each gate emits its own user-facing messages.
  if (!strictVersionGate(patchOptions, logger).ok) return 1;

  const capGate = capabilityGate({ patches, patchesToApply, patchOptions, isSinglePatchDryRun, logger });
  if (!capGate.ok) return 1;
  const capabilitiesGateBypassed = capGate.capabilitiesGateBypassed;

  if (!(await bunApiScanGate({ code, inputPath: options.inputPath, patchOptions, logger })).ok) return 1;

  const originalCode = code;
  let hadNoChange = false;

  const activeLogger = patchOptions.dryRun ? {
    log: (...args) => { console.log(...args); },
    warn: (...args) => {
      const msg = args.join(' ');
      if (msg.includes('produced no changes')) hadNoChange = true;
      console.warn(...args);
    },
    error: console.error,
  } : logger;

  let patchedCode;
  let strictFailed = false;
  // Cluster B will eventually have applyNamedPatches return { code, report }.
  // Read defensively so this code path keeps working through that migration.
  let runnerReport = {};

  // ── Build cache (conflict + reverse-diff phase replay) ──────────────────────
  // Both heavy harness phases are PURE functions of (input bundle bytes,
  // resolved patch set, patch source bytes, output-affecting options). Resolve a
  // content-addressed cache entry once here; the runner replays the conflict
  // report from it (validated by output sha) and we replay the reverse-diff
  // sidecar below. Disabled via CCPATCH_NO_CACHE=1, on dry-run, and whenever any
  // patch source can't be hashed (setupBuildCache returns null → fail open).
  let buildCache = null;
  if (!patchOptions.dryRun && !isCacheDisabled()) {
    try {
      buildCache = setupBuildCache({
        code, patches, patchNames: patchesToApply, patchOptions,
        storageRoot: patchOptions.storageRoot,
      });
    } catch (err) {
      logger.debug?.(`  [cache] setup skipped (non-fatal): ${err.message}`);
      buildCache = null;
    }
  }
  patchOptions.buildCache = buildCache;

  // Reverse-diff capture is OPT-IN: only collect splices (and pay their ~16MB
  // sha256 per changed patch) when --emit-revert is set and sidecars are not
  // suppressed. Otherwise leave captureReverse undefined so captureReverseDiff()
  // short-circuits on its `!Array.isArray` guard — no splice, no hashing.
  //
  // CACHE: when a cache entry carries a reverse-diff for this exact key, skip
  // capture entirely (no hashing) and adopt the cached array AFTER the rebuilt
  // bundle's output sha validates the entry. If validation fails (stale /
  // non-deterministic), we recompute by re-running the apply with capture on —
  // a rare fail-open path, kept correct over fast.
  const wantReverseDiff = emitRevert && !noSidecar;
  const reverseCacheCandidate = wantReverseDiff
    && !!buildCache?.entry && Array.isArray(buildCache.entry.reverseDiff);
  let captureReverse = wantReverseDiff && !reverseCacheCandidate ? [] : undefined;
  patchOptions.captureReverse = captureReverse;
  // --no-verify: skip the verify literal scan entirely. Threaded to the runner
  // so the verify-batch flush is a no-op (see applyNamedPatches).
  if (noVerify) patchOptions.skipVerify = true;
  // Coarse wall-clock phase timers (ms). Filled in as each major phase runs so
  // the end-of-run report can attribute wall time beyond the per-patch
  // transform sums. Defensive: applyNamedPatches may later expose its own
  // finer-grained timings under report.phases — we merge ours, never assume its.
  const phaseMs = {};
  const applyStartedAt = Date.now();
  try {
    const ret = await applyNamedPatches(code, patches, patchesToApply, activeLogger, patchOptions);
    if (ret && typeof ret === 'object' && typeof ret.code === 'string') {
      patchedCode = ret.code;
      runnerReport = ret.report || {};
    } else {
      patchedCode = ret;
    }
  } catch (err) {
    if (patchOptions.dryRun) {
      strictFailed = true;
      patchedCode = code; // best-effort: show whatever was applied before the throw
      logger.error(`[dry-run] Strict failure: ${err.message}`);
    } else {
      throw err;
    }
  }
  phaseMs.apply = Date.now() - applyStartedAt;

  // Compact post-apply summary: in non-verbose mode, print a single headline
  // after the per-patch ✨ lines that runner.mjs emitted.  Gives the total count
  // and surfaces drift/skipped at a glance without forcing the reader to count
  // individual patch lines.  Verbose mode already has the full per-patch narrative
  // so the summary would be redundant.  Dry-run path is excluded — its diff /
  // shadow report delivers richer feedback.
  //
  // NOTE FOR ORCHESTRATOR: runner.mjs:303 still emits one "✨ <name>" line per
  // patch in BOTH compact and verbose mode.  To fully suppress those per-patch
  // lines in compact mode the isVerbose() gate inside runner.mjs would need to be
  // tightened — that file is owned by another agent and is out of scope here.
  // Track this as a follow-up: runner.mjs compact-mode per-patch suppression.
  if (!isVerbose() && !patchOptions.dryRun) {
    const rr = runnerReport || {};
    const driftCount = Array.isArray(rr.drifts) ? rr.drifts.length : 0;
    const statuses = rr.statuses || {};
    const skippedCount = Object.values(statuses).filter(s => s === 'skipped').length;
    const driftPart = driftCount > 0 ? `  ${icon.warn} ${driftCount} drift` : '';
    const skipPart = skippedCount > 0 ? `, ${skippedCount} skipped` : '';
    logger.log(`\n  ✨ ${patchesToApply.length} patch${patchesToApply.length === 1 ? '' : 'es'} applied${driftPart}${skipPart}`);
  }

  if (patchOptions.dryRun) {
    // Lazy diff: only compute the full unified diff (expensive on ~15MB bundles)
    // when stdout is a TTY (a human is watching) or when --output-diff is passed
    // explicitly. When piped to a file or /dev/null, skip createPatch entirely and
    // emit a one-line summary to stderr instead — repeated dry-run iteration in
    // scripts is much faster this way.
    const shouldEmitDiff = patchOptions.outputDiff || process.stdout.isTTY;
    if (shouldEmitDiff) {
      const { createPatch } = await import('diff');
      const diffOutput = createPatch(
        path.basename(options.inputPath),
        originalCode,
        patchedCode,
        'original',
        'patched'
      );
      process.stdout.write(diffOutput);
    } else {
      const deltaBytes = Buffer.byteLength(patchedCode, 'utf8') - Buffer.byteLength(originalCode, 'utf8');
      const sign = deltaBytes >= 0 ? '+' : '';
      process.stderr.write(
        `dry-run: ${patchesToApply.length} patch${patchesToApply.length === 1 ? '' : 'es'} applied, ${sign}${deltaBytes} bytes delta\n`
      );
    }

    // ── Shadow-mode semantic check ─────────────────────────────────────
    // Compare unpatched vs patched along several dimensions that pure
    // verify.present can't catch (weak verify, broken parse, forbidden
    // substrings, byte-identical no-op).
    const { runShadow, formatShadowReport } = await import('../shadow.mjs');
    const report = runShadow(originalCode, patchedCode, patches, patchesToApply);
    logger.log('');
    logger.log(formatShadowReport(report));

    if (patchOptions.writeOnClean && report.ok && !strictFailed && !hadNoChange) {
      // Safe-build path: only write when the shadow report is clean.
      fs.writeFileSync(options.outputPath, patchedCode, 'utf8');
      fs.chmodSync(options.outputPath, 0o755);
      logger.log(`\n[--write-on-clean] shadow report clean — wrote: ${options.outputPath}`);
      return 0;
    }

    if (strictFailed || hadNoChange) return 1;
    if (patchOptions.strict && !report.ok) return 1;
    return 0;
  }

  // Compute the output hash once so it can be reused for the sidecar and the
  // post-write integrity check without hashing patchedCode twice.
  const outputSha256 = sha256(patchedCode);

  // ── Build cache resolution ──────────────────────────────────────────────────
  // A cache entry is TRUSTED only when the freshly-rebuilt bundle's sha256 equals
  // the entry's recorded outputSha256 — a full end-to-end determinism proof. The
  // conflict report was already replayed inside the runner under the same gate;
  // here we resolve the reverse-diff sidecar and decide whether to persist a
  // fresh entry. All of this is best-effort: a throw here must never fail a build
  // that already produced a valid bundle.
  let conflictsFromCache = false;
  let reverseFromCache = false;
  try {
    if (buildCache) {
      const validated = !!buildCache.entry && buildCache.entry.outputSha256 === outputSha256;
      conflictsFromCache = validated && buildCache.conflictsFromCache === true;

      if (reverseCacheCandidate) {
        if (validated) {
          // Adopt the cached reverse-diff splices — identical bytes, no hashing.
          captureReverse = buildCache.entry.reverseDiff;
          reverseFromCache = true;
        } else {
          // Stale: we skipped capture but the entry didn't validate. Recompute
          // the reverse-diff by re-running the apply with capture ON and the
          // cache OFF (fail open — correctness over speed). The re-run's bundle
          // must match what we already wrote.
          logger.warn('  [cache] reverse-diff entry did not validate (build non-deterministic for this key) — recomputing.');
          const recomputeOpts = { ...patchOptions, captureReverse: [], buildCache: null };
          try {
            const reRet = await applyNamedPatches(code, patches, patchesToApply, activeLogger, recomputeOpts);
            const reCode = (reRet && typeof reRet === 'object' && typeof reRet.code === 'string') ? reRet.code : reRet;
            if (typeof reCode === 'string' && sha256(reCode) === outputSha256) {
              captureReverse = recomputeOpts.captureReverse;
            } else {
              logger.warn('  [cache] reverse-diff recompute produced a different bundle — skipping reverse-diff sidecar this build.');
              captureReverse = undefined;
            }
          } catch (err) {
            logger.warn(`  [cache] reverse-diff recompute failed (${err.message}) — skipping reverse-diff sidecar this build.`);
            captureReverse = undefined;
          }
        }
      }

      // Persist / tombstone the entry.
      if (buildCache.entry && !validated) {
        // Same key, different output bytes → the build is non-deterministic for
        // this key. Tombstone so future builds skip the cache for it instead of
        // paying a recompute-on-miss every time.
        markNondeterministic(buildCache.key, buildCache.storageRoot);
      } else if (!buildCache.entry && !buildCache.nondeterministic) {
        // Fresh build (cold key): store conflicts (+ reverse-diff when captured)
        // so the next identical build can replay them.
        const entry = {
          outputSha256,
          conflicts: Array.isArray(buildCache.conflicts) ? buildCache.conflicts : [],
          createdAt: new Date().toISOString(),
          ccVersion: patchOptions.version ?? null,
        };
        if (wantReverseDiff && Array.isArray(captureReverse)) {
          entry.reverseDiff = captureReverse;
        }
        const res = storeCacheEntry(buildCache.key, entry, buildCache.storageRoot);
        if (!res.ok) logger.debug?.(`  [cache] store skipped (non-fatal): ${res.error?.message}`);
      }
    }
  } catch (err) {
    logger.debug?.(`  [cache] resolution skipped (non-fatal): ${err.message}`);
  }

  const bundleWriteStartedAt = Date.now();
  fs.writeFileSync(options.outputPath, patchedCode, 'utf8');
  fs.chmodSync(options.outputPath, 0o755);
  phaseMs.bundleWrite = Date.now() - bundleWriteStartedAt;
  logger.log(`\nSuccessfully saved patched bundle to: ${options.outputPath}`);

  // ── Post-build artifacts (see runner/cli/build-artifacts.mjs) ────────────
  // Issue #8: post-write integrity check + .sha256 sidecar + auto-pin
  // (skipped in dry-run). Auto-pin sha mismatch is the one loud failure.
  if (!options.patchOptions?.dryRun) {
    const pinRes = writeShaSidecarAndAutoPin({
      outputPath: options.outputPath,
      inputPath: options.inputPath,
      patchedCode, outputSha256, noSidecar, patchOptions, logger,
    });
    if (!pinRes.ok) return 1;
  }

  copyEmbeddedSea({ inputPath: options.inputPath, outputPath: options.outputPath, logger });
  writeCapGateSentinel({ outputPath: options.outputPath, capabilitiesGateBypassed, logger });

  emitOverlayArtifact({ patches, patchesToApply, outputPath: options.outputPath, patchOptions, logger });
  emitAgentsArtifacts({ patches, patchesToApply, outputPath: options.outputPath, logger });

  // Reverse-diff sidecar (`ccpatch revert` input) — no-op on the fast/default
  // path (captureReverse undefined unless --emit-revert without --no-sidecar).
  const sidecarStartedAt = Date.now();
  writeRevertSidecar({
    captureReverse, outputPath: options.outputPath,
    originalCode, outputSha256, patchOptions, logger,
  });
  phaseMs.sidecarWrite = Date.now() - sidecarStartedAt;

  writePreloadArtifact({
    patches, patchesToApply,
    preloadPath: options.preloadPath, outputPath: options.outputPath, logger,
  });

  // ── WS6 Item 8: surface native grow-path platform degradation ────────────
  // Two sources, consumed best-effort:
  //   (a) WS1's structured stdout line. When the build path (or the Makefile
  //       repack step that wraps it) has a [repack:skip] line in hand, it is
  //       passed to us via CCPATCH_REPACK_SKIP (env) or runnerReport.repackSkip.
  //       We parse it tolerantly (parseRepackSkip) and report EXACTLY which
  //       patches were dropped and why.
  //   (b) A predictive warning for `--profile=native` builds on a host whose
  //       grow-path is unavailable (anything but linux-x64): the in-place repack
  //       can only fit a length-preserving patch set, so a larger bundle will be
  //       reduced or rejected downstream. We say so now rather than letting it
  //       surface (or stay silent) at repack time.
  // In paranoid mode (Item 5) any concrete [repack:skip] degradation is a HARD
  // build FAILURE rather than a warning.
  let platformSkip = null;
  {
    const paranoid = patchOptions.paranoid === true;
    // WS1 interface: the post-repack smoke check is REQUIRED by default; passing
    // --allow-unverified opts out (fail-OPEN). We forward that opt-out to the
    // repack step ONLY when the user explicitly asked for it AND paranoid mode is
    // off. Default and paranoid both fail-closed (smoke check enforced). We do
    // not spawn the repacker here (the Makefile does), so we surface the decision
    // as a documented hint the repack step reads, and log it for traceability.
    const allowUnverified = patchOptions.allowUnverified === true && !paranoid;
    if (options.profile === 'native') {
      if (patchOptions.allowUnverified && paranoid) {
        logger.warn(
          '  [native] --allow-unverified ignored under --paranoid: post-repack smoke ' +
          'check stays REQUIRED (fail-closed).'
        );
      }
      // Hint for the repack step: '1' → forward --allow-unverified; '0' → don't.
      process.env.CCPATCH_REPACK_ALLOW_UNVERIFIED = allowUnverified ? '1' : '0';
    }
    const skipText =
      process.env.CCPATCH_REPACK_SKIP ||
      (typeof runnerReport.repackSkip === 'string' ? runnerReport.repackSkip : null) ||
      (runnerReport.repackSkip && typeof runnerReport.repackSkip === 'object'
        ? `[repack:skip] ${JSON.stringify(runnerReport.repackSkip)}`
        : null);
    const skip = skipText ? parseRepackSkip(skipText) : null;
    platformSkip = skip;
    if (skip) {
      const msg = formatPlatformDegradation(skip);
      if (paranoid) {
        logger.error(`Error: [paranoid] ${msg}`);
        logger.error(
          '  Paranoid mode treats native grow-path degradation as a build failure. ' +
          'Re-run without --paranoid to accept the reduced patch set, or build on a ' +
          'linux-x64 host where the grow-repack path is available.'
        );
        return 1;
      }
      logger.warn(`  [native] ${msg}`);
    } else if (options.profile === 'native' && !nativeGrowPathAvailable()) {
      logger.warn(
        `  [native] ${formatPlatformDegradation({ platform: hostPlatformLabel() })}. ` +
        `If the patched bundle exceeds the original embedded region, the repack will ` +
        `drop patches to fit (or fail) on this host. Build on linux-x64 for the full set.`
      );
    }
  }

  // ── End-of-run summary / --json report ──────────────────────────────────
  const durationMs = Date.now() - buildStartedAt;
  // Merge our coarse CLI-level phase timers into the runner report so the
  // summary box can show where wall time went. Defensive merge: if a future
  // applyNamedPatches already populates report.phases, keep its entries and
  // layer ours on top only where it left gaps.
  const reportWithPhases = {
    ...runnerReport,
    phases: { ...(runnerReport.phases || {}), ...phaseMs },
    cache: {
      conflicts: conflictsFromCache,
      reverseDiff: reverseFromCache,
      enabled: !!buildCache,
    },
  };
  if (options.json) {
    // JSON path: a single JSON object on stdout. The leveled logger has
    // already routed informational text to stderr when --json was set, so
    // the payload is the only thing on stdout.
    const payload = buildJsonReport({
      ok: true,
      durationMs,
      report: reportWithPhases,
      patchNames: patchesToApply,
      paranoid: patchOptions.paranoid === true,
      platformDegradation: platformSkip,
    });
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else {
    logger.log('');
    logger.log(renderTextSummary({
      ok: true,
      durationMs,
      report: reportWithPhases,
      outputPath: options.outputPath,
      drySuggest: false,
    }));
  }

  return 0;
}
