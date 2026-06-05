/**
 * Third-party patch modules — Magisk-style external patch packages.
 *
 * A module is a directory containing:
 *   ccpatch-module.json       manifest (name, version, contentHash?, patches[])
 *   patches/<stem>.mjs        one or more standard ccpatch patches
 *
 * Installation copies the module into <project>/modules/<name>/. The loader
 * picks up patches from there and exposes them under "<name>/<stem>".
 *
 * See docs/authoring-patches.md "Third-party patch modules".
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { PROJECT_ROOT } from './paths.mjs';
import { classifyRisk } from './manifest.mjs';
import { readPatchCapabilities } from './capability-reader.mjs';

export const MODULES_DIRNAME = 'modules';
export const MODULE_MANIFEST = 'ccpatch-module.json';

// S3: cap the size of a downloaded tarball before buffering it into memory.
// A malicious or buggy update channel could otherwise stream gigabytes and
// OOM the process. 50 MB is generous for a patch module (text .mjs files).
export const MAX_TARBALL_BYTES = 50 * 1024 * 1024;

/**
 * S1: Resolve a manifest's content hash, accepting the modern `contentHash`
 * field and the deprecated `signature` alias.
 *
 * The hash is a self-computed sha256 over patches/ (see hashPatchesTree). It is
 * an INTEGRITY check only — it proves the patches/ tree matches what the
 * manifest author recorded, NOT that any particular party authored it. The
 * manifest ships in the same tarball, so a tamperer can recompute it; treat a
 * matching hash as "not corrupted in transit", never as "authentic".
 *
 * Returns { hash, source } where source is 'contentHash' | 'signature' | null.
 * Throws if both fields are present and disagree.
 */
