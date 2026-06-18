import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPatches } from '../runner/loader.mjs';
import { readProfiles, resolveEffectivePatches } from '../runner/config.mjs';
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

// ── bare profile + required-infra override (docs/BISECTING.md) ───────────────
// The bare profile is the bisection floor: it must resolve to EXACTLY its
// listed patches (no required-infra auto-include), with a loud one-line
// warning that the skipped infra makes subscriber-based patches no-op. The
// same loudness applies to --no-required on explicit --patch lists. Default
// behavior for everything else must stay byte-identical, which the
// "unchanged" cases below pin.
describe('bare profile and required-patch override', () => {
  const BARE_SET = ['react_singleton', 'esm_compat', 'bun_shim'];
  const LOUD_RE = /REQUIRED INFRA SKIPPED/;

  it('bare resolves to exactly its three patches — no auto-include', async () => {
    const patches = await loadPatches();
    const { selected } = resolveEffectivePatches({
      patches, requested: [], profile: 'bare', yamlPath: CCPATCH_YML,
    });
    assert.deepEqual(selected, BARE_SET);
  });

  it('bare emits the loud REQUIRED INFRA SKIPPED notice naming every skipped required patch', async () => {
    const patches = await loadPatches();
    const { selected, notices } = resolveEffectivePatches({
      patches, requested: [], profile: 'bare', yamlPath: CCPATCH_YML,
    });
    const loud = notices.filter(n => LOUD_RE.test(n));
    assert.equal(loud.length, 1, `expected exactly one loud notice, got: ${JSON.stringify(notices)}`);
    assert.match(loud[0], /\[profile=bare\]/);
    const selectedSet = new Set(selected);
    const skippedRequired = Object.entries(patches)
      .filter(([name, p]) => p?.required === true && !selectedSet.has(name))
      .map(([name]) => name);
    assert.ok(skippedRequired.length > 0, 'expected bare to omit at least one required patch');
    for (const name of skippedRequired) {
      assert.ok(loud[0].includes(name), `loud notice does not name skipped required patch "${name}"`);
    }
  });

  it('every member of bare is a required:true runtime-adaptation patch', async () => {
    const patches = await loadPatches();
    for (const name of BARE_SET) {
      assert.equal(patches[name]?.required, true, `${name} should be required:true`);
    }
  });

  it('other profiles are unchanged: contain all required patches and stay quiet', async () => {
    const patches = await loadPatches();
    const requiredNames = Object.entries(patches)
      .filter(([, p]) => p?.required === true)
      .map(([name]) => name);
    for (const profile of ['minimal', 'standard', 'native', 'power']) {
      const { selected, notices } = resolveEffectivePatches({
        patches, requested: [], profile, yamlPath: CCPATCH_YML,
      });
      const selectedSet = new Set(selected);
      // native excludes esm_compat/bun_shim via its OWN post-filter (an
      // intentional, separately-noticed exclusion) — the loud required-skip
      // notice must still NOT fire for it.
      for (const name of requiredNames) {
        if (profile === 'native' && ['esm_compat', 'bun_shim'].includes(name)) continue;
        assert.ok(selectedSet.has(name), `profile ${profile} should include required patch ${name}`);
      }
      assert.equal(
        notices.filter(n => LOUD_RE.test(n)).length, 0,
        `profile ${profile} should not emit the loud required-skip notice: ${JSON.stringify(notices)}`,
      );
    }
  });

  it('standard still resolves to the same 29 patches', async () => {
    const patches = await loadPatches();
    const { selected } = resolveEffectivePatches({
      patches, requested: [], profile: 'standard', yamlPath: CCPATCH_YML,
    });
    // 28 → 29: c0c03c3 added standup_command to the standard profile.
    assert.equal(selected.length, 29);
  });

  it('--no-required suppresses the auto-include for explicit --patch lists, loudly', async () => {
    const patches = await loadPatches();
    const { selected, reasons, notices } = resolveEffectivePatches({
      patches, requested: ['hook_noise_mute'], profile: null,
      yamlPath: CCPATCH_YML, noRequired: true,
    });
    assert.deepEqual(selected, ['hook_noise_mute']);
    const loud = notices.filter(n => LOUD_RE.test(n));
    assert.equal(loud.length, 1);
    assert.match(loud[0], /\[--no-required\]/);
    assert.equal(reasons.contracts, 'out: required infra skipped (--no-required)');
    assert.ok(!notices.some(n => n.includes('auto-including')), 'auto-include notice must not fire');
  });

  it('explicit --patch WITHOUT --no-required still auto-includes required patches (unchanged)', async () => {
    const patches = await loadPatches();
    const { selected, reasons, notices } = resolveEffectivePatches({
      patches, requested: ['hook_noise_mute'], profile: null, yamlPath: CCPATCH_YML,
    });
    const requiredNames = Object.entries(patches)
      .filter(([, p]) => p?.required === true)
      .map(([name]) => name);
    const selectedSet = new Set(selected);
    for (const name of requiredNames) {
      assert.ok(selectedSet.has(name), `required patch ${name} should be auto-included`);
      assert.equal(reasons[name], 'in: required infra');
    }
    assert.ok(notices.some(n => n.includes('auto-including')), 'auto-include notice should fire');
    assert.equal(notices.filter(n => LOUD_RE.test(n)).length, 0, 'no loud notice without the flag');
  });
});
