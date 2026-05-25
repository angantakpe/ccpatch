/**
 * Third-party patch modules — Magisk-style external patch packages.
 *
 * A module is a directory containing:
 *   ccpatch-module.json       manifest (name, version, signature?, patches[])
 *   patches/<stem>.mjs        one or more standard ccpatch patches
 *
 * Installation copies the module into <project>/modules/<name>/. The loader
 * picks up patches from there and exposes them under "<name>/<stem>".
 *
 * See CONTRIBUTING.md "Third-party patch modules".
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { PROJECT_ROOT } from './paths.mjs';
import { classifyRisk } from './manifest.mjs';

export const MODULES_DIRNAME = 'modules';
export const MODULE_MANIFEST = 'ccpatch-module.json';

export function modulesRoot(projectRoot = PROJECT_ROOT) {
  return path.join(projectRoot, MODULES_DIRNAME);
}

/**
 * Compute a deterministic sha256 over the contents of a patches/ directory.
 *
 * Walks the tree in sorted order, hashing relative-path then file content for
 * each .mjs file. Non-.mjs files in patches/ are ignored — the module manifest
 * only declares .mjs patches, so other artefacts (.md, .json) are not part of
 * the signed surface and changing them does not invalidate the signature.
 */
export function hashPatchesTree(patchesDir) {
  const h = createHash('sha256');
  if (!fs.existsSync(patchesDir)) return h.digest('hex');
  const walk = (dir, prefix) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(abs, rel);
      } else if (ent.isFile() && ent.name.endsWith('.mjs')) {
        h.update(rel);
        h.update('\0');
        h.update(fs.readFileSync(abs));
        h.update('\0');
      }
    }
  };
  walk(patchesDir, '');
  return h.digest('hex');
}

export function readModuleManifest(moduleDir) {
  const p = path.join(moduleDir, MODULE_MANIFEST);
  if (!fs.existsSync(p)) {
    throw new Error(`Module manifest not found: ${p}`);
  }
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${p}: ${err.message}`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Module manifest is not valid JSON (${p}): ${err.message}`);
  }
  validateModuleManifest(json, p);
  return json;
}

function validateModuleManifest(json, filename) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`${filename}: manifest must be an object`);
  }
  if (typeof json.name !== 'string' || !json.name.trim()) {
    throw new Error(`${filename}: name (string) is required`);
  }
  if (typeof json.version !== 'string' || !json.version.trim()) {
    throw new Error(`${filename}: version (string) is required`);
  }
  if (!Array.isArray(json.patches) || json.patches.length === 0
      || json.patches.some(x => typeof x !== 'string' || !x.trim())) {
    throw new Error(`${filename}: patches must be a non-empty array of stem strings`);
  }
  // Disallow slashes/dots so a stem cannot escape patches/.
  for (const stem of json.patches) {
    if (stem.includes('/') || stem.includes('\\') || stem.includes('..')) {
      throw new Error(`${filename}: patch stem "${stem}" must not contain path separators or ..`);
    }
  }
  if (json.signature !== undefined && json.signature !== null && typeof json.signature !== 'string') {
    throw new Error(`${filename}: signature must be a string (sha256 hex) or null`);
  }
}

/**
 * List installed modules under <project>/modules/.
 *
 * Returns array of { name, version, dir, manifest, signed: boolean }.
 */
export function listModules(projectRoot = PROJECT_ROOT) {
  const root = modulesRoot(projectRoot);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    if (ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
    const dir = path.join(root, ent.name);
    let manifest;
    try {
      manifest = readModuleManifest(dir);
    } catch (_err) {
      continue;
    }
    out.push({
      name: manifest.name,
      version: manifest.version,
      dir,
      manifest,
      signed: typeof manifest.signature === 'string' && manifest.signature.length > 0,
    });
  }
  return out;
}

/**
 * Sanitise a module name to a single filesystem path segment. Slash-namespaced
 * names like "@author/foo" become "@author__foo" so they cannot escape modules/.
 */
