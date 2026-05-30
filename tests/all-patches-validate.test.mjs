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
