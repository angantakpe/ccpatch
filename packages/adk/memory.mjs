import {
  readFileSync,
  appendFileSync,
  mkdirSync,
  statSync,
  renameSync,
  chmodSync,
  rmSync,
  realpathSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { cwd, pid, kill } from 'node:process';
import { host } from './host.mjs';

// Default hard cap on the on-disk store: refuse to JSON.parse unbounded input.
// Overridable per-instance via createMemory({ maxBytes }). In the default
// (atomic-rewrite) mode this bounds the whole-file rewrite cost; in append-log
// mode it is the compaction threshold (the delta log is rewritten to a fresh
// snapshot once it grows past this).
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
// Ceiling on the append-log READ. A HEALTHY log holds at most one snapshot
// checkpoint plus the deltas accumulated since the last compaction; appendDelta()
// compacts before the deltas would cross capBytes, so the delta tail is bounded by
// capBytes. The SNAPSHOT, however, is bounded by STORE size — which in append-log
// mode is intentionally allowed to exceed capBytes (capBytes is the delta
// COMPACTION THRESHOLD here, not a store-size cap). So the read ceiling must give
// the snapshot generous absolute room while still bounding the delta tail:
//   ceiling = LOG_READ_CAP_FACTOR × max(capBytes, MAX_FILE_BYTES)
// This admits any legitimate compacted log (snapshot + ≤capBytes of deltas) yet
// refuses to read/parse a log that has grown WITHOUT BOUND — a stale file from an
// older unbounded writer, or an external appender — recovering from the base
// snapshot instead. That is the COD-5 guarantee: a store past the cap never
// re-reads unbounded data on load. See readFromLog.
const LOG_READ_CAP_FACTOR = 4;
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
// Absolute backstop: a lock older than this is stolen EVEN IF its holder pid still
// looks alive. Guards against pid REUSE (a crashed holder's pid recycled by an
// unrelated live process would otherwise wedge the store forever) and genuinely
// hung writers. Must be >> any legitimate read-merge-write critical section.
const LOCK_HARD_STALE_MS = 60_000; // 60 s
// Bounded synchronous wait when a LIVE writer holds the lock: rather than
// immediately falling back to an UNLOCKED write (which reopens the exact TOCTOU
// the lock closes), spin a short, bounded interval and retry. ~1 s total worst
// case, only ever paid under genuine contention.
const LOCK_RETRY_MS = 25;
const LOCK_RETRY_ATTEMPTS = 40;

// PATH-SANDBOX ANCHOR: the store's containment root is anchored to an EXPLICIT,
// STABLE root rather than live process.cwd(). cwd() is mutable — a later
// process.chdir() (or a handler that chdir's before constructing a store) moves
// the goalposts and can let a path that was OUTSIDE the sandbox become "inside"
// (or vice-versa), silently breaking containment on a store that may hold
// secrets. We snapshot the root ONCE at module import — before any agent handler
// has had a chance to chdir — and resolve it through resolveProjectRoot() in
// priority order so a host can pin it explicitly instead of inheriting whatever
// cwd happened to be at import:
//   1. an explicit `root` passed to createMemory()        (per-instance override)
//   2. globalThis.__ccpProjectRoot                        (host-pinned root, if any)
//   3. ADK_ROOT — cwd() snapshotted at import             (chdir-immune fallback)
// The resolved value is an absolute path; cwd() is never re-read after import.
const ADK_ROOT = resolve(cwd());
/**
 * Resolve the sandbox root for a store. Explicit `root` wins, then a host-pinned
 * global, then the import-time snapshot — NEVER live cwd(), so a runtime chdir()
 * cannot relocate the sandbox.
 * @param {string} [explicitRoot]
 * @returns {string} an absolute, chdir-immune project root.
 */
function resolveProjectRoot(explicitRoot) {
  if (typeof explicitRoot === 'string' && explicitRoot.length > 0) {
    return resolve(explicitRoot);
  }
  const hostRoot = globalThis.__ccpProjectRoot;
  if (typeof hostRoot === 'string' && hostRoot.length > 0) {
    return resolve(hostRoot);
  }
  return ADK_ROOT;
}

// Keys that, when assigned via `obj[key] = value` (bracket assignment), would
// mutate object internals instead of storing data — `obj['__proto__'] = {...}`
// invokes the prototype setter and corrupts the target. The snapshot/JSON.parse
// paths produce these as own DATA properties (harmless), but the delta-replay and
// cross-process merge paths use bracket assignment from UNTRUSTED-at-rest file
// content, so we filter these keys uniformly for defence-in-depth on a store that
// may hold secrets and is shared cross-process by path.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** @returns {boolean} true when `k` is a string safe to use as a store key. */
function isSafeKey(k) {
  return typeof k === 'string' && !UNSAFE_KEYS.has(k);
}

// ── durable write helpers ─────────────────────────────────────────────────────
// DURABILITY: a bare writeFileSync(tmp) followed by renameSync gives ATOMICITY
// (the rename swaps inodes atomically) but NOT durability — the file's data may
// still be sitting in the page cache when the rename's directory entry hits disk.
// A power/OS crash in that window can leave a renamed-but-zero-length / garbage
// file, contradicting the crash-safety claim. To actually be crash-safe we must
// fsync the file's data BEFORE the rename, and fsync the DIRECTORY after it so the
// rename itself is durable.

/**
 * Write `bytes` to `tmpPath` and fsync the file data to disk before returning.
 * openSync→writeSync→fsyncSync→closeSync (close in a finally so the fd never
 * leaks even if write/fsync throws). Throws on failure (caller cleans up tmp).
 * @param {string} tmpPath
 * @param {string} bytes
 */
function writeFileDurable(tmpPath, bytes) {
  const fd = openSync(tmpPath, 'w', FILE_MODE);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd); // flush the file's data+metadata to stable storage.
  } finally {
    closeSync(fd);
  }
}

