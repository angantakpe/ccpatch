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
 * @param {{ path?: string }} [opts]
 * @returns {Memory}
 */
export function createMemory({ path: filePath } = {}) {
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

  /** @type {Record<string, any> | null} cached store; null until first load. */
  let cache = null;
  let loaded = false;
  /** Pending debounce timer (if any). */
  let timer = null;
  /** Whether the cache has unpersisted mutations. */
  let dirty = false;

  // Read the file exactly once; subsequent reads come from `cache`.
  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    cache = readFromDisk();
  }

  function readFromDisk() {
    try {
      // SIZE BOUND: guard before reading/parsing unbounded input.
      const { size } = statSync(resolved);
      if (size > MAX_FILE_BYTES) {
        console.warn(
          `createMemory: ${resolved} is ${size} bytes (> ${MAX_FILE_BYTES} cap); ignoring contents.`,
        );
        return {};
      }
      return JSON.parse(readFileSync(resolved, 'utf8'));
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
    // Unique-enough temp name: pid + time + random. This is runtime code (not a
    // reproducible workflow script), so Date.now()/Math.random() are fine.
    const tmp = `${resolved}.${pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: FILE_MODE, encoding: 'utf8' });
      renameSync(tmp, resolved);
      // Defensive: ensure the live file is 0600 regardless of any prior perms.
      chmodSync(resolved, FILE_MODE);
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
  }

  // Mark dirty and (re)arm the debounce timer. The actual write reads the
  // live `cache` at fire time, so coalesced sets are last-write-wins.
  function scheduleWrite() {
    dirty = true;
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
      scheduleWrite();
    },
    delete(key) {
      ensureLoaded();
      delete cache[key];
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
      return structuredClone(cache);
    },
    clear() {
      ensureLoaded();
      cache = {};
      scheduleWrite();
    },
    flush,
    dispose,
  };
}