export function moduleDirName(name) {
  return String(name).replace(/[\\/]/g, '__');
}

/**
 * Install a module from a local filesystem path. Copies the entire tree into
 * <project>/modules/<sanitised-name>/. Validates the manifest. Returns
 * { dir, manifest, signed, verifyOk } where verifyOk is null when unsigned.
 *
 * Network installation (https://, git://) is out of scope for v1 — callers
 * should error early when they detect those schemes (see runCli).
 */
export function installModuleFromPath(srcPath, { projectRoot = PROJECT_ROOT, force = false } = {}) {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Module source not found: ${srcPath}`);
  }
  const stat = fs.statSync(srcPath);
  if (!stat.isDirectory()) {
    throw new Error(`Module source must be a directory: ${srcPath}`);
  }
  // Validate before copying.
  const manifest = readModuleManifest(srcPath);
  const srcPatchesDir = path.join(srcPath, 'patches');
  if (!fs.existsSync(srcPatchesDir)) {
    throw new Error(`Module ${manifest.name}: missing patches/ directory at ${srcPatchesDir}`);
  }
  for (const stem of manifest.patches) {
    const f = path.join(srcPatchesDir, stem + '.mjs');
    if (!fs.existsSync(f)) {
      throw new Error(`Module ${manifest.name}: declared patch "${stem}" not found at ${f}`);
    }
  }

  const root = modulesRoot(projectRoot);
  fs.mkdirSync(root, { recursive: true });
  const destDir = path.join(root, moduleDirName(manifest.name));

  if (fs.existsSync(destDir)) {
    if (!force) {
      throw new Error(`Module already installed at ${destDir}. Remove first or pass --force.`);
    }
    rmrf(destDir);
  }
  copyTree(srcPath, destDir);

  // Verify signature (if any).
  let verifyOk = null;
  if (typeof manifest.signature === 'string' && manifest.signature.length > 0) {
    const computed = hashPatchesTree(path.join(destDir, 'patches'));
    verifyOk = (computed === manifest.signature);
  }

  return { dir: destDir, manifest, signed: verifyOk !== null, verifyOk };
}

export function removeModule(name, { projectRoot = PROJECT_ROOT } = {}) {
  const root = modulesRoot(projectRoot);
  const candidates = [
    path.join(root, name),
    path.join(root, moduleDirName(name)),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      // Confirm it really is a module (has manifest) before nuking.
      const mf = path.join(dir, MODULE_MANIFEST);
      if (fs.existsSync(mf)) {
        rmrf(dir);
        return { removed: dir };
      }
    }
  }
  // Last resort: scan and match by manifest.name.
  for (const m of listModules(projectRoot)) {
    if (m.name === name) {
      rmrf(m.dir);
      return { removed: m.dir };
    }
  }
  throw new Error(`Module not found: ${name}`);
}

/**
 * Verify a module's signature: compute sha256 of patches/ and compare against
 * manifest.signature. Returns { name, signed, ok, expected, actual }.
 *   - signed:false → no signature in manifest (caller decides to warn).
 *   - signed:true, ok:true → match.
 *   - signed:true, ok:false → tampered.
 */
export function verifyModule(name, { projectRoot = PROJECT_ROOT } = {}) {
  const dir = resolveModuleDir(name, projectRoot);
  const manifest = readModuleManifest(dir);
  const patchesDir = path.join(dir, 'patches');
  const actual = hashPatchesTree(patchesDir);
  if (typeof manifest.signature !== 'string' || manifest.signature.length === 0) {
    return { name: manifest.name, dir, signed: false, ok: null, expected: null, actual };
  }
  return {
    name: manifest.name,
    dir,
    signed: true,
    ok: actual === manifest.signature,
    expected: manifest.signature,
    actual,
  };
}

export function resolveModuleDir(name, projectRoot = PROJECT_ROOT) {
  const root = modulesRoot(projectRoot);
  const direct = path.join(root, name);
  if (fs.existsSync(path.join(direct, MODULE_MANIFEST))) return direct;
  const sanitised = path.join(root, moduleDirName(name));
  if (fs.existsSync(path.join(sanitised, MODULE_MANIFEST))) return sanitised;
  for (const m of listModules(projectRoot)) {
    if (m.name === name) return m.dir;
  }
  throw new Error(`Module not installed: ${name}`);
}

/**
 * Enumerate patch files contributed by installed modules.
 *
 * Returns array of { name, filePath, moduleName } where `name` is the loader's
 * patch name — namespaced as "<module.name>/<stem>".
 */
export function enumerateModulePatches(projectRoot = PROJECT_ROOT) {
  const out = [];
  for (const m of listModules(projectRoot)) {
    const patchesDir = path.join(m.dir, 'patches');
    if (!fs.existsSync(patchesDir)) continue;
    for (const stem of m.manifest.patches) {
      const filePath = path.join(patchesDir, stem + '.mjs');
      if (!fs.existsSync(filePath)) continue;
      out.push({
        name: `${m.manifest.name}/${stem}`,
        stem,
        filePath,
        moduleName: m.manifest.name,
        moduleDir: m.dir,
      });
    }
  }
  return out;
}

/**
 * Sandbox-import a patch file and read its declared capabilities. Returns
 * { name, capabilities, risk }. The import lives in this process so true
 * isolation is not provided — this is solely for capability disclosure at
 * install time, not for trust enforcement.
 */
export async function inspectModuleCapabilities(moduleDir) {
  const manifest = readModuleManifest(moduleDir);
  const patchesDir = path.join(moduleDir, 'patches');
  const rows = [];
  for (const stem of manifest.patches) {
    const filePath = path.join(patchesDir, stem + '.mjs');
    if (!fs.existsSync(filePath)) continue;
    // Cache-bust the URL so repeated imports during a single CLI invocation
    // do not return a stale module record (helps tests that install, mutate,
    // and re-install fixtures).
    const url = pathToFileURL(filePath).href + `?ts=${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let mod;
    try {
      mod = (await import(url)).default;
    } catch (err) {
      throw new Error(`Failed to import module patch ${manifest.name}/${stem}: ${err.message}`);
    }
    const caps = Array.isArray(mod?.capabilities) ? mod.capabilities : [];
    rows.push({
      name: `${manifest.name}/${stem}`,
      stem,
      capabilities: caps,
      risk: classifyRisk(caps),
    });
  }
  return { manifest, patches: rows };
}

