#!/usr/bin/env node
/**
 * scripts/lint-profiles.mjs
 *
 * Cross-validates profiles against the patches declared in ccpatch.yml.
 *
 * Checks:
 *   - Every patch name listed in a profile exists in 'patches:'. ERROR if not.
 *   - Patches in 'patches:' that appear in no profile are warned about (WARN, not error).
 *
 * For object-format profiles ({ extends, patches }), only the raw 'patches'
 * list is validated — the resolved (merged) set is NOT checked here, since the
 * base profile is validated separately.
 *
 * Exit 0 if no errors; exit 1 on any validation error.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const yamlPath = resolve(__dirname, '..', 'ccpatch.yml');

if (!existsSync(yamlPath)) {
  console.error(`ERROR: ccpatch.yml not found at ${yamlPath}`);
  process.exit(1);
}

const doc = yamlLoad(readFileSync(yamlPath, 'utf8'));

// ── 1. Extract all defined patch names ──────────────────────────────────────

if (!doc?.patches || typeof doc.patches !== 'object') {
  console.error('ERROR: ccpatch.yml has no valid patches: section');
  process.exit(1);
}

const definedPatches = new Set(Object.keys(doc.patches));

// ── 2. Extract raw profile patch lists (not resolved — just listed names) ───

if (!doc?.profiles || typeof doc.profiles !== 'object') {
  console.log('INFO: no profiles: section found — nothing to validate');
  process.exit(0);
}

// Build a map: profileName → string[] of patch names as written in the YAML.
// For object-format { extends, patches: [...] }, only the 'patches' array.
// For array-format [...], the full array.
const profilePatchLists = {};
for (const [name, val] of Object.entries(doc.profiles)) {
  if (Array.isArray(val)) {
    profilePatchLists[name] = val.filter(s => typeof s === 'string');
  } else if (val && typeof val === 'object' && Array.isArray(val.patches)) {
    profilePatchLists[name] = val.patches.filter(s => typeof s === 'string');
  } else {
    // Unknown format — skip silently (readProfiles would also skip it).
    profilePatchLists[name] = [];
  }
}

// ── 3. Validate: every profile patch must exist in patches: ─────────────────

let hasErrors = false;

for (const [profileName, patches] of Object.entries(profilePatchLists)) {
  for (const patchName of patches) {
    if (!definedPatches.has(patchName)) {
      console.error(`ERROR: profile '${profileName}' references unknown patch '${patchName}'`);
      hasErrors = true;
    }
  }
}

// ── 4. Warn: patches in patches: not in any profile ─────────────────────────

const patchesInAnyProfile = new Set(
  Object.values(profilePatchLists).flat(),
);

for (const patchName of definedPatches) {
  if (!patchesInAnyProfile.has(patchName)) {
    console.warn(`WARN: patch '${patchName}' is not in any profile (may be intentional)`);
  }
}

// ── 5. Exit ──────────────────────────────────────────────────────────────────

if (hasErrors) {
  process.exit(1);
} else {
  console.log('OK: all profile patch references are valid');
  process.exit(0);
}
