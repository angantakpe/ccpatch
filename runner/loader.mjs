import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROJECT_ROOT } from './paths.mjs';
import { validateManifest } from './manifest.mjs';
import { enumeratePatchNames, resolvePatchFile } from './version-resolver.mjs';
import { enumerateModulePatches } from './modules.mjs';

// ARCH5: resolved-variant side channel. Rather than mutating each loaded patch
// module with a `__resolvedVariant` field (which leaks loader bookkeeping onto
// the patch's public surface and couples consumers to a magic property), we
// record the selected variant in a module-keyed WeakMap and expose it via the
// getResolvedVariant() accessor. The runner builds a name->variant Map from
// this accessor instead of reading patch.__resolvedVariant directly.
//
// NOTE: the legacy `mod.__resolvedVariant` property is still written below for
// two readers outside this stream's ownership that assert on it directly
// (runner/tui/App.mjs and tests/per-version-dir.test.mjs). The WeakMap is the
// canonical source; the property is a compatibility shim, deprecated.
const resolvedVariants = new WeakMap();

/**
 * Look up the resolved version-variant for a loaded patch module.
 * @param {object} mod  a patch module returned in the loadPatches() map
 * @returns {string} the variant tag (e.g. '2.1.148', '>=2.1.150'), or 'default'
 */
export function getResolvedVariant(mod) {
  if (mod && resolvedVariants.has(mod)) return resolvedVariants.get(mod);
  return 'default';
}

/**
 * Load patches from core/ and extensions/.
 *
 * Supports per-upstream-version override directories. For each patch <name>:
 *   - If <name>/ directory exists alongside <name>.mjs, scan it for version variants
 *     and pick the most specific match for opts.version (exact > narrowest range).
 *   - Otherwise load <name>.mjs.
 *
 * opts.version (string, e.g. "2.1.148") drives variant selection. When omitted,
 * only default <name>.mjs files are loaded; variant dirs without a default are
 * a load error.
 */
export async function loadPatches(opts = {}) {
  const patchesDir = opts.patchesDir ?? path.join(PROJECT_ROOT, 'core');
  const extensionsDir = opts.extensionsDir ?? path.join(PROJECT_ROOT, 'extensions');
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT;
  const version = opts.version;

  if (!fs.existsSync(patchesDir)) {
    throw new Error(`Core patches directory not found: ${patchesDir}`);
  }

  const dirsToScan = [patchesDir];
  if (fs.existsSync(extensionsDir)) dirsToScan.push(extensionsDir);

  // Enumerate by patch *name* (union of flat files and variant dirs), then
  // resolve each name to a concrete file path based on the target version.
  // Core/extensions patches do NOT allow slashes in their names — slash-named
  // patches are reserved for third-party modules (loaded below).
  const allFiles = [];
  for (const dir of dirsToScan) {
    const names = enumeratePatchNames(dir);
    for (const entry of names) {
      const resolved = resolvePatchFile(dir, entry.name, version);
      allFiles.push({
        name: entry.name,
        filePath: resolved.filePath,
        variant: resolved.variant,
        source: 'tree',
      });
    }
  }

  // Third-party module patches: namespaced as "<moduleName>/<stem>".
  if (opts.includeModules !== false) {
    for (const m of enumerateModulePatches(projectRoot)) {
      allFiles.push({
        name: m.name,
        filePath: m.filePath,
        variant: 'default',
        source: 'module',
        moduleName: m.moduleName,
      });
    }
  }

  const loaded = await Promise.all(
    allFiles.map(({ name, filePath }) =>
      import(pathToFileURL(filePath).href).then((m) => [name, m.default || m])
    )
  );

  const patches = {};
  const seen = new Map();
  for (let i = 0; i < loaded.length; i++) {
    const [name, mod] = loaded[i];
    const filePath = allFiles[i].filePath;
    const variant = allFiles[i].variant;
    if (seen.has(name)) {
      throw new Error(
        `Duplicate patch name "${name}" found in:\n  - ${seen.get(name)}\n  - ${filePath}\n` +
        `Patch names must be unique across core/ and extensions/.`
      );
    }
    seen.set(name, filePath);

    // Reject any patch lacking a non-empty verify block at load time so a
    // misconfigured patch can never reach apply().
    if (!mod || !mod.verify || typeof mod.verify !== 'object') {
      throw new Error(`patch ${name}: missing required 'verify' export — see CONTRIBUTING.md`);
    }
    const v = mod.verify;
    const hasPresent = v.present !== undefined && v.present !== null
      && (Array.isArray(v.present) ? v.present.length > 0 : true);
    const hasAbsent  = v.absent  !== undefined && v.absent  !== null
      && (Array.isArray(v.absent)  ? v.absent.length  > 0 : true);
    const hasCount   = v.count   !== undefined && v.count   !== null;
    if (!hasPresent && !hasAbsent && !hasCount) {
      throw new Error(`patch ${name}: 'verify' must specify at least one of present/absent/count — see CONTRIBUTING.md`);
    }
    const source = allFiles[i].source;
    // For module patches, validate against the bare stem; the slash-prefix is
    // the loader's namespace, not part of the manifest's filename contract.
    const validateFilename = source === 'module'
      ? name.split('/').pop() + '.mjs'
      : name + '.mjs';
    const { ok, errors } = validateManifest(mod, validateFilename, { variant, source });
    if (!ok) {
      throw new Error(`patch ${name}: manifest invalid — ${errors.join('; ')}`);
    }

    // Record the resolved variant in the module-keyed WeakMap (canonical) so
    // the runner can read it via getResolvedVariant() without depending on a
    // property mutation. The legacy property below is a compatibility shim for
    // App.mjs/per-version-dir.test.mjs (see resolvedVariants doc above).
    resolvedVariants.set(mod, variant);
    mod.__resolvedVariant = variant;
    // Attach the resolved absolute file path so downstream consumers (e.g.
    // preload-builder) can locate sibling companion files without re-resolving.
    mod.__filePath = filePath;
    patches[name] = mod;
  }
  return patches;
}