/**
 * Fetch JSON from an http(s) URL. Returns the parsed body or throws.
 * Used by `module update`.
 */
export async function fetchJson(url) {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`fetchJson: only http(s) URLs are supported (got ${url})`);
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetchJson: ${url} returned HTTP ${res.status}`);
  }
  return await res.json();
}

/**
 * Fetch and extract a tarball from an http(s) URL into a temporary directory.
 * Returns the path to the extracted root. Uses `tar` from PATH — Node has no
 * built-in tar reader. v1 keeps this simple; non-tar formats (zip) are out of
 * scope.
 */
export async function fetchAndExtractTarball(url) {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`fetchAndExtractTarball: only http(s) URLs are supported (got ${url})`);
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetchAndExtractTarball: ${url} returned HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-mod-'));
  const tarPath = path.join(tmp, 'mod.tgz');
  fs.writeFileSync(tarPath, buf);
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('tar', ['-xzf', tarPath, '-C', tmp], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`tar extraction failed: ${err.message}`);
  }
  // The tarball is expected to contain either the module dir directly at the
  // top level or a single wrapping directory. Pick whichever has ccpatch-module.json.
  if (fs.existsSync(path.join(tmp, MODULE_MANIFEST))) return tmp;
  for (const ent of fs.readdirSync(tmp, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const candidate = path.join(tmp, ent.name);
    if (fs.existsSync(path.join(candidate, MODULE_MANIFEST))) return candidate;
  }
  throw new Error(`Extracted tarball does not contain a ${MODULE_MANIFEST} at the top level`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      copyTree(s, d);
    } else if (ent.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(s), d);
    } else if (ent.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}
