import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  renameSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { cwd, pid } from 'node:process';

// Hard cap on the on-disk store: refuse to JSON.parse unbounded input.
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
// How long to coalesce rapid set()/delete() before hitting the disk.
const DEBOUNCE_MS = 100;
// HARD COALESCE CAP (FINDING 7): the debounce above re-arms on every mutation,
// so continuous set() churn can starve the flush indefinitely (the timer never
// fires because each new set() pushes it out another DEBOUNCE_MS). This is the
// absolute ceiling on how long dirty data may sit unwritten: once the OLDEST
// dirty mutation since the last flush is this old, the next scheduleWrite()
// flushes synchronously instead of re-arming the debounce.
const MAX_COALESCE_MS = 1000; // 1 s
// Owner-only perms for the persisted store (rw-------). The store can hold
// secrets, so it must never be world/group readable on disk.
const FILE_MODE = 0o600;

// ── module-level exit registry (FINDING 8) ───────────────────────────────────
// Every createMemory() instance must flush its pending write on process exit,
// but registering a separate process.once('exit', ...) per instance leaks
// listeners (Node MaxListeners warning) and retains each instance's closure
// for the life of the process. Instead we keep ONE module-level Set of
// flush-on-exit callbacks and register the 'exit' listener exactly once. Each
// instance adds its closure (and removes it via dispose()).
/** @type {Set<() => void>} pending flush-on-exit callbacks. */
const exitFlushers = new Set();
let exitListenerRegistered = false;

function registerExitListenerOnce() {
  if (exitListenerRegistered) return;
  exitListenerRegistered = true;
  // 'exit' handlers must be synchronous. Run every live instance's flusher;
  // each one swallows its own errors (nothing we can do at exit).
  process.on('exit', () => {
    for (const flush of exitFlushers) flush();
  });
}

/**
 * @typedef {object} MemoryTransform
 * @property {(jsonString: string) => string} [onWrite]  Map the serialized JSON string to the bytes-string actually written to disk (e.g. encrypt/encode). Default identity.
 * @property {(raw: string) => string} [onRead]          Map the raw bytes read from disk back to a JSON string before JSON.parse (e.g. decrypt/decode). Default identity. MUST be the inverse of onWrite.
 */

/**
 * @typedef {object} Memory
 * @property {(key: string) => any} get            Read a value (from cache).
 * @property {(key: string, value: any) => void} set    Write a value (cache + debounced async persist).
 * @property {(key: string) => void} delete        Remove a value (cache + debounced async persist).
 * @property {() => string[]} keys                 List keys (from cache).
 * @property {() => Record<string, any>} snapshot  DEEP copy of the whole store (from cache); nested mutations cannot leak back into the live store.
 * @property {() => void} clear                    Drop every key (cache + debounced async persist).
 * @property {() => Promise<void>} flush           Force-persist any pending write, awaitable.
 * @property {() => void} dispose                  Detach from the module exit registry and cancel any pending debounce timer. Idempotent. Pending dirty data is NOT auto-flushed — call flush() first if you need it persisted. After dispose() the instance still works but will not auto-persist on exit.
 */

/**
 * Create a JSON-file key/value store with an in-memory write-through cache.
 *
 * The file is loaded lazily once on first access and then kept in memory:
 * get/keys/snapshot never touch the fs. set/delete/clear mutate the cache and
 * schedule a DEBOUNCED async write (last-write-wins, no lost write). flush()
 * forces the pending write synchronously/awaitably; it also runs on exit.
 *
 * @param {{ path?: string, transform?: MemoryTransform }} [opts]
 * @returns {Memory}
 */
