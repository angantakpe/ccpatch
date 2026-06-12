// Post-build artifact emission, split out of cmd-build.mjs (it was sequencing
// five concerns; artifacts are one of them). Every writer here is best-effort
// per the build's fail-open posture — a sidecar/overlay/agents-dir failure
// warns and never takes down a build that already produced a valid bundle.
// The ONE exception is the auto-pin mismatch inside writeShaSidecarAndAutoPin,
// which is the supply-chain attack the pin exists to catch and stays loud.

import fs from 'node:fs';
import path from 'node:path';

import { sha256, sidecarPathFor, REVERT_SIDECAR_VERSION } from './sidecar.mjs';
import { buildPreload } from '../preload-builder.mjs';
import { emitOverlay } from '../overlay-builder.mjs';
import {
  collectAgentDirPatches,
  emitAgentsDir,
  emitAdkRuntime,
} from '../agents-dir-builder.mjs';
import { maybeAutoPin } from '../auto-pin.mjs';

/**
 * Issue #8: post-write integrity check + .sha256 sidecar, then auto-pin after
 * a verified build. The build reached here only after: (a) the npm-tarball
 * integrity gate passed (scripts/verify-bundle-sha.mjs, run by the Makefile
 * BEFORE patching, which drops a TOFU marker on a first-use acceptance),
 * (b) patches applied with verify OK (applyNamedPatches did not throw), and
 * (c) the output was written. Records the pin for this version automatically
 * so the TOFU window does not stay open forever. Respects CCPATCH_NO_AUTOPIN=1.
 * An existing pin with a DIFFERENT sha is NEVER overwritten — that mismatch
 * fails the build loud (the attack the pin exists to catch).
 *
 * @returns {{ ok: boolean }} ok=false only on an auto-pin sha mismatch.
 */
export function writeShaSidecarAndAutoPin({ outputPath, inputPath, patchedCode, outputSha256, noSidecar, patchOptions, logger }) {
  // 1. Cheap integrity check: compare the on-disk byte length against what we
  //    wrote. A full re-read + sha256 of the ~16MB bundle on every build is a
  //    redundant cost for a check that almost never fails, so only escalate to
  //    the re-read + hash compare when the lengths actually differ.
  const expectedBytes = Buffer.byteLength(patchedCode, 'utf8');
  const onDiskBytes = fs.statSync(outputPath).size;
  const integrityOk =
    onDiskBytes === expectedBytes ||
    sha256(fs.readFileSync(outputPath, 'utf8')) === outputSha256;
  if (integrityOk) {
    logger.log(`  [+] Output integrity: OK`);
  } else {
    logger.warn(`  [!] Output integrity: MISMATCH`);
  }

  // 2. Write a .sha256 sidecar next to the output bundle (skipped under
  //    --no-sidecar; the integrity check above still runs).
  let sidecarWritten = false;
  if (noSidecar) {
    logger.log(`  [~] --no-sidecar: skipping .sha256 sidecar`);
  } else {
    try {
      const sha256SidecarPath = outputPath + '.sha256';
      fs.writeFileSync(sha256SidecarPath, outputSha256 + '\n', 'utf8');
      logger.log(`  [+] SHA-256 sidecar written to: ${sha256SidecarPath}`);
      sidecarWritten = true;
    } catch (err) {
      logger.warn(`  [!] Could not write .sha256 sidecar: ${err.message}`);
    }
  }

  // 3. Auto-pin after a verified build.
  if (integrityOk && sidecarWritten) {
    const pinVersion = patchOptions.version || process.env.CCPATCH_CLI_VERSION || null;
    const pinRes = maybeAutoPin({
      version: pinVersion,
      inputPath,
    });
    if (pinRes.status === 'pinned') {
      logger.log(`  [+] auto-pinned v${pinVersion} (sha256 ${String(pinRes.sha256).slice(0, 16)}…) — disable with CCPATCH_NO_AUTOPIN=1`);
    } else if (pinRes.status === 'mismatch') {
      logger.error(`  [!] AUTO-PIN REFUSED: ${pinRes.error}`);
      return { ok: false };
    } else if (pinRes.status === 'noop') {
      logger.debug?.(`  [~] auto-pin: v${pinVersion} already pinned with matching sha`);
    } else {
      logger.debug?.(`  [~] auto-pin skipped: ${pinRes.reason}`);
    }
  }
  return { ok: true };
}

/**
 * Bun-SEA embedded runtime deps: the extractor writes embedded-manifest.json
 * and an embedded/ dir (native .node addons + JS wrappers) next to the
 * EXTRACTED cli.js. The patched bundle lives elsewhere (releases/<ver>/), so
 * copy those artifacts next to the output so (a) the esm-compat require shim
 * can resolve `require("/$bunfs/root/<x>")` from ./embedded/ and (b) its
 * loud-on-miss path can consult the manifest. Best-effort: older extractions
 * (pre-manifest) simply have nothing to copy, which is fine.
 */
