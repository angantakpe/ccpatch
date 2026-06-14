/**
 * runner/layer-budgets.mjs — per-layer capability budgets (arch review #4).
 *
 * The architecture has two layers, expressed as the `core` and `platform`
 * profiles in ccpatch.yml:
 *
 *   core     — the patch SUBSTRATE (== the `minimal` profile). Tight budget:
 *              only `network` + `env`. Nothing here opens a tool-dispatch,
 *              socket, or agent surface.
 *   platform — the ORCHESTRATION / expose-internals / observability layer that
 *              rides on core (expose_*, the ADK, headless_bridge, the agent-tree
 *              bus). A WIDER budget: it claims `tools`, `exec`, and `telemetry`
 *              on top of core's `network` + `env`.
 *
 * `LAYER_BUDGETS[layer]` is the SORTED union of ALL capabilities the layer's
 * resolved patch set declares. It is the exact `--allow-capabilities` list each
 * layer's strict-apply CI gate passes (.github/workflows/layer-gates.yml reads it
 * via `printBudget`), AND the value tests/layer-profiles.test.mjs asserts EQUALS
 * the union actually declared by the layer's patches.
 *
 * Why the FULL declared union, not just the GATE_REQUIRED_CAPS subset: under
 * `--strict`, the capability gate requires --allow-capabilities to cover the
 * ENTIRE declared set of every high-risk patch that isn't pre-acked in
 * ccpatch.yml — including `fs` and `prompt`, which are not themselves gate-
 * required. A gate-required-only budget makes strict apply fail with
 * "missing: prompt, fs". So the budget is the layer's full claimed-power
 * footprint, which is also the clearest statement of "what can this layer do".
 *
 * Because the test asserts equality (not just subset), a patch that migrates
 * layer — or gains/loses ANY capability — fails CI until this budget is updated
 * by hand. Updating it is the forcing function: a deliberate, reviewable
 * acknowledgement that the layer's threat surface changed. Do not widen a budget
 * to make a red build green without re-reading THREAT_MODEL.md for the patch that
 * pushed it.
 */

// (no imports needed — capabilities are read from the loaded patch modules the
// caller passes in; the budget is the full declared union, not a gate-required
// subset, so GATE_REQUIRED_CAPS is intentionally not referenced here.)

/**
 * Per-layer capability budget: the SORTED union of every capability the layer's
 * patches declare. Keep in sync with that union — the test enforces exact
 * equality. core is the substrate (local-only: network for the fetch tee, env
 * for config, fs for the overlay/project-root file reads — no tools/exec/prompt/
 * telemetry); platform adds the orchestration surface (tools, exec, prompt,
 * telemetry).
 */
export const LAYER_BUDGETS = {
  core: ['env', 'fs', 'network'],
  platform: ['env', 'exec', 'fs', 'network', 'prompt', 'telemetry', 'tools'],
};

/**
 * Compute the SORTED union of ALL capabilities declared by a layer profile's
 * resolved patch set. The single shared definition of "what powers does this
 * layer claim", used by the test to validate LAYER_BUDGETS and available to
 * tooling that wants the live value.
 *
 * @param {string} layer  profile name ('core' | 'platform' | any profile)
 * @param {Record<string, string[]>} profiles  resolved profiles (readProfiles)
 * @param {Record<string, object>} patches  loaded patch modules (loadPatches);
 *        capabilities are read from the LOADED module's `.capabilities` array —
 *        the same source the build gate uses — NOT re-parsed from source text.
 * @param {(name: string, profiles: object, known: string[]) => {enabled: string[]}} resolveProfile
 *        the manifest resolver (injected to keep this module dependency-light).
 * @returns {string[]} sorted full capability union for the layer
 */
export function computeLayerBudget(layer, profiles, patches, resolveProfile) {
  const known = Object.keys(patches);
  const { enabled } = resolveProfile(layer, profiles, known);
  const union = new Set();
  for (const name of enabled) {
    const caps = Array.isArray(patches[name]?.capabilities) ? patches[name].capabilities : [];
    for (const c of caps) union.add(c);
  }
  return [...union].sort();
}

/**
 * Print a layer's budget as a comma-joined `--allow-capabilities` value, with a
 * trailing newline. CLI entry for the CI workflow:
 *   node runner/layer-budgets.mjs core      → "env,network\n"
 *   node runner/layer-budgets.mjs platform  → "env,exec,network,telemetry,tools\n"
 * Exits non-zero on an unknown layer so a typo in the workflow fails loud rather
 * than passing an empty budget.
 */
export function printBudget(layer) {
  const budget = LAYER_BUDGETS[layer];
  if (!budget) {
    process.stderr.write(`layer-budgets: unknown layer '${layer}' (known: ${Object.keys(LAYER_BUDGETS).join(', ')})\n`);
    return 2;
  }
  process.stdout.write(budget.join(',') + '\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(printBudget(process.argv[2]));
}
