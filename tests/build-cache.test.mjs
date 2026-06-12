// tests/build-cache.test.mjs — unit tests for runner/build-cache.mjs
//
// Covers cache-key composition + invalidation, corruption fail-open, LRU prune,
// the kill-switch, and the nondeterministic tombstone. Uses tiny synthetic
// inputs — no real bundle required.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  computeBuildCacheKey,
  hashPatchSources,
  pickKeyOptions,
  setupBuildCache,
  storeCacheEntry,
  loadCacheEntry,
  pruneCache,
  cacheDirFor,
  isCacheDisabled,
  markNondeterministic,
  CACHE_FORMAT,
  MAX_CACHE_ENTRIES,
} from '../runner/build-cache.mjs';

// Build a throwaway storage root with synthetic patch source files.
function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-cache-'));
  fs.mkdirSync(path.join(root, 'storage', 'outputs', 'cache'), { recursive: true });
  return root;
}

function makePatch(root, name, body) {
  const fp = path.join(root, `${name}.mjs.fixture`);
  fs.writeFileSync(fp, body, 'utf8');
  return { __filePath: fp };
}

describe('build-cache key composition', () => {
  it('hashPatchSources returns an ordered map and null on a missing source', () => {
    const root = tmpRoot();
    const patches = { a: makePatch(root, 'a', 'A'), b: makePatch(root, 'b', 'B') };
    const h = hashPatchSources(patches, ['a', 'b']);
    assert.ok(h && h.a && h.b);
    assert.notEqual(h.a, h.b);
    // A patch without __filePath disables caching (null) — fail open.
    assert.equal(hashPatchSources({ a: {} }, ['a']), null);
  });

  it('key changes when ANY component changes', () => {
    const base = {
      inputSha256: 'i'.repeat(64),
      patchNames: ['a', 'b'],
      patchSourceHashes: { a: '1', b: '2' },
      options: pickKeyOptions({ version: '2.1.175' }),
    };
    const k0 = computeBuildCacheKey(base);
    // input bytes
    assert.notEqual(k0, computeBuildCacheKey({ ...base, inputSha256: 'j'.repeat(64) }));
    // patch set membership
    assert.notEqual(k0, computeBuildCacheKey({ ...base, patchNames: ['a'] }));
    // patch set ORDER
    assert.notEqual(k0, computeBuildCacheKey({ ...base, patchNames: ['b', 'a'] }));
    // a patch's source bytes
    assert.notEqual(k0, computeBuildCacheKey({ ...base, patchSourceHashes: { a: '9', b: '2' } }));
    // an output-affecting option
    assert.notEqual(k0, computeBuildCacheKey({ ...base, options: pickKeyOptions({ version: '2.1.176' }) }));
    // identical inputs → identical key (determinism)
    assert.equal(k0, computeBuildCacheKey({ ...base }));
  });

  it('pickKeyOptions only captures output-affecting options', () => {
    const a = pickKeyOptions({ version: '1', strict: true, dryRun: true, captureReverse: [] });
    const b = pickKeyOptions({ version: '1', strict: true, dryRun: false });
    // dryRun / captureReverse are not part of the key surface
    assert.deepEqual(a, b);
  });
});

describe('build-cache store / load round-trip', () => {
  it('stores and reloads an entry by key, tolerating a key mismatch', () => {
    const root = tmpRoot();
    const entry = { outputSha256: 'o'.repeat(64), conflicts: [{ a: 'x' }] };
    const key = 'k'.repeat(64);
    const res = storeCacheEntry(key, entry, root);
    assert.equal(res.ok, true);
    const got = loadCacheEntry(key, root);
    assert.equal(got.outputSha256, entry.outputSha256);
    assert.deepEqual(got.conflicts, entry.conflicts);
    assert.equal(got.v, CACHE_FORMAT);
    // A different key is a clean miss.
    assert.equal(loadCacheEntry('z'.repeat(64), root), null);
  });

  it('corrupt JSON reads as a miss (fail open), never throws', () => {
    const root = tmpRoot();
    const key = 'c'.repeat(64);
    fs.writeFileSync(path.join(cacheDirFor(root), `${key}.json`), '{ not json', 'utf8');
    assert.equal(loadCacheEntry(key, root), null);
  });

  it('wrong CACHE_FORMAT reads as a miss', () => {
    const root = tmpRoot();
    const key = 'f'.repeat(64);
    fs.writeFileSync(
      path.join(cacheDirFor(root), `${key}.json`),
      JSON.stringify({ v: CACHE_FORMAT + 99, key, outputSha256: 'x' }),
      'utf8',
    );
    assert.equal(loadCacheEntry(key, root), null);
  });
});

describe('build-cache LRU prune', () => {
  it('keeps only the newest MAX_CACHE_ENTRIES files', () => {
    const root = tmpRoot();
    const dir = cacheDirFor(root);
    const n = MAX_CACHE_ENTRIES + 6;
    for (let i = 0; i < n; i++) {
      const fp = path.join(dir, `e${String(i).padStart(3, '0')}.json`);
      fs.writeFileSync(fp, JSON.stringify({ i }), 'utf8');
      // stagger mtimes so prune order is deterministic (older = lower i)
      const t = new Date(Date.now() + i * 1000);
      fs.utimesSync(fp, t, t);
    }
    pruneCache(dir);
    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(remaining.length, MAX_CACHE_ENTRIES);
    // The newest (highest i) must survive; the oldest (e000) must be gone.
    assert.ok(remaining.includes(`e${String(n - 1).padStart(3, '0')}.json`));
    assert.ok(!remaining.includes('e000.json'));
  });
});

describe('build-cache setup + kill switch + tombstone', () => {
  it('isCacheDisabled honors CCPATCH_NO_CACHE', () => {
    assert.equal(isCacheDisabled({ CCPATCH_NO_CACHE: '1' }), true);
    assert.equal(isCacheDisabled({}), false);
  });

  it('setupBuildCache returns null when a patch source is unhashable', () => {
    const root = tmpRoot();
    const ctx = setupBuildCache({
      code: 'x', patches: { a: {} }, patchNames: ['a'], patchOptions: {}, storageRoot: root,
    });
    assert.equal(ctx, null);
  });

  it('setupBuildCache resolves a key + cold miss, then a warm hit', () => {
    const root = tmpRoot();
    const patches = { a: makePatch(root, 'a', 'A') };
    const args = { code: 'bundle-bytes', patches, patchNames: ['a'], patchOptions: { version: '2.1.175' }, storageRoot: root };
    const cold = setupBuildCache(args);
    assert.ok(cold.key);
    assert.equal(cold.entry, null);
    storeCacheEntry(cold.key, { outputSha256: 'o'.repeat(64), conflicts: [] }, root);
    const warm = setupBuildCache(args);
    assert.equal(warm.key, cold.key);
    assert.ok(warm.entry);
    assert.equal(warm.entry.outputSha256, 'o'.repeat(64));
  });

  it('a nondeterministic tombstone yields entry:null and the flag set', () => {
    const root = tmpRoot();
    const patches = { a: makePatch(root, 'a', 'A') };
    const args = { code: 'bytes', patches, patchNames: ['a'], patchOptions: {}, storageRoot: root };
    const ctx = setupBuildCache(args);
    markNondeterministic(ctx.key, root);
    const again = setupBuildCache(args);
    assert.equal(again.entry, null);
    assert.equal(again.nondeterministic, true);
  });
});