export function copyEmbeddedSea({ inputPath, outputPath, logger }) {
  try {
    const inDir = path.dirname(inputPath);
    const outDir = path.dirname(outputPath);
    const srcManifest = path.join(inDir, 'embedded-manifest.json');
    if (path.resolve(inDir) !== path.resolve(outDir) && fs.existsSync(srcManifest)) {
      fs.copyFileSync(srcManifest, path.join(outDir, 'embedded-manifest.json'));
      const srcEmbedded = path.join(inDir, 'embedded');
      if (fs.existsSync(srcEmbedded)) {
        fs.cpSync(srcEmbedded, path.join(outDir, 'embedded'), { recursive: true });
      }
      logger.log(`  [+] Embedded SEA modules + manifest copied next to bundle (${outDir})`);
    }
  } catch (err) {
    logger.warn(`  [!] Could not copy embedded SEA modules: ${err.message}`);
  }
}

/**
 * S1: persist a capability-gate-bypass sentinel next to the output bundle.
 * The make step (scripts/mk/cli.mk) reads this to set the manifest's
 * `capabilitiesGateBypassed` field, so a bundle built with the gate waved
 * through stays traceable after the fact. We always write the sentinel (true
 * OR false) so a stale marker from a prior build can't leak into this one.
 */
export function writeCapGateSentinel({ outputPath, capabilitiesGateBypassed, logger }) {
  try {
    const sentinelPath = outputPath + '.capgate.json';
    fs.writeFileSync(
      sentinelPath,
      JSON.stringify({ capabilitiesGateBypassed }) + '\n',
      'utf8',
    );
  } catch (err) {
    logger.warn(`  [!] Could not write capability-gate sentinel: ${err.message}`);
  }
}

/**
 * Emit the overlay sibling file (Magisk-style overlay-don't-mutate). The
 * core/overlay_loader patch injects a single require() into the bundle that
 * pulls this file in at startup. Each enabled patch that declared
 * `overlay: { register, code }` contributes one __ccpProvide() block.
 */
export function emitOverlayArtifact({ patches, patchesToApply, outputPath, patchOptions, logger }) {
  try {
    const dev = patchOptions.dev === true;
    if (dev) {
      logger.log(`  [DEV MODE] shims hot-reload from ./ccpatch-overlay-shims/`);
    }
    const emitted = emitOverlay(patches, patchesToApply, path.dirname(outputPath), { dev });
    if (emitted) {
      logger.log(`  [+] Overlay file written to: ${emitted.overlayPath}`);
      if (dev && emitted.shimDir) {
        logger.log(`  [+] Hot-reload shims (${emitted.shimPaths.length}) written under: ${emitted.shimDir}`);
      }
    }
  } catch (err) {
    logger.warn(`  [!] Could not write overlay file: ${err.message}`);
  }
}

/**
 * Emit the agents dir (ccpatch-agents/) for every enabled patch that declared
 * `agentDir: { name, code }`. The core/overlay_loader patch injects a boot
 * block that require()s each *.mjs there (integrity-gated via .sha256). When
 * any agent ships, also copy the ADK runtime next to the bundle so those
 * entries can `require('../ccpatch-adk/index.mjs')` without an install-layout
 * assumption.
 */
export function emitAgentsArtifacts({ patches, patchesToApply, outputPath, logger }) {
  try {
    const outputDir = path.dirname(outputPath);
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
}

/**
 * Write the reverse-diff sidecar so `ccpatch revert` can restore the input.
 * captureReverse is undefined unless --emit-revert was set (and sidecars are
 * not suppressed), so this is a no-op on the fast/default path.
 */
export function writeRevertSidecar({ captureReverse, outputPath, originalCode, outputSha256, patchOptions, logger }) {
  if (!Array.isArray(captureReverse) || captureReverse.length === 0) return;
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
  const sidecarPath = sidecarPathFor(outputPath);
  try {
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');
    logger.log(`  [+] Reverse-diff sidecar written to: ${sidecarPath}`);
  } catch (err) {
    logger.warn(`  [!] Could not write reverse-diff sidecar: ${err.message}`);
  }
}

/** Write the --preload script when requested. */
export function writePreloadArtifact({ patches, patchesToApply, preloadPath, outputPath, logger }) {
  if (!preloadPath) return;
  const preload = buildPreload(patches, patchesToApply);
  if (preload) {
    fs.writeFileSync(preloadPath, preload, 'utf8');
    logger.log(`  [+] Preload script written to: ${preloadPath}`);
    logger.log(`      Usage: node --require ${preloadPath} ${outputPath}`);
  } else {
    logger.log(`  [~] --preload: no preload-capable patches in current selection`);
  }
}