/**
 * Best-effort fsync of a directory so a rename INTO it is durable. Wrapped so it
 * never throws: some platforms/filesystems reject opening a dir for fsync, and a
 * failure here only weakens durability — it must never break a successful write.
 * @param {string} dirPath
 */
function fsyncDir(dirPath) {
  try {
    const dfd = openSync(dirPath, 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* directory fsync unsupported / failed — non-fatal, durability best-effort */
  }
}

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
 * @param {{ path?: string, root?: string, transform?: MemoryTransform, maxBytes?: number, appendLog?: boolean }} [opts]
 * @returns {Memory}
 */
export function createMemory({ path: filePath, root: rootOpt, transform, maxBytes, appendLog = false } = {}) {
  // Containment root is the EXPLICIT, chdir-immune anchor (see resolveProjectRoot
  // / ADK_ROOT above) — NOT a live cwd() read, so a later process.chdir() can't
  // move the sandbox out from under an already-constructed store.
  const root = resolveProjectRoot(rootOpt);
  const resolved = resolve(filePath ?? `${root}/.claude/adk-memory.json`);
  // Per-instance cap (compaction threshold in append-log mode). A non-finite or
  // non-positive override falls back to the default rather than disabling the cap.
  const capBytes =
    typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
      ? maxBytes
      : MAX_FILE_BYTES;
  // Sibling delta-log path (append-log mode only).
  const logPath = `${resolved}.log`;

  // PATH SANDBOX (lexical pre-filter): the resolved path must live within the
  // project root. relative(root, resolved) starting with '..' (or being absolute
  // on its own) means the target escaped the root via traversal or an outside
  // absolute path. This is a FAST string-only check — it does NOT follow
  // symlinks, so it is only the first of two gates.
  const rel = relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `createMemory: path escapes project root: ${resolved} is not within ${root}`,
    );
  }

  // PATH SANDBOX (canonical / symlink check): the lexical check above operates on
  // the resolved STRING and is blind to symlinks. A symlinked `.claude/` (or any
  // ancestor directory) would let every read/write follow the link OUT of the
  // sandbox while still passing the lexical gate. So we canonicalize with
  // realpathSync and re-verify containment against the canonical root.
  //
  // realpathSync throws if ANY path component does not exist, and the target file
  // legitimately may not exist yet (it is created lazily on first flush). So we
  // canonicalize the DEEPEST EXISTING ANCESTOR of `resolved` (walking up until a
  // realpathSync succeeds — at worst the root, which always exists), then re-attach
  // the non-existent tail lexically. The resulting canonical path is what the fs
  // would actually touch, with every existing symlink resolved.
  function canonicalizeWithinRoot(target) {
    // Resolve the root itself canonically (the root always exists). If the root
    // is itself reached through a symlink, every contained path must be compared
    // against the canonical root, not the lexical one.
    let canonicalRoot;
    try {
      canonicalRoot = realpathSync(root);
    } catch {
      // Can't canonicalize the root (extraordinarily unlikely); fall back to the
      // lexical root so we still perform a containment check rather than skipping.
      canonicalRoot = root;
    }

    // Walk up from `target` to the nearest existing ancestor, collecting the
    // non-existent tail segments so we can re-append them after realpathSync.
    const tail = [];
    let probe = target;
    for (;;) {
      try {
        const realProbe = realpathSync(probe);
        // Re-attach any non-existent tail segments (lexically; they can't be
        // symlinks because they don't exist yet).
        const canonical = tail.length ? resolve(realProbe, ...tail) : realProbe;
        return { canonical, canonicalRoot };
      } catch {
        const parent = dirname(probe);
        if (parent === probe) {
          // Reached the filesystem root without finding an existing ancestor
          // (should be impossible since `root` exists); give up canonicalizing.
          return { canonical: target, canonicalRoot };
        }
        tail.unshift(probe.slice(parent.length + 1)); // the basename segment
        probe = parent;
      }
    }
  }

  const { canonical, canonicalRoot } = canonicalizeWithinRoot(resolved);
  const canonRel = relative(canonicalRoot, canonical);
  if (canonRel === '' || canonRel.startsWith('..') || isAbsolute(canonRel)) {
    throw new Error(
      `createMemory: path escapes project root (after resolving symlinks): ` +
        `${canonical} is not within ${canonicalRoot}`,
    );
  }

  // MODE-DIVERGENCE GUARD: the two modes persist to DIFFERENT files for the same
  // logical store — default mode to `<path>` (atomic rewrite), append-log mode to
  // `<path>.log` (NDJSON deltas) — with no cross-mode merge. Opening a path in one
  // mode while the OTHER mode's file already exists silently ignores that data.
  // Warn once at construction so the divergence is observable, not a silent loss.
  const exists = (p) => { try { statSync(p); return true; } catch { return false; } };
  if (appendLog && exists(resolved)) {
    console.warn(
      `createMemory: opened ${resolved} in append-log mode, but a default-mode ` +
        `store exists at ${resolved} — its contents will be IGNORED (modes don't merge).`,
    );
  } else if (!appendLog && exists(logPath)) {
    console.warn(
      `createMemory: opened ${resolved} in default mode, but an append-log store ` +
        `exists at ${logPath} — its contents will be IGNORED (modes don't merge).`,
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

  // ROUND-TRIP PROBE: a non-inverse onRead/onWrite pair silently corrupts the
  // store — onWrite encodes bytes nothing can decode back, so every reload
  // returns {} and the next write erases the data. The contract says onRead MUST
  // be the inverse of onWrite, so when a transform is supplied we ASSERT it here
  // at construction (cheap, one-time) instead of discovering the corruption at
  // the next process start. We probe with a representative JSON sentinel that
  // exercises strings/numbers/arrays/nested objects/unicode. A throwing transform
  // is also a failure (caught and re-reported). Identity transforms (no custom
  // onWrite/onRead) trivially round-trip and need no probe.
  if (typeof transform?.onWrite === 'function' || typeof transform?.onRead === 'function') {
    const sentinel = JSON.stringify({
      __ccpProbe: 'round-trip',
      n: 42,
      list: [1, 2, 3],
      nested: { ok: true, s: 'héllo/\\"☃' },
    });
    let roundTripped;
    try {
      roundTripped = onRead(onWrite(sentinel));
    } catch (err) {
      throw new Error(
        `createMemory: transform onRead(onWrite(x)) threw — onRead must be the ` +
          `inverse of onWrite: ${err?.message ?? err}`,
      );
    }
    if (roundTripped !== sentinel) {
      throw new Error(
        `createMemory: transform is not a round-trip — onRead(onWrite(x)) !== x. ` +
          `onRead must be the exact inverse of onWrite or the store will be ` +
          `silently corrupted on the next reload.`,
      );
    }
  }

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
      // SIZE BOUND (mirrors readFromDisk): refuse to read/parse a log that has
      // grown WITHOUT BOUND. A healthy log is one snapshot checkpoint (store-sized)
      // plus a delta tail appendDelta() keeps under capBytes. The ceiling
      // (LOG_READ_CAP_FACTOR × max(capBytes, MAX_FILE_BYTES); see the constant's
      // header) gives a legitimate snapshot generous absolute room while still
      // capping a runaway log — a stale file from an older unbounded writer or an
      // external appender. Past the ceiling we recover from the base snapshot and
      // let the next mutation recompact to a fresh, bounded checkpoint.
      const st = statSync(logPath); // throws → no log yet → base snapshot only (catch below)
      const logReadCap = LOG_READ_CAP_FACTOR * Math.max(capBytes, MAX_FILE_BYTES);
      if (st.size > logReadCap) {
        console.warn(
          `createMemory: ${logPath} is ${st.size} bytes (> ${logReadCap} log-read ceiling); ` +
            `not replaying it to avoid an unbounded read. Recovering from the base snapshot; ` +
            `the next write will recompact the log to a bounded checkpoint.`,
        );
        return store;
      }
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
      } else if (rec.op === 'set' && isSafeKey(rec.key)) {
        store[rec.key] = rec.value;
      } else if (rec.op === 'del' && isSafeKey(rec.key)) {
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
      const line = onWrite(JSON.stringify(rec)) + '\n';
      const recordBytes = Buffer.byteLength(line, 'utf8');
      // Compact BEFORE appending if THIS record would push the log past the cap —
      // previously the check was `size > capBytes`, which let the log overshoot by
      // one whole record (and a single oversized value bypassed the cap entirely).
      // compactLog() snapshots the live cache (which already reflects this
      // mutation — set() updates cache before persist()), so no data is lost.
      if (size + recordBytes > capBytes) {
        // A single record larger than the whole cap can't be helped by compaction
        // (the snapshot still contains the value) — the log will compact on every
        // subsequent write. Make that observable rather than a silent cap-bypass.
        if (recordBytes > capBytes && host.debug()) {
          console.warn(
            `createMemory: a single delta (${recordBytes}B) exceeds the ${capBytes}B cap — ` +
              `the log will compact on every write for this store`,
          );
        }
        compactLog();
        return;
      }
      appendFileSync(logPath, line, { mode: FILE_MODE, encoding: 'utf8' });
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
      // Durable temp write (fsync data) before the atomic rename, then fsync the
      // directory so the rename survives a crash — same crash-safety contract as
      // writeToDisk (see writeFileDurable's header).
      writeFileDurable(tmp, onWrite(JSON.stringify({ snap: cache })) + '\n');
      renameSync(tmp, logPath);
      fsyncDir(dirname(logPath));
      // Data already landed atomically — tolerate a post-rename chmod failure
      // rather than reporting the write as failed (see writeToDisk).
      try { chmodSync(logPath, FILE_MODE); } catch { /* perms best-effort post-rename */ }
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
        if (host.debug()) {
          console.warn(
            `createMemory: ${resolved} parsed to a non-object (${
              Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed
            }); resetting to empty store.`,
          );
        }
        return {};
      }
      return parsed;
    } catch (err) {
      // DISTINGUISH "missing" FROM "corrupt". Collapsing both to a silent {} is
      // dangerous: a parse/read failure of an EXISTING file looks identical to a
      // fresh start, so the very next write erases the (possibly recoverable)
      // bytes. ENOENT genuinely means "no file yet" → silent {}. Anything else
      // (parse error, decode/onRead throw, EACCES, …) on a file that exists is a
      // corruption signal: quarantine the bad bytes to a sidecar before we lose
      // them, warn UNCONDITIONALLY (not debug-gated), and emit a telemetry event.
      if (err && err.code === 'ENOENT') {
        return {}; // no file yet → empty store, silently (the normal first-run path).
      }
      // Best-effort: only quarantine if the file actually exists (a non-ENOENT
      // error could also be e.g. a transient stat race; statSync guards that).
      let existed = false;
      try {
        statSync(resolved);
        existed = true;
      } catch {
        /* file vanished between read and here → nothing to quarantine */
      }
      // Distinguish genuine corruption (parse/decode failure → no fs errno) from
      // OS-level access or transient errors. A perfectly good file we simply
      // cannot open right now — EACCES/EPERM (wrong uid), EBUSY/EMFILE/ENFILE/
      // EAGAIN (transient), EISDIR/ELOOP (misconfig) — must NOT be quarantined:
      // renaming it aside would be data loss for the real owner, not recovery.
      // Only quarantine when the failure looks like actual corruption.
      const NON_CORRUPT_CODES = new Set([
        'EACCES', 'EPERM', 'EBUSY', 'EMFILE', 'ENFILE', 'EAGAIN', 'EISDIR', 'ELOOP',
      ]);
      const looksCorrupt = !(err && err.code && NON_CORRUPT_CODES.has(err.code));
      if (existed && looksCorrupt) {
        const quarantine = `${resolved}.corrupt-${Date.now()}`;
        try {
          renameSync(resolved, quarantine);
          console.warn(
            `createMemory: ${resolved} is unreadable/corrupt (${err?.message ?? err}); ` +
              `quarantined to ${quarantine} and starting from an empty store.`,
          );
        } catch (qErr) {
          // Couldn't move it aside (perms?). Still warn loudly — the next write
          // may clobber it, but we must not throw out of a load.
          console.warn(
            `createMemory: ${resolved} is unreadable/corrupt (${err?.message ?? err}) ` +
              `and could NOT be quarantined (${qErr?.message ?? qErr}); starting from an empty store.`,
          );
        }
      } else if (existed) {
        // Exists but failed for an access/transient reason — leave it untouched.
        console.warn(
          `createMemory: ${resolved} could not be read (${err?.message ?? err}); ` +
            `leaving it in place (not corruption) and starting from an empty store.`,
        );
      } else {
        console.warn(
          `createMemory: ${resolved} could not be read (${err?.message ?? err}); ` +
            `starting from an empty store.`,
        );
      }
      host.emit('memory.corrupt', { path: resolved });
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
  // CROSS-PROCESS MUTUAL EXCLUSION for the read-merge-write critical section.
  //
  // The merge below has a TOCTOU window: we stat → maybe re-read+merge → rename.
  // A concurrent process whose write lands inside that window (including the
  // brand-new foreign keys the merge promises to preserve) would be silently
  // clobbered, because we re-read the disk state ONCE and then rename over
  // whatever is there at the end. An exclusive lockfile around the whole section
  // serializes writers so each one sees a stable disk state for the duration of
  // its merge.
  //
  // Lock = openSync(path + '.lock', 'wx') (O_CREAT|O_EXCL → fails with EEXIST if
  // it already exists) with the holder's pid written into it. On EEXIST we decide
  // whether to STEAL (only a crashed/dead/ancient holder — never a pid that is
  // still alive within the hard ceiling) or to WAIT: a bounded synchronous retry
  // while a live writer finishes its brief critical section, instead of the old
  // immediate fall-through to an unlocked write (which reopened the very TOCTOU
  // the lock closes). Only if the bounded wait is exhausted do we fall back to a
  // best-effort unlocked write — degraded, but never a hang or a deadlock.
  const lockPath = `${resolved}.lock`;
  // Monotonic per-instance counter so two acquisitions from THIS process (e.g. a
  // re-acquire after a steal) still mint distinct tokens.
  let lockTokenSeq = 0;

  /**
   * Mint a unique ownership token for one acquisition. The token is `pid:nonce`,
   * where `nonce` is per-acquire (counter + random). releaseLock() only removes
   * the lockfile when its on-disk content still equals the token THIS holder
   * wrote — so a writer whose lock was stolen and re-created by someone else can
   * never delete the new owner's lock (release-after-takeover safety).
   */
  function mintLockToken() {
    return `${pid}:${++lockTokenSeq}:${Math.random().toString(36).slice(2)}`;
  }

  /** @returns {string|null} the raw lockfile content (trimmed), or null if unreadable. */
  function readLockRaw() {
    try {
      const s = String(readFileSync(lockPath, 'utf8')).trim();
      return s.length > 0 ? s : null; // empty content → unknown holder.
    } catch {
      return null;
    }
  }

  /** Block the current thread for ~ms WITHOUT async (writeToDisk is synchronous). */
  function sleepSync(ms) {
    try {
      // A real sleep, not a busy spin: Atomics.wait on a throwaway buffer.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
      // SharedArrayBuffer/Atomics unavailable → coarse busy-wait fallback.
      const end = Date.now() + ms;
      while (Date.now() < end) { /* spin */ }
    }
  }

  /** @returns {number|null} the pid recorded in the lockfile, or null if unreadable. */
  function readLockPid() {
    // Content is `pid:nonce` (our token) or a bare pid (legacy lock). Parse the
    // leading integer either way; `parseInt` stops at the ':' for the token form.
    const raw = readLockRaw();
    if (raw === null) return null; // empty/garbage/legacy lock with no pid → unknown holder.
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /** @returns {boolean} true when pid `p` is a live process on THIS host. */
  function isPidAlive(p) {
    try {
      kill(p, 0); // signal 0 = existence probe, sends nothing.
      return true;
    } catch (err) {
      // ESRCH = no such process (dead). EPERM = exists but not ours (alive).
      return !!(err && err.code === 'EPERM');
    }
  }

  /**
   * Remove the existing lock IFF it is safe to steal. A holder whose pid is still
   * ALIVE is mid-critical-section (however slow) and is NEVER stolen — this is the
   * fix for the old mtime-only rule, which would rob a healthy-but-slow writer the
   * instant the lock crossed a short staleness window. We steal only when the
   * holder is provably DEAD (known pid + ESRCH), or ANY lock is older than the
   * HARD ceiling (pid-reuse / hung-writer / never-stamped backstop).
   *
   * UNKNOWN-holder policy: an empty/garbage lock (the pid stamp never landed —
   * ENOSPC/EIO) does NOT identify a dead holder, so it is treated as a LIVE holder
   * and stolen only at the HARD ceiling. Otherwise a stamp that failed to write
   * would let a contender steal a healthy live writer's lock far too soon, putting
   * two writers in the critical section.
   * @returns {boolean} true when the stale lock was removed (caller may re-open).
   */
  function tryStealStaleLock() {
    try {
      const ageMs = Date.now() - statSync(lockPath).mtimeMs;
      const holderPid = readLockPid();
      const alive = holderPid !== null && isPidAlive(holderPid);
      // Past the hard ceiling, ANY lock is stealable (alive-but-ancient ⇒ reused
      // pid / hung writer; unknown holder ⇒ never-stamped crashed writer).
      if (ageMs > LOCK_HARD_STALE_MS) {
        rmSync(lockPath, { force: true });
        return true;
      }
      // Within the hard ceiling: a KNOWN-DEAD holder (pid stamped + ESRCH) is
      // provably crashed and stolen immediately, regardless of mtime. A live
      // holder, or an UNKNOWN holder (empty/unstamped content), is respected here
      // and only stolen at the hard ceiling above — the unknown case is treated as
      // live, NOT soft-stealable, so a stamp that failed to write (ENOSPC/EIO)
      // can't be mistaken for a dead holder and stolen too soon.
      const dead = holderPid !== null && !alive;
      if (dead) {
        rmSync(lockPath, { force: true });
        return true;
      }
    } catch {
      /* stat/read/rm race lost to another writer → treat as not stealable */
    }
    return false;
  }

  /**
   * @returns {{ fd: number, token: string }|null} the held-lock handle (open fd +
   * the unique ownership token we stamped), or null if the lock was not acquired.
   */
  function acquireLock() {
    for (let attempt = 0; ; attempt++) {
      try {
        const fd = openSync(lockPath, 'wx', FILE_MODE);
        // Stamp a UNIQUE ownership token (pid + per-acquire nonce). The pid lets a
        // later writer tell a live holder from a crashed one; the nonce lets US
        // verify on release that the lock we're about to delete is STILL the one we
        // created (not a successor's after a steal). If this write fails the lock
        // has empty content — treated as an unknown/live holder until the hard
        // ceiling (see tryStealStaleLock), NOT soft-stealable.
        const token = mintLockToken();
        try { writeSync(fd, token); } catch { /* best-effort stamp; empty ⇒ unknown holder */ }
        return { fd, token };
      } catch (err) {
        if (!err || err.code !== 'EEXIST') return null; // unexpected → no lock.
        // Lock is held. If it's safe to steal (crashed/dead/ancient holder),
        // remove it and retry the open immediately.
        if (tryStealStaleLock()) continue;
        // Held by a LIVE writer: wait a bounded interval and retry rather than
        // falling back to an unlocked write. Exhausting the budget degrades to the
        // prior best-effort unlocked write (never a deadlock).
        if (attempt < LOCK_RETRY_ATTEMPTS) {
          sleepSync(LOCK_RETRY_MS);
          continue;
        }
        return null;
      }
    }
  }

  /**
   * Release the lock: close the fd and remove the lockfile — but ONLY if the
   * on-disk content still matches the token WE wrote. If it differs, our lock was
   * stolen (soft fuse / hard ceiling) and re-created by another process that now
   * owns it; deleting it by path would drop a lock another writer holds, putting
   * two writers in the critical section. In that case we skip the rmSync and leave
   * the new owner's lock intact. Fully fail-open: any error in the ownership
   * re-check is swallowed and never thrown out of releaseLock.
   * @param {{ fd: number, token: string }} handle
   */
  function releaseLock(handle) {
    const { fd, token } = handle;
    try { closeSync(fd); } catch { /* ignore */ }
    try {
      // Only delete the lockfile if it still carries OUR token. A token mismatch
      // (or an empty/unstamped lock — which we never deliberately re-create) means
      // someone else owns it now: leave it untouched.
      if (readLockRaw() === token) {
        rmSync(lockPath, { force: true });
      }
    } catch { /* ownership re-check / rm race lost → fail open, never throw */ }
  }

  function writeToDisk() {
    mkdirSync(dirname(resolved), { recursive: true });

    // Acquire the cross-process lock for the read-merge-write critical section.
    // If we can't get it (a healthy concurrent writer holds it), fall back to an
    // unlocked best-effort write — we log the contention but never hang/throw.
    const lockHandle = acquireLock();
    if (lockHandle === null) {
      host.emit('memory.lock.contended', { path: resolved });
    }
    try {
      writeToDiskLocked();
    } finally {
      if (lockHandle !== null) releaseLock(lockHandle);
    }
  }

  // The actual read-merge-write body. Runs under the lockfile when one could be
  // acquired (the common case); otherwise it still runs (best-effort) so a write
  // is never simply dropped.
  function writeToDiskLocked() {
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
              if (isSafeKey(k) && !knownKeys.has(k)) merged[k] = diskRaw[k];
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
      // (identity by default → plaintext JSON). writeFileDurable fsyncs the temp
      // file's data to stable storage BEFORE we rename it over the target, so a
      // crash can't leave a renamed-but-empty/garbage file (atomicity alone does
      // not give durability — see writeFileDurable's header).
      writeFileDurable(tmp, onWrite(JSON.stringify(cache, null, 2)));
      renameSync(tmp, resolved);
      // fsync the directory so the rename itself is durable across a crash.
      fsyncDir(dirname(resolved));
      // Defensive: ensure the live file is 0600 regardless of any prior perms.
      // The data has ALREADY landed atomically (rename succeeded); a chmod failure
      // (e.g. EPERM on a foreign-owned file) must NOT report the write as failed
      // and trigger tmp cleanup of an already-renamed file. Tolerate it (the temp
      // was created 0600, so the new inode is already owner-only).
      try { chmodSync(resolved, FILE_MODE); } catch { /* perms best-effort post-rename */ }
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
      // Reject keys that would mutate the cache object's internals (prototype
      // pollution) instead of storing data — see UNSAFE_KEYS.
      if (!isSafeKey(key)) {
        throw new TypeError(`createMemory.set: refusing unsafe key "${key}" (reserved/prototype key).`);
      }
      // Validate JSON-serializability SYNCHRONOUSLY, at the call site. The actual
      // persist happens later (debounced rewrite / append delta) where it
      // serializes the WHOLE cache — so a non-serializable value (cycle, BigInt,
      // throwing toJSON) there would not just drop THIS write but throw on every
      // subsequent flush too, silently poisoning the entire store for the life of
      // the instance with only a background console.warn. Fail loud here instead.
      try {
        JSON.stringify(value);
      } catch (err) {
        throw new TypeError(
          `createMemory.set("${key}"): value is not JSON-serializable (${err?.message ?? err}); refusing to store it.`,
        );
      }
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
