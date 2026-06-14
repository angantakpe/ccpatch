import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  statSync,
  renameSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { cwd, pid } from 'node:process';

// Default hard cap on the on-disk store: refuse to JSON.parse unbounded input.
// Overridable per-instance via createMemory({ maxBytes }). In the default
// (atomic-rewrite) mode this bounds the whole-file rewrite cost; in append-log
// mode it is the compaction threshold (the delta log is rewritten to a fresh
// snapshot once it grows past this).
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
// How long to coalesce rapid set()/delete() before hitting the disk.
const DEBOUNCE_MS = 100;
// HARD COALESCE CAP: the debounce above re-arms on every mutation,
// so continuous set() churn can starve the flush indefinitely (the timer never
// fires because each new set() pushes it out another DEBOUNCE_MS). This is the
// absolute ceiling on how long dirty data may sit unwritten: once the OLDEST
// dirty mutation since the last flush is this old, the next scheduleWrite()
// flushes synchronously instead of re-arming the debounce.
const MAX_COALESCE_MS = 1000; // 1 s
// Owner-only perms for the persisted store (rw-------). The store can hold
// secrets, so it must never be world/group readable on disk.
const FILE_MODE = 0o600;

// ── module-level exit registry ────────────────────────────────────────────────
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
 * SCALE MODES:
 *   - default (atomic-rewrite): every flush rewrites the whole file via a 0600
 *     temp + atomic rename, with cross-process lost-write merge. O(store) per
 *     flush; bounded by `maxBytes`.
 *   - append-log (`appendLog: true`): mutations are appended as NDJSON delta
 *     records to a sibling `<path>.log`, so a write is O(delta) regardless of
 *     store size. The log is replayed on load and COMPACTED back to a single
 *     snapshot record once it exceeds `maxBytes`. This is the path the original
 *     5 MB-cap TODO called for; use it for stores that legitimately outgrow the
 *     full-rewrite cost. TRADE-OFF: append-log mode does NOT perform the
 *     cross-process key merge the rewrite path does — the last process to write
 *     a key wins (a single owning process is the intended model).
 *
 * @param {{ path?: string, transform?: MemoryTransform, maxBytes?: number, appendLog?: boolean }} [opts]
 * @returns {Memory}
 */
