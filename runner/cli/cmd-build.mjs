// A1: default (no-subcommand) build invocation, split out of cli.mjs. Applies
// patches and writes the patched bundle (plus overlay/sidecar/preload/report),
// including the capability gate and config/profile resolution it calls.

import fs from 'node:fs';
import path from 'node:path';

import { buildJsonReport, renderTextSummary } from './build-report.mjs';
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

/**
 * The default (no-subcommand) build invocation: apply patches and write the
 * patched bundle (plus overlay/sidecar/preload/report). Extracted from the old
 * runPatchCli tail so the command table (DEFAULT_KEY) can dispatch to it.
 * ctx = { options, patches, logger }.
 */
export async function runBuild(ctx) {
  const { options, patches, logger } = ctx;
  let code = fs.readFileSync(options.inputPath, 'utf8');

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
  });
  for (const line of resolution.notices) logger.log(line);
  let patchesToApply = resolution.selected;

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
      if (patchOptions.allowUnacked) {
        const summary = ackViolations
          .map(v => `  ${v.name.padEnd(28)} ${v.capabilities.join(', ')}  [unacked: ${v.missing.join(', ')}]`)
          .join('\n');
        logger.log(
          `  [capabilities] WARN: ${ackViolations.length} patch(es) with unacked capabilities ` +
          `(--allow-unacked set, proceeding):\n${summary}`
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
  const captureReverse = [];
  patchOptions.captureReverse = captureReverse;
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

  if (patchOptions.dryRun) {
    const { createPatch } = await import('diff');
    const diffOutput = createPatch(
      path.basename(options.inputPath),
      originalCode,
      patchedCode,
      'original',
      'patched'
    );
    process.stdout.write(diffOutput);

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

  const bundleWriteStartedAt = Date.now();
  fs.writeFileSync(options.outputPath, patchedCode, 'utf8');
  fs.chmodSync(options.outputPath, 0o755);
  phaseMs.bundleWrite = Date.now() - bundleWriteStartedAt;
  logger.log(`\nSuccessfully saved patched bundle to: ${options.outputPath}`);

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

  // Write the reverse-diff sidecar so `ccpatch revert` can restore the input.
  const sidecarStartedAt = Date.now();
  if (captureReverse.length > 0) {
    const sidecar = {
      version: REVERT_SIDECAR_VERSION,
      timestamp: new Date().toISOString(),
      ccVersion: patchOptions.version ?? null,
      inputSha256: sha256(originalCode),
      outputSha256: sha256(patchedCode),
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
