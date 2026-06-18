/**
 * all-patches-validate.test.mjs
 *
 * Every shipped patch under core/ and extensions/ must pass the real
 * validateManifest() — not a synthetic inline object. The manifest/capability
 * unit tests (manifest.test.mjs, capabilities.test.mjs) exercise the validator
 * against hand-built fixtures; this test closes the gap by asserting the
 * ACTUAL patch modules on disk are well-formed.
 *
 * Why this matters: loadPatches() validates each module at load time, but it
 * is only exercised when a real bundle is patched (which needs an extracted
 * cli.js and so doesn't run in the fast PR lane). A typo in a manifest field
 * — a bad category, a name/stem mismatch, a missing verify block — would
 * otherwise sail through CI and only blow up at `make patch-claude-code`.
 *
 * We deliberately glob the directories rather than read ccpatch.yml's patch
 * list: ccpatch.yml is feature-flag state (enabled/disabled), but EVERY patch
 * file that ships must be valid regardless of whether it's enabled by default.
 * A disabled patch with a broken manifest is still a latent failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateManifest } from '../runner/manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Mirror loadPatches(): patches live as flat .mjs files (and per-version
// variant dirs, which we resolve to their default below) under core/ and
// extensions/. Dotfiles like .expose_tool_dispatch.anchors.json are sidecar
// data, not patches — readdirSync + the .mjs filter already excludes them.
const PATCH_DIRS = ['core', 'extensions'];

/**
 * Collect { dir, file, stem } for every patch module. Top-level .mjs files are
 * patches directly; a sibling <name>/ directory holds per-version variants —
 * we validate each variant file it contains (its filename stem is the patch
 * name, matching how resolvePatchFile names variants).
 */
function collectPatchFiles() {
  const out = [];
  for (const dir of PATCH_DIRS) {
    const abs = resolve(ROOT, dir);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue; // dir optional (extensions/ in theory could be absent)
    }
    for (const ent of entries) {
      // Mirror the real loader: `_`-prefixed files are shims/examples (e.g.
      // _standup_command_shim.mjs, _overlay_example.mjs) and `.`-prefixed are
      // sidecar data — neither is a shipped patch, so neither is loaded or
      // validated as one. (runner/modules.mjs uses the same skip rule.)
      if (ent.name.startsWith('_') || ent.name.startsWith('.')) continue;
      if (ent.isFile() && ent.name.endsWith('.mjs')) {
        out.push({ dir, file: resolve(abs, ent.name), name: ent.name });
      } else if (ent.isDirectory()) {
        // Per-version variant directory: the patch name is the directory name,
        // so validateManifest must see "<dirname>.mjs" as the filename, not the
        // variant stem.
        const variantStem = `${ent.name}.mjs`;
        for (const vf of readdirSync(resolve(abs, ent.name))) {
          if (vf.endsWith('.mjs')) {
            out.push({
              dir: `${dir}/${ent.name}`,
              file: resolve(abs, ent.name, vf),
              name: variantStem,
            });
          }
        }
      }
    }
  }
  return out;
}

const patchFiles = collectPatchFiles();

test('every patch under core/ and extensions/ exists to validate', () => {
  // Guard against a glob that silently matches nothing (wrong cwd, renamed
  // dirs) — a green "0 patches validated" would be a false pass.
  assert.ok(
    patchFiles.length >= 10,
    `expected to discover the shipped patches, found only ${patchFiles.length}`,
  );
});

for (const { dir, file, name } of patchFiles) {
  test(`validateManifest passes: ${dir}/${name}`, async () => {
    const imported = await import(pathToFileURL(file).href);
    const mod = imported.default || imported;

    assert.ok(mod && typeof mod === 'object', `${name}: no default export object`);

    // Match loadPatches()'s call: validate against "<stem>.mjs" so the
    // name/stem consistency check lines up with the real load path.
    const { ok, errors } = validateManifest(mod, name);

    assert.ok(
      ok,
      `${dir}/${name} failed validateManifest:\n  - ${errors.join('\n  - ')}`,
    );
  });
}