export function createMemory({ path: filePath, transform, maxBytes, appendLog = false } = {}) {
  const root = resolve(cwd());
  const resolved = resolve(filePath ?? `${root}/.claude/adk-memory.json`);
  // Per-instance cap (compaction threshold in append-log mode). A non-finite or
  // non-positive override falls back to the default rather than disabling the cap.
  const capBytes =
    typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
      ? maxBytes
      : MAX_FILE_BYTES;
  // Sibling delta-log path (append-log mode only).
  const logPath = `${resolved}.log`;

  // PATH SANDBOX: the resolved path must live within the project root.
  // relative(root, resolved) starting with '..' (or being absolute on its own)
  // means the target escaped the root via traversal or an outside absolute path.
  const rel = relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `createMemory: path escapes project root: ${resolved} is not within ${root}`,
    );
  }

  // ENCRYPTION/REDACTION HOOK: callers may plug in a reversible
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
   * Memoized deep clone of `cache` for snapshot(). null means
   * "stale, must rebuild". Invalidated on every mutation; rebuilt lazily by the
   * first snapshot() after a write and reused (cloned again per call) thereafter.
   * @type {Record<string, any> | null}
   */
  let snapshotClone = null;
  /**
   * mtimeMs of the file at the moment we loaded it. Used to detect
   * a concurrent cross-process write so writeToDisk() can re-read + merge rather
   * than blindly clobbering another process's keys. -Infinity = never observed.
   */
  let loadedMtimeMs = -Infinity;
  /**
   * The set of keys mutated by THIS instance since the last successful flush.
   * On a detected concurrent write we re-apply only these over the
   * fresher disk store (last-write-wins per dirty key, other processes' keys kept).
   * @type {Set<string>}
   */
  let dirtyKeys = new Set();
  /**
   * Every key this instance has ever KNOWN about — loaded from disk or written
   * via set() — since the last successful flush. On a clear-merge this lets us
   * drop EXACTLY the keys we knew (and therefore intended to wipe) while
   * preserving keys a concurrent writer genuinely introduced behind our back.
   * @type {Set<string>}
   */
  let knownKeys = new Set();
  /**
   * `true` when this instance cleared the whole store since the last flush.
   * A clear() is not expressible as per-key dirt, so the merge handles it via
   * knownKeys (see writeToDisk): we drop the keys we knew, keep foreign keys.
   */
  let dirtyClear = false;
  /**
   * Timestamp (Date.now()) of the FIRST dirty mutation since the last flush.
   * -1 = clean. Used to enforce MAX_COALESCE_MS.
   */
  let firstDirtyAt = -1;

  // ── append-log (delta) persistence ──────────────────────────────────────────
  // Reconstruct the store by replaying the NDJSON delta log over the base
  // snapshot. Each line is one record: a {snap:{…}} compaction checkpoint, or a
  // delta {op:'set'|'del'|'clear', key?, value?}. Replayed in file order, so the
  // last write to a key wins. Malformed lines are skipped (best-effort), and the
  // whole log falls back to the base snapshot on any read error.
  function readFromLog(base) {
    let store = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
    let raw;
    try {
      // NOTE: we intentionally do NOT cap the log read by capBytes. The log is
      // compacted to a single {snap:…} checkpoint once its DELTA growth exceeds
      // the cap (see appendDelta/compactLog), but that checkpoint is bounded by
      // the STORE size, not the delta cap — a large store legitimately yields a
      // snapshot bigger than capBytes. Bounding the read here would discard a
      // valid compacted log. Replay is O(log) and the compactor keeps the log
      // from growing without bound in deltas.
      statSync(logPath); // throws → no log yet → base snapshot only (catch below)
      raw = onRead(readFileSync(logPath, 'utf8'));
    } catch {
      return store; // no log yet / unreadable → base snapshot only
    }
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let rec;
      try { rec = JSON.parse(s); } catch { continue; } // skip a torn/garbage line
      if (!rec || typeof rec !== 'object') continue;
      if (rec.snap && typeof rec.snap === 'object' && !Array.isArray(rec.snap)) {
        store = rec.snap; // a checkpoint replaces everything before it
      } else if (rec.op === 'set' && typeof rec.key === 'string') {
        store[rec.key] = rec.value;
      } else if (rec.op === 'del' && typeof rec.key === 'string') {
        delete store[rec.key];
      } else if (rec.op === 'clear') {
        store = {};
      }
    }
    return store;
  }

  // Append one delta record to the log (O(record), not O(store)). Creates the
  // dir + 0600 log on first write. Compacts to a fresh snapshot once the log
  // outgrows the cap so replay cost stays bounded. Never throws into the caller.
  function appendDelta(rec) {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      let size = 0;
      try { size = statSync(logPath).size; } catch { /* no log yet */ }
      if (size > capBytes) {
        compactLog();
        return;
      }
      appendFileSync(logPath, onWrite(JSON.stringify(rec)) + '\n', { mode: FILE_MODE, encoding: 'utf8' });
      try { chmodSync(logPath, FILE_MODE); } catch { /* belt-and-suspenders */ }
      dirty = false;
      firstDirtyAt = -1;
    } catch (err) {
      console.warn(`createMemory: delta append failed: ${err?.message ?? err}`);
    }
  }

  // Rewrite the log as a single snapshot checkpoint (atomic temp + rename). This
  // is the only O(store) write in append-log mode; it runs when the log grows
  // past the cap or on an explicit flush of pending dirt.
  function compactLog() {
    mkdirSync(dirname(logPath), { recursive: true });
    const tmp = `${logPath}.${pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(tmp, onWrite(JSON.stringify({ snap: cache })) + '\n', { mode: FILE_MODE, encoding: 'utf8' });
      renameSync(tmp, logPath);
      chmodSync(logPath, FILE_MODE);
    } catch (err) {
      try { rmSync(tmp, { force: true }); } catch { /* ignore cleanup failure */ }
      throw err;
    }
    dirty = false;
    firstDirtyAt = -1;
  }

  // Read the file exactly once; subsequent reads come from `cache`.
  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    cache = appendLog ? readFromLog(readFromDisk()) : readFromDisk();
    // Seed knownKeys with everything we loaded: these are keys this instance is
    // aware of, so on a clear-merge they are ours to drop (vs. foreign keys).
    for (const k of Object.keys(cache)) knownKeys.add(k);
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
      if (st.size > capBytes) {
        console.warn(
          `createMemory: ${resolved} is ${st.size} bytes (> ${capBytes} cap); ignoring contents. ` +
          `Raise it with createMemory({ maxBytes }) or switch to { appendLog: true } for O(delta) writes.`,
        );
        return {};
      }
      // onRead maps the raw on-disk bytes back to a JSON string (identity by
      // default). A throwing/garbage transform falls through to the catch → {}.
      const parsed = JSON.parse(onRead(readFileSync(resolved, 'utf8')));
      // SHAPE VALIDATION: a corrupt-but-parseable array/primitive
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
  // SECURITY/DURABILITY: the file is written 0600 (owner rw only)
  // and replaced ATOMICALLY. We write to a sibling temp file with { mode: 0o600 }
  // then renameSync() over the target — a crash mid-write leaves the old file
  // intact rather than a half-written/corrupt JSON. rename(2) within the same
  // directory is atomic on POSIX. We chmod the final path defensively in case a
  // pre-existing target had looser perms (rename keeps the source inode's mode,
  // so this is belt-and-suspenders). The temp file is cleaned up best-effort on
  // failure. Still: the contents are UNTRUSTED-AT-REST PLAINTEXT JSON — 0600
  // limits who can read it, it is not encrypted.
  //
  // SCALE: in the DEFAULT mode every flush rewrites the WHOLE file (O(store)),
  // not a delta — acceptable because `capBytes` bounds the rewrite cost. A store
  // that outgrows that cap should pass { appendLog: true } to createMemory(),
  // which persists O(delta) NDJSON records (see appendDelta/compactLog below) and
  // only pays the O(store) rewrite at compaction time.
  function writeToDisk() {
    mkdirSync(dirname(resolved), { recursive: true });

    // CROSS-PROCESS LOST-WRITE SAFETY. If the on-disk file's mtime is NEWER than
    // what we loaded, another process wrote it after us. Blindly writing our cache
    // would drop their keys, so we re-read the fresher disk store and merge.
    //
    // Guarantees this merge provides:
    //   - Per-key last-write-wins for keys WE mutated (dirtyKeys): a set() wins
    //     over the disk value, a delete() removes the key.
    //   - Keys a concurrent writer added that we never knew about are preserved.
    //   - On a pending clear(), every key THIS instance knew about (knownKeys:
    //     loaded-from-disk + ever-set) is dropped, while genuinely-foreign keys
    //     a concurrent writer introduced after our load survive.
    //
    // What it does NOT guarantee under concurrent clear(): knownKeys distinguishes
    // foreign keys by identity, not by causality. If a concurrent writer re-creates
    // a key with the SAME NAME as one we knew (and intended to wipe), our clear
    // drops it — we cannot tell their fresh key apart from the one we deleted.
    // This is the inherent ambiguity of clear() vs. a concurrent same-key write;
    // we resolve it in favour of honouring the local clear for known names.
    try {
      const st = statSync(resolved);
      if (st.mtimeMs > loadedMtimeMs && st.size <= capBytes) {
        const diskRaw = JSON.parse(onRead(readFileSync(resolved, 'utf8')));
        if (diskRaw !== null && typeof diskRaw === 'object' && !Array.isArray(diskRaw)) {
          if (dirtyClear) {
            // Drop the keys we knew about (our clear wipes them); keep foreign
            // keys a concurrent writer introduced. Then overlay our surviving
            // cache (any post-clear re-set()s, which are also in dirtyKeys).
            const merged = {};
            for (const k of Object.keys(diskRaw)) {
              if (!knownKeys.has(k)) merged[k] = diskRaw[k];
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
    // Reset the dirty-tracking state now the cache is fully persisted. knownKeys
    // is reseeded from the just-persisted cache: those are the keys this instance
    // is now aware of going into the next clear/merge cycle.
    dirtyKeys = new Set();
    knownKeys = new Set(Object.keys(cache));
    dirtyClear = false;
    firstDirtyAt = -1; // restart the coalesce window after a flush.
  }

  // Persist one mutation. In append-log mode this writes an O(delta) record
  // immediately (no debounce — appends are cheap and we want crash-durability of
  // each delta); in the default mode it marks dirty + arms the debounced rewrite.
  function persist(rec) {
    if (appendLog) {
      dirty = true;
      appendDelta(rec);
      return;
    }
    scheduleWrite();
  }

  // Mark dirty and (re)arm the debounce timer. The actual write reads the
  // live `cache` at fire time, so coalesced sets are last-write-wins.
  function scheduleWrite() {
    dirty = true;
    // Track the oldest dirty mutation since the last flush. If the
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
  // In append-log mode each delta is already written synchronously on mutation,
  // so flush() only has work if a delta append failed (still dirty) — then we
  // compact the whole store to a clean snapshot.
  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return;
    if (appendLog) compactLog();
    else writeToDisk();
  }

  // Best-effort flush on process exit so a debounced write isn't lost.
  // 'exit' handlers must be synchronous, so call writeToDisk() directly.
  //
  // Rather than each instance registering its own
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
        if (appendLog) compactLog();
        else writeToDisk();
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
      dirtyKeys.add(key); // remember what WE changed for the merge.
      knownKeys.add(key); // we are now aware of this key (matters for clear-merge).
      snapshotClone = null; // invalidate the memoized snapshot.
      persist({ op: 'set', key, value });
    },
    delete(key) {
      ensureLoaded();
      delete cache[key];
      dirtyKeys.add(key); // a delete is dirt too (key→absent in cache).
      snapshotClone = null; // invalidate the memoized snapshot.
      persist({ op: 'del', key });
    },
    keys() {
      ensureLoaded();
      return Object.keys(cache);
    },
    snapshot() {
      ensureLoaded();
      // DEEP copy: a shallow { ...cache } shares nested object/array
      // refs, so a caller mutating snapshot().foo.bar would corrupt the live
      // store. structuredClone() (Node 17+) gives a dependency-free deep clone.
      //
      // MEMOIZED CLONE: structuredClone(cache) on EVERY call is
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
      dirtyClear = true; // whole-store wipe; merge handles it via knownKeys.
      dirtyKeys = new Set(); // post-clear set()s repopulate this.
      // NB: knownKeys is intentionally NOT cleared — it records the keys this
      // instance intends to wipe, which the clear-merge needs to drop them.
      snapshotClone = null; // invalidate the memoized snapshot.
      persist({ op: 'clear' });
    },
    flush,
    dispose,
  };
}