export function createMemory({ path: filePath, transform } = {}) {
  const root = resolve(cwd());
  const resolved = resolve(filePath ?? `${root}/.claude/adk-memory.json`);

  // PATH SANDBOX: the resolved path must live within the project root.
  // relative(root, resolved) starting with '..' (or being absolute on its own)
  // means the target escaped the root via traversal or an outside absolute path.
  const rel = relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `createMemory: path escapes project root: ${resolved} is not within ${root}`,
    );
  }

  // ENCRYPTION/REDACTION HOOK (FINDING 11c): callers may plug in a reversible
  // transform to map the serialized JSON to/from on-disk bytes (e.g. encrypt,
  // base64, redact). Default is identity → plaintext JSON (backward compatible).
  // We never bundle a crypto lib; onWrite/onRead are the caller's responsibility
  // and MUST be inverses of each other.
  const onWrite =
    typeof transform?.onWrite === 'function' ? transform.onWrite : (s) => s;
  const onRead =
    typeof transform?.onRead === 'function' ? transform.onRead : (s) => s;

  /** @type {Record<string, any> | null} cached store; null until first load. */
  let cache = null;
  let loaded = false;
  /** Pending debounce timer (if any). */
  let timer = null;
  /** Whether the cache has unpersisted mutations. */
  let dirty = false;
  /**
   * Memoized deep clone of `cache` for snapshot() (FINDING 6). null means
   * "stale, must rebuild". Invalidated on every mutation; rebuilt lazily by the
   * first snapshot() after a write and reused (cloned again per call) thereafter.
   * @type {Record<string, any> | null}
   */
  let snapshotClone = null;
  /**
   * mtimeMs of the file at the moment we loaded it (FINDING 11b). Used to detect
   * a concurrent cross-process write so writeToDisk() can re-read + merge rather
   * than blindly clobbering another process's keys. -Infinity = never observed.
   */
  let loadedMtimeMs = -Infinity;
  /**
   * The set of keys mutated by THIS instance since the last successful flush
   * (FINDING 11b). On a detected concurrent write we re-apply only these over the
   * fresher disk store (last-write-wins per dirty key, other processes' keys kept).
   * @type {Set<string>}
   */
  let dirtyKeys = new Set();
  /**
   * `true` when this instance cleared the whole store since the last flush
   * (FINDING 11b). A clear() is not expressible as per-key dirt, so on a merge we
   * must drop every disk key this instance knew about; we conservatively treat a
   * pending clear as "our view replaces disk entirely except for unknown keys".
   */
  let dirtyClear = false;
  /**
   * Timestamp (Date.now()) of the FIRST dirty mutation since the last flush
   * (FINDING 7). -1 = clean. Used to enforce MAX_COALESCE_MS.
   */
  let firstDirtyAt = -1;

  // Read the file exactly once; subsequent reads come from `cache`.
  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    cache = readFromDisk();
  }

  // Read + parse the on-disk store, returning a plain object (never null/array).
  // Records loadedMtimeMs as a side effect so writeToDisk() can detect a newer
  // cross-process write. Returns {} for missing/oversized/corrupt/malformed
  // files (matches prior behaviour).
  function readFromDisk() {
    try {
      // SIZE BOUND: guard before reading/parsing unbounded input.
      const st = statSync(resolved);
      loadedMtimeMs = st.mtimeMs;
      if (st.size > MAX_FILE_BYTES) {
        console.warn(
          `createMemory: ${resolved} is ${st.size} bytes (> ${MAX_FILE_BYTES} cap); ignoring contents.`,
        );
        return {};
      }
      // onRead maps the raw on-disk bytes back to a JSON string (identity by
      // default). A throwing/garbage transform falls through to the catch → {}.
      const parsed = JSON.parse(onRead(readFileSync(resolved, 'utf8')));
      // SHAPE VALIDATION (FINDING 11a): a corrupt-but-parseable array/primitive
      // (e.g. "[1,2]" or "42" or "null") must NOT become the store — get/set
      // assume a plain object. Reset to {} and warn.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        if (process.env.CLAUDE_DEBUG || globalThis.__ccpDebug) {
          console.warn(
            `createMemory: ${resolved} parsed to a non-object (${
              Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed
            }); resetting to empty store.`,
          );
        }
        return {};
      }
      return parsed;
    } catch {
      // Missing/corrupt file → empty store (matches prior behaviour).
      return {};
    }
  }

  // Synchronously persist the current cache to disk.
  //
  // SECURITY/DURABILITY (FINDING 7): the file is written 0600 (owner rw only)
  // and replaced ATOMICALLY. We write to a sibling temp file with { mode: 0o600 }
  // then renameSync() over the target — a crash mid-write leaves the old file
  // intact rather than a half-written/corrupt JSON. rename(2) within the same
  // directory is atomic on POSIX. We chmod the final path defensively in case a
  // pre-existing target had looser perms (rename keeps the source inode's mode,
  // so this is belt-and-suspenders). The temp file is cleaned up best-effort on
  // failure. Still: the contents are UNTRUSTED-AT-REST PLAINTEXT JSON — 0600
  // limits who can read it, it is not encrypted.
  //
  // SCALE (FINDING 10): every flush rewrites the WHOLE file (O(store)), not a
  // delta. That is acceptable here because MAX_FILE_BYTES (5 MB) bounds the
  // rewrite cost. A store that outgrows that cap should move to an append/delta
  // log format instead of full-file rewrites.
  function writeToDisk() {
    mkdirSync(dirname(resolved), { recursive: true });

    // CROSS-PROCESS LOST-WRITE SAFETY (FINDING 11b): if the on-disk file's mtime
    // is NEWER than what we loaded, another process wrote it after us. Blindly
    // writing our cache would drop their keys. Instead re-read the fresher disk
    // store and re-apply only OUR dirty keys over it (last-write-wins per dirty
    // key; keys other processes added survive). A pending clear() means our view
    // is authoritative for keys we knew about, but we still keep keys the other
    // process introduced that we never touched is not expressible — clear wipes
    // everything, so on clear we keep only the fresher store's brand-new keys
    // minus nothing; we honour the clear by starting from the disk store and
    // removing nothing extra (our dirtyKeys after a clear are the re-sets, if any).
    try {
      const st = statSync(resolved);
      if (st.mtimeMs > loadedMtimeMs && st.size <= MAX_FILE_BYTES) {
        const diskRaw = JSON.parse(onRead(readFileSync(resolved, 'utf8')));
        if (diskRaw !== null && typeof diskRaw === 'object' && !Array.isArray(diskRaw)) {
          if (dirtyClear) {
            // We cleared then possibly re-set some keys. The cleared keys we
            // knew about should go; keys the other process ADDED that we never
            // saw must stay. We can't tell which disk keys are "new" vs "ours",
            // so the safe merge is: keep disk keys we never had a dirty op on,
            // then overlay our surviving cache (the post-clear re-sets).
            const merged = {};
            for (const k of Object.keys(diskRaw)) {
              // A key we explicitly touched (dirtyKeys) is governed by our cache;
              // an untouched disk key is another process's and is preserved.
              if (!dirtyKeys.has(k)) merged[k] = diskRaw[k];
            }
            for (const k of dirtyKeys) {
              if (Object.prototype.hasOwnProperty.call(cache, k)) merged[k] = cache[k];
            }
            cache = merged;
          } else {
            // Re-apply our per-key dirt over the fresher disk contents.
            const merged = diskRaw;
            for (const k of dirtyKeys) {
              if (Object.prototype.hasOwnProperty.call(cache, k)) {
                merged[k] = cache[k]; // we set/updated this key → last write wins
              } else {
                delete merged[k]; // we deleted this key → honour the delete
              }
            }
            cache = merged;
            // The merge changed the cache shape; any memoized snapshot is stale.
            snapshotClone = null;
          }
        }
      }
    } catch {
      // Stat/read/parse of the existing file failed → fall through and write our
      // cache as-is (best effort; matches "no readable concurrent state" case).
    }

    // Unique-enough temp name: pid + time + random. This is runtime code (not a
    // reproducible workflow script), so Date.now()/Math.random() are fine.
    const tmp = `${resolved}.${pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      // onWrite maps the serialized JSON to the bytes actually persisted
      // (identity by default → plaintext JSON).
      writeFileSync(tmp, onWrite(JSON.stringify(cache, null, 2)), {
        mode: FILE_MODE,
        encoding: 'utf8',
      });
      renameSync(tmp, resolved);
      // Defensive: ensure the live file is 0600 regardless of any prior perms.
      chmodSync(resolved, FILE_MODE);
      // Record the mtime we just produced as our new "loaded" baseline so a
      // subsequent same-instance write doesn't see its OWN write as concurrent.
      try {
        loadedMtimeMs = statSync(resolved).mtimeMs;
      } catch {
        /* ignore: best-effort baseline refresh */
      }
    } catch (err) {
      // Best-effort cleanup so we don't litter .tmp files on a failed write.
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore cleanup failure */
      }
      throw err;
    }
    dirty = false;
    // Reset the dirty-tracking state now the cache is fully persisted.
    dirtyKeys = new Set();
    dirtyClear = false;
    firstDirtyAt = -1; // FINDING 7: restart the coalesce window after a flush.
  }

  // Mark dirty and (re)arm the debounce timer. The actual write reads the
  // live `cache` at fire time, so coalesced sets are last-write-wins.
  function scheduleWrite() {
    dirty = true;
    // FINDING 7: track the oldest dirty mutation since the last flush. If the
    // debounce keeps getting re-armed by continuous churn, the hard cap below
    // forces a flush once that oldest mutation is MAX_COALESCE_MS old, so a
    // write can never be starved indefinitely.
    const now = Date.now();
    if (firstDirtyAt < 0) firstDirtyAt = now;
    if (now - firstDirtyAt >= MAX_COALESCE_MS) {
      // Hard cap hit: flush NOW instead of re-arming the debounce.
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        writeToDisk();
      } catch (err) {
        console.warn(`createMemory: coalesce-cap write failed: ${err?.message ?? err}`);
      }
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        writeToDisk();
      } catch (err) {
        // Don't crash the event loop on a background write failure; surface it.
        console.warn(`createMemory: debounced write failed: ${err?.message ?? err}`);
      }
    }, DEBOUNCE_MS);
    // Don't keep the process alive solely for a pending memory flush.
    if (typeof timer?.unref === 'function') timer.unref();
  }

  // Force any pending write to land now. Awaitable; safe to call when clean.
  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (dirty) writeToDisk();
  }

  // Best-effort flush on process exit so a debounced write isn't lost.
  // 'exit' handlers must be synchronous, so call writeToDisk() directly.
  //
  // FINDING 8: rather than each instance registering its own
  // process.once('exit', ...) (which leaks listeners + retains closures), we
  // add this closure to the module-level registry and ensure the single shared
  // 'exit' listener is installed. dispose() removes us from the registry.
  const onExit = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (dirty) {
      try {
        writeToDisk();
      } catch {
        /* nothing we can do at exit */
      }
    }
  };
  exitFlushers.add(onExit);
  registerExitListenerOnce();

  // Detach from the exit registry and cancel any pending debounce timer.
  // Idempotent (Set.delete on a missing entry is a no-op). Does NOT flush
  // pending dirty data — callers that care should flush() first.
  function dispose() {
    exitFlushers.delete(onExit);
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    get(key) {
      ensureLoaded();
      return cache[key];
    },
    set(key, value) {
      ensureLoaded();
      cache[key] = value;
      dirtyKeys.add(key); // FINDING 11b: remember what WE changed for the merge.
      snapshotClone = null; // FINDING 6: invalidate the memoized snapshot.
      scheduleWrite();
    },
    delete(key) {
      ensureLoaded();
      delete cache[key];
      dirtyKeys.add(key); // FINDING 11b: a delete is dirt too (key→absent in cache).
      snapshotClone = null; // FINDING 6: invalidate the memoized snapshot.
      scheduleWrite();
    },
    keys() {
      ensureLoaded();
      return Object.keys(cache);
    },
    snapshot() {
      ensureLoaded();
      // DEEP copy (FINDING 15): a shallow { ...cache } shares nested object/array
      // refs, so a caller mutating snapshot().foo.bar would corrupt the live
      // store. structuredClone() (Node 17+) gives a dependency-free deep clone.
      //
      // MEMOIZED CLONE (FINDING 6): structuredClone(cache) on EVERY call is
      // O(store). Instead we cache ONE clone (snapshotClone) and invalidate it on
      // any mutation. The first snapshot() after a write rebuilds it; subsequent
      // calls clone the (already-deep) memo. We still return a FRESH clone every
      // time so callers can never mutate the live store — nor each other's
      // snapshots — through the returned value.
      if (snapshotClone === null) snapshotClone = structuredClone(cache);
      return structuredClone(snapshotClone);
    },
    clear() {
      ensureLoaded();
      cache = {};
      dirtyClear = true; // FINDING 11b: whole-store wipe; merge handles it specially.
      dirtyKeys = new Set(); // post-clear set()s repopulate this.
      snapshotClone = null; // FINDING 6: invalidate the memoized snapshot.
      scheduleWrite();
    },
    flush,
    dispose,
  };
}