// ── Runtime instrumentation pressure gate ───────────────────────────────────
// Apply-time verify proves a patch's bytes LANDED; only a coverageMarker
// proves it EXECUTES (the `ccpatch coverage` / --strict runtime gate). For
// patches that touch network/exec/env that distinction is the whole security
// story: "silently dead" and "silently active" are both bad. So: every NEW
// patch declaring one of those capabilities must declare a coverageMarker.
//
// The list below is the KNOWN DEBT at the time this gate landed — it may only
// SHRINK (same pattern as lint-anchors' ALLOWED_REGEX_ANCHORS). Instrumenting
// one of these patches means deleting its entry here. Adding a name to this
// list is a review smell and needs a written justification in the PR.
const UNINSTRUMENTED_HOT_CAP_DEBT = new Set([
  'auth_token',
  'block_tools',
  'bun_shim',
  'cache_responses',
  'capture_interactive_request',
  'context_budget_warn',
  'cost_tracker',
  'debug',
  'dotenv_loader',
  'expose_api_client',
  // Justification (security review — honest capabilities): expose_tool_dispatch
  // now declares network+exec (its __ccpInvokeTool routes through MCP/fetch-
  // backed tools and runs subprocess-executing tools outside the permission
  // loop). It is not yet runtime-instrumented, so it joins its sibling RCE-stack
  // patches (headless_bridge, policy_gate) on the debt list. Remove this entry
  // when a coverageMarker is wired.
  'expose_tool_dispatch',
  'extended_thinking',
  'fetch_interceptor',
  'force_thinking',
  'headless_bridge',
  'hook_noise_mute',
  'mcp_lazy',
  'model',
  'policy_gate',
  'project_root',
  'rate_limit',
  'save_conversations',
  // Justification: standup_command (added to the standard profile in c0c03c3)
  // shells out to read-only `git log`/`git diff` via the _standup_command_shim
  // (exec) to compose the prompt. It is not yet runtime-instrumented, so it
  // joins the debt list like the other hot-cap patches. The git invocation is
  // read-only and fails open. Remove this entry when a coverageMarker is wired.
  'standup_command',
  'tool_result_error_content',
  'tool_result_trim',
  'tools_log',
  'webhook',
]);
const HOT_CAPS = new Set(['network', 'exec', 'env']);

test('network/exec/env patches declare a coverageMarker (debt list may only shrink)', async () => {
  const missing = [];
  const stale = new Set(UNINSTRUMENTED_HOT_CAP_DEBT);
  for (const { file, name } of patchFiles) {
    const imported = await import(pathToFileURL(file).href);
    const mod = imported.default || imported;
    if (!mod || typeof mod !== 'object') continue;
    const stem = name.replace(/\.mjs$/, '');
    const caps = Array.isArray(mod.capabilities) ? mod.capabilities : [];
    if (!caps.some(c => HOT_CAPS.has(c))) continue;
    if (mod.coverageMarker) {
      stale.delete(stem); // instrumented — entry (if any) is now removable
      continue;
    }
    stale.delete(stem);
    if (!UNINSTRUMENTED_HOT_CAP_DEBT.has(stem)) missing.push(stem);
  }
  assert.deepEqual(
    missing,
    [],
    `new network/exec/env patch(es) without a coverageMarker: ${missing.join(', ')}. ` +
    'Declare coverageMarker so the runtime coverage gate can prove the patch executes ' +
    '(do NOT extend UNINSTRUMENTED_HOT_CAP_DEBT without written justification).',
  );
  // Shrinking-only: entries whose patch is gone or now instrumented must be
  // deleted, otherwise the list silently rots into an unbounded allowlist.
  assert.deepEqual(
    [...stale].sort(),
    [],
    `stale UNINSTRUMENTED_HOT_CAP_DEBT entries (patch removed or instrumented — delete them): ${[...stale].join(', ')}`,
  );
});
