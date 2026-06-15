// Pre-build gates, split out of cmd-build.mjs (it was sequencing five
// concerns; gates are one of them). Each gate returns { ok } — on !ok the
// caller exits 1; all user-facing messages are emitted here so the split is
// behavior-preserving. Order in runBuild: strictVersionGate → capabilityGate
// → bunApiScanGate, all BEFORE any apply work (fail fast, no bundle written).

import path from 'node:path';

import {
  parseAllowCapabilities,
  findGateViolations,
  findUnackedAckRequired,
  isCapabilityGateBypassed,
} from './capabilities.mjs';
import { readAcks } from '../config.mjs';
import { CAPABILITIES } from '../manifest.mjs';
import { isVerbose } from './style.mjs';

/**
 * Strict mode requires --version (or CCPATCH_CLI_VERSION) so version-pinned
 * anchors in runner/anchors.mjs can resolve to a specific entry instead of
 * silently falling through to `default`.
 */
export function strictVersionGate(patchOptions, logger) {
  if (patchOptions.strict && !patchOptions.version) {
    logger.error(
      'Error: --strict requires --version <x.y.z> (or CCPATCH_CLI_VERSION env). ' +
      'Without a version, anchor entries in runner/anchors.mjs cannot pin to a release.'
    );
    return { ok: false };
  }
  return { ok: true };
}

/**
 * Capability gate — Track B (default-strict): patches with `network`, `exec`,
 * or `env` capabilities require explicit acknowledgement via the `ack:` block
 * in ccpatch.yml (or via --allow-capabilities). `--allow-unacked` restores
 * legacy warn-and-proceed behaviour. Other high-risk caps (tools, telemetry)
 * continue to follow the legacy strict-mode-only gate below.
 *
 * @returns {{ ok: boolean, capabilitiesGateBypassed: boolean }}
 */
export function capabilityGate({ patches, patchesToApply, patchOptions, isSinglePatchDryRun, logger }) {
  let capabilitiesGateBypassed = false;

  const allow = parseAllowCapabilities(patchOptions.allowCapabilitiesRaw);
  if (allow && allow.unknown.length > 0) {
    logger.error(
      `Error: --allow-capabilities contains unknown value(s): ${allow.unknown.join(', ')}. ` +
      `Allowed: ${CAPABILITIES.join(', ')}`
    );
    return { ok: false, capabilitiesGateBypassed };
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
      return { ok: false, capabilitiesGateBypassed };
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
      return { ok: false, capabilitiesGateBypassed };
    } else {
      logger.log(
        `  [capabilities] WARN: ${violations.length} high-risk patch(es) not acknowledged ` +
        `(non-strict mode, proceeding):\n${summary}`
      );
    }
  }

  return { ok: true, capabilitiesGateBypassed };
}

/**
 * Bun API coverage scan — the bundle is Bun-compiled but runs under Node via
 * the polyfill in runner/shims/bun-polyfill-v1.js.txt — several entries of
 * which are knowingly degraded (sync Bun.spawn, throwing Bun.Terminal, …).
 * Scan the INPUT bundle for Bun.<api> usage and report, per
 * scripts/scan-bun-api.mjs:
 *   (a) used but UNSHIMMED  → error-level; fails the build under --strict
 *   (b) used but degraded   → warning listing the shim's caveat
 *   (c) new vs the previous version's committed refmaps/ baseline → drift
 *   (d) degraded-shim DRIFT — a degraded/throwing shim GAINED call sites vs
 *       the committed baseline → fails the build in EVERY mode (not just
 *       --strict): upstream moved a code path onto a shim we know is broken
 *       under Node, which is exactly how the fullscreen-TUI deadlock shipped.
 *       Operator path: verify the shim handles the new site, re-record the
 *       baseline (scripts/scan-bun-api.mjs --write-baseline) and commit it;
 *       --allow-bun-drift is the audited one-off bypass.
 * Runs BEFORE apply so a strict failure is fail-fast (no bundle written). A
 * scanner crash must never take down a non-strict build (fail open at
 * runtime, loud at build time) — hence the try/catch with a warn.
 */
export async function bunApiScanGate({ code, inputPath, patchOptions, logger, scanOverrides = {} }) {
  let scan = null;
  try {
    const { runBunApiScan } = await import('../../scripts/scan-bun-api.mjs');
    // scanOverrides (refmapsDir/shimPayloadPath/coveragePath) exists for the
    // test suite, which gates against tmp-dir fixtures instead of the repo's
    // committed artifacts. Production callers pass nothing.
    scan = runBunApiScan({
      code,
      bundleLabel: path.basename(inputPath),
      version: patchOptions.version || null,
      // The degraded-shim inventory is stable build-to-build; collapse it to a
      // one-liner unless VERBOSE=1/--verbose. Actionable sections (unshimmed,
      // drift, new APIs) print regardless.
      verbose: isVerbose(),
      ...scanOverrides,
    });
    logger.log('');
    for (const line of scan.lines) logger.log(line);
  } catch (err) {
    logger.warn(`  [!] bun-api scan failed (non-fatal): ${err.message}`);
  }
  if (scan && scan.unshimmed.length > 0 && patchOptions.strict) {
    logger.error(
      `Error: --strict: bundle uses ${scan.unshimmed.length} Bun API(s) missing from the ` +
      `Bun polyfill: ${scan.unshimmed.map(e => `Bun.${e.name}`).join(', ')}. ` +
      `Shim them in runner/shims/bun-polyfill-v1.js.txt (and classify in ` +
      `refmaps/bun-api-coverage.json), or drop --strict to build anyway.`
    );
    return { ok: false };
  }
  if (scan && scan.degradedDrift && scan.degradedDrift.length > 0) {
    if (patchOptions.allowBunDrift) {
      logger.warn(
        `  [bun-api] WARN: --allow-bun-drift set — proceeding despite ` +
        `${scan.degradedDrift.length} degraded shim(s) with new call sites ` +
        `(${scan.degradedDrift.map(e => `Bun.${e.name}`).join(', ')})`
      );
    } else {
      const list = scan.degradedDrift
        .map(e => `  Bun.${e.name.padEnd(24)} ${e.baselineCount} → ${e.count} site(s)  [${e.status}] ${e.caveat}`)
        .join('\n');
      logger.error(
        `Error: degraded-shim drift vs the v${scan.baseline.version} baseline — upstream moved ` +
        `code onto ${scan.degradedDrift.length} shim(s) known to be degraded/throwing under Node:\n${list}\n` +
        `Verify each shim handles the new call site, then re-record and commit the baseline:\n` +
        `  node scripts/scan-bun-api.mjs ${inputPath} --version ${patchOptions.version || '<x.y.z>'} --write-baseline\n` +
        `Or pass --allow-bun-drift for an audited one-off build.`
      );
      return { ok: false };
    }
  }
  return { ok: true };
}
