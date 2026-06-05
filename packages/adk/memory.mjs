import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { cwd } from 'node:process';

// Hard cap on the on-disk store: refuse to JSON.parse unbounded input.
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
// How long to coalesce rapid set()/delete() before hitting the disk.
const DEBOUNCE_MS = 100;

/**
 * @typedef {object} Memory
 * @property {(key: string) => any} get            Read a value (from cache).
 * @property {(key: string, value: any) => void} set    Write a value (cache + debounced async persist).
 * @property {(key: string) => void} delete        Remove a value (cache + debounced async persist).
 * @property {() => string[]} keys                 List keys (from cache).
 * @property {() => Record<string, any>} snapshot  Shallow copy of the whole store (from cache).
 * @property {() => void} clear                    Drop every key (cache + debounced async persist).
 * @property {() => Promise<void>} flush           Force-persist any pending write, awaitable.
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
  function writeToDisk() {
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, JSON.stringify(cache, null, 2), 'utf8');
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
  process.once('exit', onExit);

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
      return { ...cache };
    },
    clear() {
      ensureLoaded();
      cache = {};
      scheduleWrite();
    },
    flush,
  };
}
