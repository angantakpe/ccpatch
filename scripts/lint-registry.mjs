#!/usr/bin/env node
/**
 * scripts/lint-registry.mjs — ccpatch.yml ↔ patch-corpus consistency gate.
 *
 * Validates the registry (ccpatch.yml) against the manifest contract that
 * runner/manifest-schema.mjs + runner/manifest-validators.mjs own, REUSING the
 * runtime loader/validator instead of re-implementing it:
 *
 *   1. loadPatches() loads every patch in core/ + extensions/ and runs
 *      validateManifest() on each (phase values, capability enum, at-selector
 *      shape, verify strength, …). A manifest violation is a lint ERROR.
 *   2. Every name under `patches:` in ccpatch.yml must resolve to a loaded
 *      patch (i.e. an existing core/<name>.mjs or extensions/<name>.mjs).
 *   3. Every loaded patch must have a `patches:` entry (rule 8 in
 *      .claude/rules/hook-patches.md: registration is part of the change).
 *   4. Every `ack:` key must name a registered patch; every acked capability
 *      must be a valid Capability (manifest-schema CAPABILITIES_LIST, or `*`)
 *      AND be declared in that patch's `capabilities` array — an ack for an
 *      undeclared capability is stale or a typo.
 *   5. Every `dependsOn` target of every loaded patch must be a loaded patch.
 *
 * Profiles are validated by scripts/lint-profiles.mjs — not duplicated here.
 *
 * Legacy policy: pre-existing inconsistencies listed in LEGACY_WARN below are
 * reported as WARN (CI stays green) with a TODO to clean them up; anything NOT
 * listed there fails the lint, so new violations cannot land.
 *
 * Read-only by design: this script never writes ccpatch.yml (capability acks
 * in it are owned by the build/`ccpatch ack` flow).
 *
 * Exit 0 when no errors (warnings allowed); exit 1 on any error.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPatches } from '../runner/loader.mjs';
import { readPatchFlags, readAcks } from '../runner/config.mjs';
import { CAPABILITIES_LIST } from '../runner/manifest-schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const YAML_PATH = resolve(__dirname, '..', 'ccpatch.yml');

// ── Legacy allowlist ─────────────────────────────────────────────────────────
// Known pre-existing inconsistencies, downgraded to WARN so CI stays green.
// Each entry is the EXACT message the check below produces. Remove an entry
// once the underlying issue is fixed — a removed entry that re-appears fails.
//
// TODO(registry-hygiene): drive this list to empty. Every entry here is a real
// inconsistency that predates this lint.
const LEGACY_WARN = new Set([
  // extensions/_overlay_example.mjs exists, but the loader INTENTIONALLY skips
  // underscore-prefixed files (runner/version-resolver.mjs enumeratePatchNames),
  // so the ccpatch.yml `_overlay_example: false` entry can never take effect.
  // TODO(registry-hygiene): either rename the example so it is loadable, or
  // drop its ccpatch.yml entry (it is documentation, not a registrable patch).
  "patches: entry '_overlay_example' does not match any patch file in core/ or extensions/",
]);

/**
 * Pure check core: given the loaded patch map and the parsed YAML sections,
 * return the raw finding messages (before legacy routing). Exported for tests.
 *
 * @param {Record<string, object>} patches  loadPatches() result
 * @param {Record<string, boolean>} flags   readPatchFlags() result
 * @param {Record<string, string[]>} acks   readAcks() result (may be {})
 * @returns {string[]}
 */
export function collectFindings(patches, flags, acks) {
  const findings = [];
  const loadedNames = new Set(Object.keys(patches));
  const registered = new Set(Object.keys(flags));

  // 2 + 3. patches: keys ↔ loaded patch files (both directions).
  for (const name of registered) {
    if (!loadedNames.has(name)) {
      findings.push(`patches: entry '${name}' does not match any patch file in core/ or extensions/`);
    }
  }
  for (const name of loadedNames) {
    if (!registered.has(name)) {
      findings.push(`patch file '${name}.mjs' has no ccpatch.yml patches: entry (rule 8: registration is part of the change)`);
    }
  }

  // 4. ack: entries reference registered patches + declared capabilities.
  const VALID_CAPS = new Set(CAPABILITIES_LIST);
  for (const [name, caps] of Object.entries(acks)) {
    if (!registered.has(name)) {
      findings.push(`ack: entry '${name}' does not match any patches: entry`);
    }
    const mod = patches[name];
    const declared = new Set(Array.isArray(mod?.capabilities) ? mod.capabilities : []);
    for (const cap of caps) {
      if (cap === '*') continue; // blanket ack — always permitted by readAcks
      if (!VALID_CAPS.has(cap)) {
        findings.push(`ack: '${name}' acknowledges unknown capability '${cap}' (valid: ${CAPABILITIES_LIST.join(', ')})`);
        continue;
      }
      if (mod && !declared.has(cap)) {
        findings.push(`ack: '${name}' acknowledges '${cap}' but the patch does not declare it (declared: [${[...declared].join(', ')}])`);
      }
    }
  }

  // 5. dependsOn targets exist.
  for (const [name, mod] of Object.entries(patches)) {
    const deps = Array.isArray(mod?.dependsOn) ? mod.dependsOn : [];
    for (const dep of deps) {
      if (!loadedNames.has(dep)) {
        findings.push(`patch '${name}' dependsOn '${dep}', which is not a loaded patch`);
      }
    }
  }
  return findings;
}

/** Run the lint against the real repo. Returns the process exit code. */
export async function runLint() {
  // 1. Load + manifest-validate the whole corpus (reuses validateManifest —
  // phase enum, at-selector shape, verify strength, capability enum, …).
  // includeModules:false — third-party module patches are namespaced
  // "<module>/<stem>" and are not registered in this repo's ccpatch.yml.
  let patches;
  try {
    patches = await loadPatches({ includeModules: false });
  } catch (err) {
    console.error(`ERROR: patch corpus failed to load/validate: ${err.message}`);
    return 1;
  }

  const flags = readPatchFlags(YAML_PATH);
  if (!flags) {
    console.error(`ERROR: ccpatch.yml has no readable patches: section (${YAML_PATH})`);
    return 1;
  }
  const acks = readAcks(YAML_PATH) || {};

  // Route findings: legacy-allowlisted → WARN with TODO tag, else ERROR.
  const errors = [];
  const warnings = [];
  for (const message of collectFindings(patches, flags, acks)) {
    if (LEGACY_WARN.has(message)) warnings.push(`${message} [legacy — TODO(registry-hygiene)]`);
    else errors.push(message);
  }

  for (const w of warnings) console.warn(`WARN: ${w}`);
  for (const e of errors) console.error(`ERROR: ${e}`);

  if (errors.length > 0) {
    console.error(`\nlint-registry: ${errors.length} error(s), ${warnings.length} legacy warning(s).`);
    return 1;
  }
  console.log(`OK: ccpatch.yml is consistent with the patch corpus (${Object.keys(patches).length} patches, ${Object.keys(acks).length} acks${warnings.length ? `, ${warnings.length} legacy warning(s)` : ''}).`);
  return 0;
}

// Run as a gate only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await runLint());
}
