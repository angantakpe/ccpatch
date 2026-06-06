// runner/known-shas.mjs — programmatic reader + writer for storage/known-shas.json.
//
// Preserves the file's top-level _comment, _format, and the key ordering inside
// "versions". All mutations go through writePin() which is fail-closed:
//   - re-pinning the same sha (version + sha match)  → no-op, exits cleanly
//   - pinning a DIFFERENT sha for a known version     → REFUSE (hard error) unless --force
//   - new version                                     → append under "versions"
//
// Only the `versions` object is ever written; _comment and _format are preserved
// byte-for-byte (they are parsed then re-serialized from the parsed structure,
// preserving their content; whitespace in the rest of the file is normalised to
// 2-space indent which matches the existing file's format).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from './paths.mjs';

const DEFAULT_REGISTRY = resolve(PROJECT_ROOT, 'storage', 'known-shas.json');

// ── validation helpers ────────────────────────────────────────────────────────

/** @throws {Error} if sha is not a 64-character lowercase hex string */
export function assertValidSha256(sha) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/i.test(sha)) {
    throw new Error(`Invalid sha256: must be a 64-character hex string (got: ${String(sha).slice(0, 16)}…)`);
  }
}

/** Compute sha256 of a file, returning lowercase hex. */
export function sha256OfFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

// ── read ──────────────────────────────────────────────────────────────────────

/**
 * Load and parse the registry file.
 *
 * @param {string} [registryPath]
 * @returns {{ _comment?: string, _format?: object, versions: Record<string,object>, _path: string }}
 */
export function loadKnownShas(registryPath = DEFAULT_REGISTRY) {
  const p = resolve(registryPath);
  if (!existsSync(p)) {
    return { versions: {}, _path: p };
  }
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error(`Could not read registry ${p}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Registry ${p} is not valid JSON: ${err.message}`);
  }
  return {
    _comment: parsed._comment,
    _format: parsed._format,
    versions: parsed.versions || {},
    _path: p,
  };
}

/**
 * Look up a single version. Returns the pinned entry or null.
 *
 * @param {string} version
 * @param {string} [registryPath]
 * @returns {{ cliSha256: string, sizeBytes?: number, source?: string } | null}
 */
export function lookupVersion(version, registryPath = DEFAULT_REGISTRY) {
  const { versions } = loadKnownShas(registryPath);
  return versions[version] ?? null;
}

// ── write ─────────────────────────────────────────────────────────────────────

/**
 * Write a pin entry for `version` into the registry.
 *
 * Behaviour:
 *   - Same version + same sha  → no-op (idempotent), returns { status: 'noop' }
 *   - Same version + diff sha  → throws (fail-closed), unless force === true
 *   - New version              → appends entry, returns { status: 'pinned' }
 *
 * @param {object} opts
 * @param {string} opts.version       - e.g. "2.1.167"
 * @param {string} opts.cliSha256     - 64-char hex sha256 of the bundle
 * @param {number} [opts.sizeBytes]   - file size (advisory)
 * @param {string} [opts.source]      - human description of origin
 * @param {boolean} [opts.force]      - override mismatch guard
 * @param {string} [opts.registryPath]
 * @returns {{ status: 'pinned' | 'noop' }}
 */
export function writePin({
  version,
  cliSha256,
  sizeBytes,
  source,
  force = false,
  registryPath = DEFAULT_REGISTRY,
}) {
  if (!version || typeof version !== 'string') {
    throw new Error('writePin: version must be a non-empty string.');
  }
  assertValidSha256(cliSha256);
  const normalSha = cliSha256.toLowerCase();

  const registry = loadKnownShas(registryPath);
  const existing = registry.versions[version];

  if (existing) {
    const existingSha = String(existing.cliSha256 || '').toLowerCase();
    if (existingSha === normalSha) {
      // Idempotent no-op: same sha already pinned.
      return { status: 'noop' };
    }
    // Different sha for a known version — tampering signal, refuse by default.
    if (!force) {
      throw new Error(
        `SECURITY: v${version} is already pinned with a DIFFERENT sha256.\n` +
        `  pinned:   ${existingSha}\n` +
        `  provided: ${normalSha}\n` +
        `This may indicate tampering or a corrupt install. ` +
        `Pass --force only if you are intentionally re-pinning (e.g. a local rebuild).`
      );
    }
    // force=true: fall through and overwrite.
  }

  // Build the new entry (omit undefined optionals).
  const entry = { cliSha256: normalSha };
  if (sizeBytes != null) entry.sizeBytes = sizeBytes;
  if (source) entry.source = source;

  // Merge into versions, preserving the existing key order for existing keys
  // and appending the new one at the end.
  const newVersions = Object.assign({}, registry.versions, { [version]: entry });

  // Reconstruct the full registry object with _comment and _format first
  // (matching the existing file's structure exactly).
  const out = {};
  if (registry._comment !== undefined) out._comment = registry._comment;
  if (registry._format !== undefined) out._format = registry._format;
  out.versions = newVersions;

  const serialised = JSON.stringify(out, null, 2) + '\n';
  writeFileSync(registry._path, serialised, 'utf8');

  return { status: 'pinned' };
}
