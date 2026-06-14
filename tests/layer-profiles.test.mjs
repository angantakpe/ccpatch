/**
 * tests/layer-profiles.test.mjs — the core/platform layer boundary (arch #4).
 *
 * The review identified that the repo had outgrown "patch substrate" into
 * "substrate + orchestration platform" without naming the boundary. The `core`
 * and `platform` profiles in ccpatch.yml name it; these tests pin its shape and,
 * crucially, the per-layer capability budget that gates each layer in CI:
 *
 *   - core === minimal           (the substrate, kept in lock-step)
 *   - core ⊆ platform            (platform extends core)
 *   - core has no orchestration  (no expose-internals/headless/agent-tree patch)
 *   - platform owns the orchestration set
 *   - LAYER_BUDGETS[layer] EXACTLY equals the gate-required capability union the
 *     layer's patches declare — so a patch that migrates layer or gains a power
 *     fails CI until the budget (and the threat-model review it implies) is
 *     updated by hand. This is the forcing function the review asked for.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { readProfiles } from '../runner/config.mjs';
import { loadPatches } from '../runner/loader.mjs';
import { resolveProfile } from '../runner/manifest.mjs';
import { LAYER_BUDGETS, computeLayerBudget } from '../runner/layer-budgets.mjs';

const YAML = path.resolve(process.cwd(), 'ccpatch.yml');

// The orchestration / expose-internals / observability set — the patches that
// DEFINE the platform layer. Used to assert the boundary cuts where intended.
const ORCHESTRATION = [
  'event_bus', 'auth_token', 'agent_lifecycle', 'agent_tree',
  'assistant_stream_events', 'expose_tool_dispatch', 'expose_api_client',
  'expose_submit_input', 'expose_agent_tool', 'expose_system_prompt',
  'prime_agent_tool_on_boot', 'policy_gate', 'capture_interactive_request',
  'headless_bridge', 'adk_hello_agent', 'tools_log', 'cost_tracker',
];

async function resolved(name) {
  const profiles = readProfiles(YAML);
  const patches = await loadPatches();
  const { enabled, unknown } = resolveProfile(name, profiles, Object.keys(patches));
  return { enabled, unknown, patches, profiles };
}

describe('layer boundary — core / platform profiles', () => {
  it('both layers are defined and resolve with zero unknown patch names', async () => {
    const profiles = readProfiles(YAML);
    assert.ok(profiles.core, 'core profile missing from ccpatch.yml');
    assert.ok(profiles.platform, 'platform profile missing from ccpatch.yml');
    for (const layer of ['core', 'platform']) {
      const { unknown } = await resolved(layer);
      assert.deepEqual(unknown, [], `${layer} references unknown patches: ${unknown.join(', ')}`);
    }
  });

  it('core resolves identically to minimal (the substrate, kept in lock-step)', async () => {
    const core = (await resolved('core')).enabled;
    const minimal = (await resolved('minimal')).enabled;
    assert.deepEqual([...core].sort(), [...minimal].sort(),
      'core and minimal diverged — update one or the layer boundary comment in ccpatch.yml');
  });

  it('platform is a strict superset of core (extends core)', async () => {
    const core = new Set((await resolved('core')).enabled);
    const platform = new Set((await resolved('platform')).enabled);
    for (const p of core) {
      assert.ok(platform.has(p), `platform is missing core patch "${p}" — it must extend core`);
    }
    assert.ok(platform.size > core.size, 'platform should add patches on top of core');
  });

  it('core contains NO orchestration patch (substrate stays a substrate)', async () => {
    const core = new Set((await resolved('core')).enabled);
    const leaked = ORCHESTRATION.filter(p => core.has(p));
    assert.deepEqual(leaked, [],
      `orchestration patches leaked into the core substrate: ${leaked.join(', ')}`);
  });

  it('platform owns the full orchestration set', async () => {
    const platform = new Set((await resolved('platform')).enabled);
    const missing = ORCHESTRATION.filter(p => !platform.has(p));
    assert.deepEqual(missing, [],
      `platform is missing orchestration patches: ${missing.join(', ')}`);
  });
});

describe('layer capability budgets (the CI forcing function)', () => {
  it('LAYER_BUDGETS[layer] EXACTLY equals the gate-required caps the layer declares', async () => {
    const profiles = readProfiles(YAML);
    const patches = await loadPatches();
    for (const layer of ['core', 'platform']) {
      const computed = computeLayerBudget(layer, profiles, patches, resolveProfile);
      const declared = [...LAYER_BUDGETS[layer]].sort();
      assert.deepEqual(
        declared, computed,
        `LAYER_BUDGETS.${layer} (${declared.join(',')}) does not match the gate-required ` +
        `capability union actually declared by the ${layer} layer's patches (${computed.join(',')}). ` +
        `A patch changed layer or gained/lost a power — update runner/layer-budgets.mjs and ` +
        `re-read THREAT_MODEL.md for the patch that pushed it.`
      );
    }
  });

  it("core's budget is tight (no tools/exec/prompt/telemetry — substrate opens no agent surface)", () => {
    // core may claim local-only powers (network for the fetch tee, env for
    // config, fs for the overlay/project-root file reads) but NONE of the
    // orchestration powers — a tool-dispatch, subprocess, prompt-rewrite, or
    // telemetry cap leaking into the substrate is exactly the boundary erosion
    // this gate exists to catch.
    for (const cap of ['tools', 'exec', 'prompt', 'telemetry']) {
      assert.ok(!LAYER_BUDGETS.core.includes(cap),
        `core budget must not include '${cap}' — that is a platform-layer power`);
    }
  });

  it('platform budget is strictly wider than core (it claims real orchestration powers)', () => {
    const core = new Set(LAYER_BUDGETS.core);
    for (const cap of core) {
      assert.ok(LAYER_BUDGETS.platform.includes(cap), `platform budget must cover core cap '${cap}'`);
    }
    assert.ok(LAYER_BUDGETS.platform.length > LAYER_BUDGETS.core.length,
      'platform budget should be wider than core');
  });
});