export function resolveContentHash(manifest) {
  const ch = (typeof manifest?.contentHash === 'string' && manifest.contentHash.length > 0)
    ? manifest.contentHash : null;
  const sig = (typeof manifest?.signature === 'string' && manifest.signature.length > 0)
    ? manifest.signature : null;
  if (ch && sig && ch !== sig) {
    throw new Error(
      `Module manifest declares both contentHash (${ch.slice(0, 16)}…) and the deprecated `
      + `signature alias (${sig.slice(0, 16)}…) and they disagree. Remove one.`,
    );
  }
  if (ch) return { hash: ch, source: 'contentHash' };
  if (sig) return { hash: sig, source: 'signature' };
  return { hash: null, source: null };
}

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
  // S1: contentHash is the modern field name; signature is a deprecated alias.
  if (json.contentHash !== undefined && json.contentHash !== null && typeof json.contentHash !== 'string') {
    throw new Error(`${filename}: contentHash must be a string (sha256 hex) or null`);
  }
  // If both are present they must agree (resolveContentHash throws otherwise).
  resolveContentHash(json);
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
      // S1: "hashed" = a contentHash/signature is present (integrity only).
      signed: resolveContentHash(manifest).hash !== null,
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
  // S3c: if copyTree refuses (e.g. a symlink in the source tree) it may have
  // already created the dest root — roll it back so a rejected install leaves
  // no partial module behind.
  try {
    copyTree(srcPath, destDir);
  } catch (err) {
    rmrf(destDir);
    throw err;
  }

  // S1: Verify the content hash (if any). This is an INTEGRITY check, not
  // authentication — accept either contentHash or the deprecated signature alias.
  let verifyOk = null;
  const { hash: expectedHash } = resolveContentHash(manifest);
  if (expectedHash) {
    const computed = hashPatchesTree(path.join(destDir, 'patches'));
    verifyOk = (computed === expectedHash);
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
 * S1: Verify a module's content hash: compute sha256 of patches/ and compare
 * against the manifest's contentHash (or the deprecated signature alias). This
 * is an INTEGRITY check, NOT authentication — the hash ships in the same tree.
 * Returns { name, signed, ok, expected, actual, hashSource }.
 *   - signed:false → no contentHash/signature in manifest (caller decides to warn).
 *   - signed:true, ok:true → patches/ matches the recorded hash (not corrupted).
 *   - signed:true, ok:false → patches/ differ from the recorded hash (tampered/corrupt).
 * hashSource is 'contentHash' | 'signature' | null, so callers can flag the
 * deprecated alias.
 */
export function verifyModule(name, { projectRoot = PROJECT_ROOT } = {}) {
  const dir = resolveModuleDir(name, projectRoot);
  const manifest = readModuleManifest(dir);
  const patchesDir = path.join(dir, 'patches');
  const actual = hashPatchesTree(patchesDir);
  const { hash: expected, source: hashSource } = resolveContentHash(manifest);
  if (!expected) {
    return { name: manifest.name, dir, signed: false, ok: null, expected: null, actual, hashSource: null };
  }
  return {
    name: manifest.name,
    dir,
    signed: true,
    ok: actual === expected,
    expected,
    actual,
    hashSource,
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
 * Read a patch file's declared capabilities without executing the module in the
 * main process. Uses capability-reader's vm sandbox (Option A) with a static
 * regex fallback (Option B). Returns { name, capabilities, risk }.
 *
 * The previous implementation used dynamic import() which ran the module's
 * top-level code before any ack gate fired. This replacement keeps capability
 * inspection sandboxed so untrusted code cannot execute during `module install`.
 */
export function inspectModuleCapabilities(moduleDir) {
  const manifest = readModuleManifest(moduleDir);
  const patchesDir = path.join(moduleDir, 'patches');
  const rows = [];
  for (const stem of manifest.patches) {
    const filePath = path.join(patchesDir, stem + '.mjs');
    if (!fs.existsSync(filePath)) continue;
    const caps = readPatchCapabilities(filePath);
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
 * S2: Validate that a fetch URL is https:// by default. http:// fetches the
 * code we are about to run in-process over cleartext — a trivial MITM RCE — so
 * it is refused unless the caller explicitly opted in with `--insecure`
 * (threaded as opts.insecure). Non-http(s) schemes are always rejected.
 */
function assertFetchUrlAllowed(label, url, insecure) {
  if (/^https:\/\//i.test(url)) return;
  if (/^http:\/\//i.test(url)) {
    if (insecure) return;
    throw new Error(
      `${label}: refusing cleartext http:// (got ${url}). This fetches code over an `
      + `unauthenticated channel (MITM risk). Use https://, or pass --insecure to override.`,
    );
  }
  throw new Error(`${label}: only https:// URLs are supported (got ${url}).`);
}

/**
 * Fetch JSON from an https:// URL (http:// only with opts.insecure). Returns
 * the parsed body or throws. Used by `module update`.
 */
export async function fetchJson(url, opts = {}) {
  // S2: refuse cleartext by default.
  assertFetchUrlAllowed('fetchJson', url, opts.insecure === true);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetchJson: ${url} returned HTTP ${res.status}`);
  }
  return await res.json();
}

/**
 * Fetch and extract a tarball from an https:// URL into a temporary directory
 * (http:// only with opts.insecure). Returns the path to the extracted root.
 * Uses `tar` from PATH — Node has no built-in tar reader. Non-tar formats (zip)
 * are out of scope.
 *
 * opts: { insecure?: boolean, maxBytes?: number }.
 */
export async function fetchAndExtractTarball(url, opts = {}) {
  // S2: refuse cleartext by default.
  assertFetchUrlAllowed('fetchAndExtractTarball', url, opts.insecure === true);
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : MAX_TARBALL_BYTES;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetchAndExtractTarball: ${url} returned HTTP ${res.status}`);
  }
  // S3a: reject oversize before buffering when the server advertises a length…
  const declaredLen = Number(res.headers.get('content-length'));
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    throw new Error(
      `fetchAndExtractTarball: ${url} advertises ${declaredLen} bytes, exceeding the `
      + `${maxBytes}-byte cap. Refusing to download.`,
    );
  }
  // …and stream the body so we abort past the cap even when content-length is
  // absent or lies, rather than buffering the whole (possibly unbounded) body.
  const buf = await readBodyCapped(res, maxBytes, url);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-mod-'));
  const tarPath = path.join(tmp, 'mod.tgz');
  fs.writeFileSync(tarPath, buf);
  const { execFileSync } = await import('node:child_process');
  try {
    // S3b: --no-same-owner/--no-same-permissions stop an extracted entry from
    // restoring archived ownership/setuid bits onto the host filesystem.
    execFileSync('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', tarPath, '-C', tmp], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`tar extraction failed: ${err.message}`);
  }
  // S3b: containment check — reject any extracted path that resolves outside the
  // tmp dir (defends against path-traversal entries like ../../etc that some
  // tar implementations may still honour, or symlink-then-write tricks).
  assertExtractionContained(tmp);
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

/**
 * S3a: read a fetch Response body into a Buffer, aborting once the accumulated
 * size exceeds maxBytes. Streams via the body reader so we never buffer more
 * than the cap regardless of (missing or dishonest) content-length.
 */
async function readBodyCapped(res, maxBytes, url) {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    // Fallback: no stream available. Buffer then enforce the cap.
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error(`fetchAndExtractTarball: ${url} body of ${buf.length} bytes exceeds the ${maxBytes}-byte cap.`);
    }
    return buf;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (_) {}
      throw new Error(
        `fetchAndExtractTarball: ${url} body exceeded the ${maxBytes}-byte cap mid-stream. Aborted.`,
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * S3b: walk an extracted tree and ensure every entry's realpath stays within
 * `root`. Throws naming the offending entry if any path escapes (e.g. via a
 * symlink pointing outside, or a traversal entry). Symlinks are resolved before
 * comparison so a link to /etc is caught here too.
 */
function assertExtractionContained(root) {
  const rootReal = fs.realpathSync(root);
  const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      let real;
      try {
        real = fs.realpathSync(abs);
      } catch (err) {
        throw new Error(`extracted entry ${abs} could not be resolved (dangling/escaping link?): ${err.message}`);
      }
      if (real !== rootReal && !real.startsWith(rootPrefix)) {
        throw new Error(`extracted entry ${abs} resolves to ${real}, which escapes ${rootReal}. Refusing.`);
      }
      // Recurse into real directories only (symlinked dirs already vetted above;
      // do not follow them to avoid loops / re-walking outside content).
      if (ent.isDirectory()) walk(abs);
    }
  };
  walk(rootReal);
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
    if (ent.isSymbolicLink()) {
      // S3c: faithfully recreating symlinks would let a module ship a link to
      // ~/.ssh, /etc, etc. into the install tree. Refuse them outright and name
      // the offending link + its target so the operator can audit the source.
      let target = '?';
      try { target = fs.readlinkSync(s); } catch (_) {}
      throw new Error(
        `Refusing to install module: ${s} is a symlink (→ ${target}). `
        + `Symlinks are not permitted in module trees.`,
      );
    } else if (ent.isDirectory()) {
      copyTree(s, d);
    } else if (ent.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}
