import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPatches } from '../runner/loader.mjs';
import { readProfiles } from '../runner/config.mjs';
import { resolveProfile } from '../runner/manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CCPATCH_YML = path.join(REPO_ROOT, 'ccpatch.yml');

// Bundle-independent guard for the review finding "resolveProfile silently drops
// typos": a profile that references a non-existent patch name is a config bug
// that never surfaces at apply time (the unknown is filtered out, not raised).
// These tests pin every profile in ccpatch.yml to real, loadable patch names.
describe('ccpatch.yml profiles reference only real patches', () => {
  it('ccpatch.yml parses and defines at least one profile', () => {
    const profiles = readProfiles(CCPATCH_YML);
    assert.ok(profiles, 'readProfiles returned null — ccpatch.yml is missing or unparseable');
    assert.ok(Object.keys(profiles).length >= 1, 'expected at least one profile');
  });

  it('every profile resolves with zero unknown patch names', async () => {
    const profiles = readProfiles(CCPATCH_YML);
    assert.ok(profiles, 'ccpatch.yml did not parse into profiles');

    const patches = await loadPatches();
    const knownNames = Object.keys(patches);
    assert.ok(knownNames.length > 0, 'loadPatches returned no patches');

    const offenders = {};
    for (const profileName of Object.keys(profiles)) {
      const { unknown } = resolveProfile(profileName, profiles, knownNames);
      if (unknown.length) offenders[profileName] = unknown;
    }

    assert.deepEqual(
      offenders,
      {},
      `profiles reference patches that are not loadable (typos?): ${JSON.stringify(offenders)}`,
    );
  });

  it('every profile resolves to a non-empty enabled list', async () => {
    const profiles = readProfiles(CCPATCH_YML);
    const patches = await loadPatches();
    const knownNames = Object.keys(patches);

    for (const profileName of Object.keys(profiles)) {
      const { enabled } = resolveProfile(profileName, profiles, knownNames);
      assert.ok(
        enabled.length > 0,
        `profile "${profileName}" resolved to an empty patch list`,
      );
    }
  });

  it('resolveProfile throws on an unknown profile name', () => {
    const profiles = readProfiles(CCPATCH_YML);
    assert.throws(
      () => resolveProfile('definitely_not_a_profile', profiles, []),
      /Unknown profile/,
    );
  });
});
