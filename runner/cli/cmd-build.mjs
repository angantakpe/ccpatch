// A1: default (no-subcommand) build invocation, split out of cli.mjs. Applies
// patches and writes the patched bundle (plus overlay/sidecar/preload/report),
// including the capability gate and config/profile resolution it calls.

import fs from 'node:fs';
import path from 'node:path';

import { renderBuildStatusHeader } from './banner.mjs';
import { buildJsonReport, renderTextSummary } from './build-report.mjs';
import { isVerbose, icon } from './style.mjs';
import {
  parseAllowCapabilities,
  findGateViolations,
  findUnackedAckRequired,
  isCapabilityGateBypassed,
} from './capabilities.mjs';
import { sha256, sidecarPathFor, REVERT_SIDECAR_VERSION } from './sidecar.mjs';
import { applyNamedPatches } from '../runner.mjs';
import { readAcks, resolveEffectivePatches } from '../config.mjs';
import { CAPABILITIES } from '../manifest.mjs';
import { buildPreload } from '../preload-builder.mjs';
import { emitOverlay } from '../overlay-builder.mjs';
import {
  collectAgentDirPatches,
  emitAgentsDir,
  emitAdkRuntime,
} from '../agents-dir-builder.mjs';
import {
  parseRepackSkip,
  nativeGrowPathAvailable,
  hostPlatformLabel,
  formatPlatformDegradation,
} from './native-profile.mjs';

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

  // Strict mode requires --version (or CCPATCH_CLI_VERSION) so version-pinned
  // anchors in runner/anchors.mjs can resolve to a specific entry instead of
  // silently falling through to `default`.
  if (patchOptions.strict && !patchOptions.version) {
    logger.error(
      'Error: --strict requires --version <x.y.z> (or CCPATCH_CLI_VERSION env). ' +
      'Without a version, anchor entries in runner/anchors.mjs cannot pin to a release.'
    );
    return 1;
  }

  // ── Capability gate ───────────────────────────────────────────────────────
  // Track B (default-strict): patches with `network`, `exec`, or `env`
  // capabilities require explicit acknowledgement via the `ack:` block in
  // ccpatch.yml (or via --allow-capabilities). `--allow-unacked` restores
  // legacy warn-and-proceed behaviour. Other high-risk caps (tools, telemetry)
  // continue to follow the legacy strict-mode-only gate below.
  let capabilitiesGateBypassed = false;
  {
    const allow = parseAllowCapabilities(patchOptions.allowCapabilitiesRaw);
    if (allow && allow.unknown.length > 0) {
      logger.error(
        `Error: --allow-capabilities contains unknown value(s): ${allow.unknown.join(', ')}. ` +
        `Allowed: ${CAPABILITIES.join(', ')}`
      );
      return 1;
    }

    // S6/S1: `--allow-capabilities=all` is a blunt opt-out that waves every
    // high-risk cap through and short-circuits both gates below. Leave an audit
    // trail in CI logs by enumerating the CONCRETE (patch -> capabilities) set
    // it is actually covering, instead of silently proceeding — AND set a flag
    // so a `capabilitiesGateBypassed` marker can be persisted into the manifest.
    capabilitiesGateBypassed = isCapabilityGateBypassed(allow);
    if (capabilitiesGateBypassed) {
      // Prominent, hard-to-miss warning: the entire ack/high-risk gate is being
      // skipped. Routed through logger.warn so it lands on stderr (and under
      // --json stays off the machine-readable stdout payload).
      logger.warn('');
      logger.warn('  ⚠ ─────────────────────────────────────────────────────────────────');
      logger.warn('  ⚠ CAPABILITY GATE BYPASSED via --allow-capabilities=all');
      logger.warn('  ⚠ all network/exec/env acks skipped — no per-patch acknowledgement');
      logger.warn('  ⚠ ─────────────────────────────────────────────────────────────────');
      logger.warn('');
    }
    if (allow && allow.all) {
      const covered = patchesToApply
        .map(name => ({ name, caps: Array.isArray(patches[name]?.capabilities) ? patches[name].capabilities : [] }))
        .filter(e => e.caps.length > 0);
      if (covered.length > 0) {
        const summary = covered
          .map(e => `  ${e.name.padEnd(28)} ${e.caps.join(', ')}`)
          .join('\n');
        logger.log(
          `  [capabilities] --allow-capabilities=all acknowledging ${covered.length} patch(es) ` +
          `with declared capabilities:\n${summary}`
        );
      } else {
        logger.log(`  [capabilities] --allow-capabilities=all set; no selected patch declares capabilities`);
      }
    }

    // Default-strict ack gate for network/exec/env.
    const ackYamlPath = path.resolve(process.cwd(), 'ccpatch.yml');
    const acks = readAcks(ackYamlPath);
    const ackViolations = findUnackedAckRequired(patches, patchesToApply, acks, allow);
    if (ackViolations.length > 0) {
      if (patchOptions.allowUnacked || isSinglePatchDryRun) {
        const reason = patchOptions.allowUnacked ? '--allow-unacked set' : 'single --patch dry-run';
        const summary = ackViolations
          .map(v => `  ${v.name.padEnd(28)} ${v.capabilities.join(', ')}  [unacked: ${v.missing.join(', ')}]`)
          .join('\n');
        logger.log(
          `  [capabilities] WARN: ${ackViolations.length} patch(es) with unacked capabilities ` +
          `(${reason}, proceeding):\n${summary}`
        );
      } else {
        const first = ackViolations[0];
        const yamlSnippet =
          `  ack:\n` +
          `    ${first.name}: [${first.missing.join(', ')}]`;
        logger.error(
          `Patch "${first.name}" needs capability ack. Add to ccpatch.yml:\n` +
          `${yamlSnippet}\n` +
          `Or pass --allow-unacked to skip this check.`
        );
        if (ackViolations.length > 1) {
          const rest = ackViolations.slice(1)
            .map(v => `  ${v.name}: [${v.missing.join(', ')}]`)
            .join('\n');
          logger.error(`Additional unacked patch(es):\n${rest}`);
        }
        return 1;
      }
    }

    // Legacy strict-mode-only gate for the broader high-risk set.
    const violations = findGateViolations(patches, patchesToApply, allow, acks);
    if (violations.length > 0) {
      const summary = violations
        .map(v => `  ${v.name.padEnd(28)} ${v.capabilities.join(', ')}  [missing: ${v.missing.join(', ')}]`)
        .join('\n');
      if (patchOptions.strict) {
        logger.error(
          `Error: --strict mode requires --allow-capabilities for high-risk patches:\n` +
          `${summary}\n` +
          `Pass --allow-capabilities <list> (or =all) to acknowledge.`
        );
        return 1;
      } else {
        logger.log(
          `  [capabilities] WARN: ${violations.length} high-risk patch(es) not acknowledged ` +
          `(non-strict mode, proceeding):\n${summary}`
        );
      }
    }
  }

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
  // Reverse-diff capture is OPT-IN: only collect splices (and pay their ~16MB
  // sha256 per changed patch) when --emit-revert is set and sidecars are not
  // suppressed. Otherwise leave captureReverse undefined so captureReverseDiff()
  // short-circuits on its `!Array.isArray` guard — no splice, no hashing.
  const wantReverseDiff = emitRevert && !noSidecar;
  const captureReverse = wantReverseDiff ? [] : undefined;
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

  const bundleWriteStartedAt = Date.now();
  fs.writeFileSync(options.outputPath, patchedCode, 'utf8');
  fs.chmodSync(options.outputPath, 0o755);
  phaseMs.bundleWrite = Date.now() - bundleWriteStartedAt;
  logger.log(`\nSuccessfully saved patched bundle to: ${options.outputPath}`);

  // Issue #8: post-write integrity check + .sha256 sidecar (skipped in dry-run).
  if (!options.patchOptions?.dryRun) {
    // 1. Cheap integrity check: compare the on-disk byte length against what we
    //    wrote. A full re-read + sha256 of the ~16MB bundle on every build is a
    //    redundant cost for a check that almost never fails, so only escalate to
    //    the re-read + hash compare when the lengths actually differ.
    const expectedBytes = Buffer.byteLength(patchedCode, 'utf8');
    const onDiskBytes = fs.statSync(options.outputPath).size;
    const integrityOk =
      onDiskBytes === expectedBytes ||
      sha256(fs.readFileSync(options.outputPath, 'utf8')) === outputSha256;
    if (integrityOk) {
      logger.log(`  [+] Output integrity: OK`);
    } else {
      logger.warn(`  [!] Output integrity: MISMATCH`);
    }

    // 2. Write a .sha256 sidecar next to the output bundle (skipped under
    //    --no-sidecar; the integrity check above still runs).
    if (noSidecar) {
      logger.log(`  [~] --no-sidecar: skipping .sha256 sidecar`);
    } else {
      try {
        const sha256SidecarPath = options.outputPath + '.sha256';
        fs.writeFileSync(sha256SidecarPath, outputSha256 + '\n', 'utf8');
        logger.log(`  [+] SHA-256 sidecar written to: ${sha256SidecarPath}`);
      } catch (err) {
        logger.warn(`  [!] Could not write .sha256 sidecar: ${err.message}`);
      }
    }
  }

  // S1: persist a capability-gate-bypass sentinel next to the output bundle.
  // The make step (scripts/mk/cli.mk) reads this to set the manifest's
  // `capabilitiesGateBypassed` field, so a bundle built with the gate waved
  // through stays traceable after the fact. We always write the sentinel (true
  // OR false) so a stale marker from a prior build can't leak into this one.
  try {
    const sentinelPath = options.outputPath + '.capgate.json';
    fs.writeFileSync(
      sentinelPath,
      JSON.stringify({ capabilitiesGateBypassed }) + '\n',
      'utf8',
    );
  } catch (err) {
    logger.warn(`  [!] Could not write capability-gate sentinel: ${err.message}`);
  }

  // Emit the overlay sibling file (Magisk-style overlay-don't-mutate). The
  // core/overlay_loader patch injects a single require() into the bundle that
  // pulls this file in at startup. Each enabled patch that declared
  // `overlay: { register, code }` contributes one __ccpProvide() block.
  try {
    const dev = patchOptions.dev === true;
    if (dev) {
      logger.log(`  [DEV MODE] shims hot-reload from ./ccpatch-overlay-shims/`);
    }
    const emitted = emitOverlay(patches, patchesToApply, path.dirname(options.outputPath), { dev });
    if (emitted) {
      logger.log(`  [+] Overlay file written to: ${emitted.overlayPath}`);
      if (dev && emitted.shimDir) {
        logger.log(`  [+] Hot-reload shims (${emitted.shimPaths.length}) written under: ${emitted.shimDir}`);
      }
    }
  } catch (err) {
    logger.warn(`  [!] Could not write overlay file: ${err.message}`);
  }

  // Emit the agents dir (ccpatch-agents/) for every enabled patch that declared
  // `agentDir: { name, code }`. The core/overlay_loader patch injects a boot
  // block that require()s each *.mjs there (integrity-gated via .sha256). When
  // any agent ships, also copy the ADK runtime next to the bundle so those
  // entries can `require('../ccpatch-adk/index.mjs')` without an install-layout
  // assumption.
  try {
    const outputDir = path.dirname(options.outputPath);
    const agentEntries = collectAgentDirPatches(patches, patchesToApply);
    if (agentEntries.length > 0) {
      const adkFiles = emitAdkRuntime(outputDir);
      if (adkFiles.length > 0) {
        logger.log(`  [+] ADK runtime (${adkFiles.length} files) copied to: ${path.join(outputDir, 'ccpatch-adk')}`);
      }
      const written = emitAgentsDir(agentEntries, outputDir);
      if (written.length > 0) {
        logger.log(`  [+] Agents dir (${written.length}) written under: ${path.join(outputDir, 'ccpatch-agents')}`);
      }
    }
  } catch (err) {
    logger.warn(`  [!] Could not write agents dir: ${err.message}`);
  }

  // Write the reverse-diff sidecar so `ccpatch revert` can restore the input.
  // captureReverse is undefined unless --emit-revert was set (and sidecars are
  // not suppressed), so this whole block is skipped on the fast/default path.
  const sidecarStartedAt = Date.now();
  if (Array.isArray(captureReverse) && captureReverse.length > 0) {
    const sidecar = {
      version: REVERT_SIDECAR_VERSION,
      timestamp: new Date().toISOString(),
      ccVersion: patchOptions.version ?? null,
      // Perf#4: the first captured record's preCode is the bundle state the
      // first changing patch saw — byte-identical to originalCode (any earlier
      // patches were no-change), so its preSha256 already equals
      // sha256(originalCode). Reuse it instead of re-hashing the ~15MB input.
      inputSha256: captureReverse[0]?.preSha256 ?? sha256(originalCode),
      outputSha256,
      patches: captureReverse,
    };
    const sidecarPath = sidecarPathFor(options.outputPath);
    try {
      fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');
      logger.log(`  [+] Reverse-diff sidecar written to: ${sidecarPath}`);
    } catch (err) {
      logger.warn(`  [!] Could not write reverse-diff sidecar: ${err.message}`);
    }
  }
  phaseMs.sidecarWrite = Date.now() - sidecarStartedAt;

  if (options.preloadPath) {
    const preload = buildPreload(patches, patchesToApply);
    if (preload) {
      fs.writeFileSync(options.preloadPath, preload, 'utf8');
      logger.log(`  [+] Preload script written to: ${options.preloadPath}`);
      logger.log(`      Usage: node --require ${options.preloadPath} ${options.outputPath}`);
    } else {
      logger.log(`  [~] --preload: no preload-capable patches in current selection`);
    }
  }

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
