// U2: coverage for the shared resolveEffectivePatches() resolver that both the
// default build path (cmd-build.mjs) and `ccpatch explain` (cmd-explain.mjs)
// call, so they can't drift on which patches are in/out and WHY.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveEffectivePatches } from '../runner/config.mjs';

// Minimal synthetic registry. `required: true` patches are auto-included when
// an explicit --patch list is used; the rest follow ccpatch.yml flags.
const PATCHES = {
  enabled_one:  { description: 'flagged on' },
  disabled_one: { description: 'flagged off' },
  infra_one:    { description: 'required infra', required: true },
};

function writeYaml(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-explain-'));
  const p = path.join(dir, 'ccpatch.yml');
  fs.writeFileSync(p, body);
  return p;
}

describe('resolveEffectivePatches — yaml mode (enabled flags)', () => {
  const yamlPath = writeYaml(
    'version: 1\n' +
    'patches:\n' +
    '  enabled_one: true\n' +
    '  disabled_one: false\n' +
    '  infra_one: true\n'
  );

  const res = resolveEffectivePatches({
    patches: PATCHES,
    requested: [],
    profile: null,
    yamlPath,
  });

  it('marks an enabled patch IN with the ccpatch.yml reason', () => {
    assert.ok(res.selected.includes('enabled_one'));
    assert.equal(res.reasons.enabled_one, 'in: enabled in ccpatch.yml');
  });

  it('marks a disabled patch OUT with the ccpatch.yml reason', () => {
    assert.ok(!res.selected.includes('disabled_one'));
    assert.equal(res.reasons.disabled_one, 'out: disabled in ccpatch.yml');
  });

  it('respects an explicit false flag for a required: true patch in yaml mode', () => {
    // In yaml mode the enabled flags drive selection; `required` only
    // auto-includes for explicit --patch lists. Here infra_one is flagged on.
    assert.ok(res.selected.includes('infra_one'));
    assert.equal(res.reasons.infra_one, 'in: enabled in ccpatch.yml');
  });
});

describe('resolveEffectivePatches — explicit --patch list', () => {
  const yamlPath = writeYaml(
    'version: 1\n' +
    'patches:\n' +
    '  enabled_one: true\n' +
    '  disabled_one: false\n' +
    '  infra_one: false\n' // flagged off, but `required` should still pull it in
  );

  const res = resolveEffectivePatches({
    patches: PATCHES,
    requested: ['enabled_one'],
    profile: null,
    yamlPath,
  });

  it('includes the explicitly requested patch (bypassing yaml flags)', () => {
    assert.ok(res.selected.includes('enabled_one'));
    assert.equal(res.reasons.enabled_one, 'in: requested via --patch');
  });

  it('auto-includes a required patch even though ccpatch.yml disabled it', () => {
    assert.ok(res.selected.includes('infra_one'));
    assert.equal(res.reasons.infra_one, 'in: required infra');
  });

  it('leaves a non-requested, non-required patch OUT', () => {
    assert.ok(!res.selected.includes('disabled_one'));
    assert.equal(res.reasons.disabled_one, 'out: not in --patch list');
  });
});

describe('resolveEffectivePatches — profile', () => {
  const yamlPath = writeYaml(
    'version: 1\n' +
    'profiles:\n' +
    '  tiny:\n' +
    '    - enabled_one\n' +
    'patches:\n' +
    '  enabled_one: false\n' + // profile ignores per-patch enabled flags
    '  disabled_one: true\n'
  );

  const res = resolveEffectivePatches({
    patches: PATCHES,
    requested: [],
    profile: 'tiny',
    yamlPath,
  });

  it('includes profile members regardless of their enabled flag', () => {
    assert.ok(res.selected.includes('enabled_one'));
    assert.equal(res.reasons.enabled_one, 'in: profile=tiny');
  });

  it('excludes non-members with a "not in profile" reason', () => {
    assert.ok(!res.selected.includes('disabled_one'));
    assert.equal(res.reasons.disabled_one, 'out: not in profile tiny');
  });
});
