/**
 * Build-phase result cache for the two heavy harness phases — conflict
 * detection and reverse-diff capture — both of which are PURE functions of
 * (input bundle bytes, resolved patch set, patch source bytes, output-affecting
 * options). When all of those are unchanged between builds, the phases produce
 * byte-identical results, so we persist them once and replay them.
 *
 * Key = sha256 over a canonical JSON of:
 *   - CACHE_FORMAT (bump to invalidate every entry on a format change)
 *   - sha256(input bundle string)
 *   - the ordered resolved patch-name list
 *   - per-patch sha256 of each patch's SOURCE FILE bytes (variant-resolved path)
 *   - the patchOptions subset that can change the apply output or the cached
 *     artifacts (version/model/strict/dev/disableFallback/bestEffort/
 *     emitRevert/noVerify)
 *
 * Safety model (fail open, never fail the build):
 *   - A cached entry is only TRUSTED after the rebuilt bundle's sha256 matches
 *     the entry's recorded outputSha256 — a full end-to-end determinism check,
 *     not just a key match. On mismatch the consumer recomputes from scratch.
 *   - Corrupt / unreadable / wrong-format entries read as a miss.
 *   - Any patch without a resolvable source file disables caching for the run.
 *   - CCPATCH_NO_CACHE=1 disables the cache entirely.
 *   - Entries that proved non-deterministic are tombstoned (`nondeterministic`)
 *     so subsequent builds skip the cache for that key instead of paying a
 *     recompute penalty every time.
 *
 * Storage: storage/outputs/cache/<key>.json (gitignored with the rest of
 * storage/). A simple LRU prune keeps the newest MAX_CACHE_ENTRIES entries so
 * storage/outputs never grows unboundedly; `ccpatch outputs clear` also sweeps
 * the directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PROJECT_ROOT } from './paths.mjs';
import { sha256 } from './reverse-diff.mjs';

export const CACHE_FORMAT = 1;
// LRU cap. Entries that carry a reverse-diff sidecar embed the original spliced
// bytes and can be tens of MB each, so keep the working set small — a couple of
// in-flight upstream versions × a profile or two. `ccpatch outputs clear` also
// sweeps the directory for a hard reset.
export const MAX_CACHE_ENTRIES = 8;

/** Absolute path of the cache directory under a storage root. */
export function cacheDirFor(storageRoot = PROJECT_ROOT) {
  return path.join(storageRoot, 'storage', 'outputs', 'cache');
}

/** Env kill-switch: CCPATCH_NO_CACHE=1 disables the build cache entirely. */
export function isCacheDisabled(env = process.env) {
  return env.CCPATCH_NO_CACHE === '1';
}

/**
 * Hash every selected patch's source file. Returns an ordered
 * { name: sha256hex } map, or null when ANY source is unhashable (missing
 * __filePath or unreadable file) — the caller must then disable caching for
 * the run (fail open: recompute is always correct).
 */
export function hashPatchSources(patches, patchNames) {
  const out = {};
  for (const name of patchNames) {
    const filePath = patches[name]?.__filePath;
    if (!filePath) return null;
    try {
      out[name] = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch {
      return null;
    }
  }
  return out;
}

/** The patchOptions subset that participates in the cache key. */
export function pickKeyOptions(patchOptions = {}) {
  return {
    version: patchOptions.version ?? null,
    model: patchOptions.model ?? null,
    strict: patchOptions.strict === true,
    dev: patchOptions.dev === true,
    disableFallback: patchOptions.disableFallback === true,
    bestEffort: patchOptions.bestEffort === true,
    emitRevert: patchOptions.emitRevert === true,
    noVerify: patchOptions.noVerify === true,
  };
}

/**
 * Compute the cache key. All components are strings/booleans serialized into
 * a canonical JSON envelope; key = sha256(envelope).
 */
export function computeBuildCacheKey({ inputSha256, patchNames, patchSourceHashes, options }) {
  const material = JSON.stringify({
    v: CACHE_FORMAT,
    inputSha256,
    patchNames,
    patchSourceHashes,
    options,
  });
  return createHash('sha256').update(material).digest('hex');
}

function entryPathFor(key, storageRoot) {
  return path.join(cacheDirFor(storageRoot), `${key}.json`);
}

/**
 * Load a cache entry by key. Returns the parsed entry or null. NEVER throws:
 * corrupt JSON, wrong format version, or a key mismatch all read as a miss.
 * Touches the entry's mtime on a successful read so LRU pruning keeps hot keys.
 */
export function loadCacheEntry(key, storageRoot = PROJECT_ROOT) {
  const p = entryPathFor(key, storageRoot);
  try {
    if (!fs.existsSync(p)) return null;
    const entry = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!entry || entry.v !== CACHE_FORMAT || entry.key !== key) return null;
    try {
      const now = new Date();
      fs.utimesSync(p, now, now); // LRU touch — best effort
    } catch { /* non-fatal */ }
    return entry;
  } catch {
    return null;
  }
}

/**
 * Persist a cache entry and prune the directory to MAX_CACHE_ENTRIES. Write is
 * atomic (tmp + rename) and best-effort: any failure returns { ok: false }
 * without throwing — the cache must never fail a build.
 */
export function storeCacheEntry(key, entry, storageRoot = PROJECT_ROOT) {
  const dir = cacheDirFor(storageRoot);
  const p = entryPathFor(key, storageRoot);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...entry, v: CACHE_FORMAT, key }) + '\n', 'utf8');
    fs.renameSync(tmp, p);
    pruneCache(dir);
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/**
 * Keep only the `max` most-recently-touched *.json entries in the cache dir.
 * Best-effort; never throws.
 */
export function pruneCache(dir, max = MAX_CACHE_ENTRIES) {
  try {
    const entries = fs.readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => {
        const file = path.join(dir, n);
        try { return { file, mtime: fs.statSync(file).mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    for (const { file } of entries.slice(max)) {
      try { fs.unlinkSync(file); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}

/**
 * Resolve the cache context for a build: key + any existing entry. Returns
 * null when caching cannot be used for this run (kill-switch handled by the
 * caller; unhashable patch sources handled here). A tombstoned
 * (`nondeterministic`) entry yields a context with entry: null so the build
 * recomputes but does NOT store a fresh entry for the key.
 */
export function setupBuildCache({ code, patches, patchNames, patchOptions, storageRoot = PROJECT_ROOT }) {
  const patchSourceHashes = hashPatchSources(patches, patchNames);
  if (!patchSourceHashes) return null;
  const inputSha256 = sha256(code);
  const key = computeBuildCacheKey({
    inputSha256,
    patchNames,
    patchSourceHashes,
    options: pickKeyOptions(patchOptions),
  });
  const entry = loadCacheEntry(key, storageRoot);
  if (entry && entry.nondeterministic === true) {
    return { key, entry: null, nondeterministic: true, inputSha256, storageRoot };
  }
  return { key, entry, nondeterministic: false, inputSha256, storageRoot };
}

/**
 * Tombstone a key as non-deterministic: the same (input, patches, options)
 * produced different output bytes across runs, so caching can never validate.
 * Future builds with this key skip the cache instead of recomputing-on-miss
 * every time.
 */
export function markNondeterministic(key, storageRoot = PROJECT_ROOT) {
  return storeCacheEntry(key, { nondeterministic: true, createdAt: new Date().toISOString() }, storageRoot);
}
