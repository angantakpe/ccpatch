/**
 * adk-memory.test.mjs
 *
 * Unit coverage for the ADK key/value memory store (packages/adk/memory.mjs):
 *   - in-memory write-through cache: get/keys/snapshot never re-read the file
 *     after the first lazy load (we mutate the file underneath and prove the
 *     cache is authoritative)
 *   - path sandbox: reject '..' traversal and absolute paths outside the project
 *     root; accept an in-root relative path
 *   - size bound: a file larger than the 5 MB cap is ignored (empty store)
 *   - flush(): force the debounced write to land, awaitable; persisted JSON
 *     round-trips
 *
 * Real fs, scoped to a temp dir UNDER the project root (the sandbox demands the
 * resolved path stay within cwd()). Each test cleans up its own files.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  statSync,
  readdirSync,
  utimesSync,
  symlinkSync,
  realpathSync,
  openSync,
  closeSync,
  writeSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { cwd, platform, execPath } from 'node:process';
import { spawn } from 'node:child_process';

import { createMemory } from '../memory.mjs';

// A scratch dir UNDER the project root so the path sandbox accepts it.
const SCRATCH_ROOT = join(cwd(), '.tmp-adk-memory-tests');

function freshDir() {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(SCRATCH_ROOT, 'mem-'));
}

// Clean the scratch tree both after the suite AND on process exit. The memory
// store registers a synchronous 'exit' flush for any DIRTY cache, which can
// re-create files AFTER test.after() runs — so the exit hook (LIFO, registered
// last here) gets the final say and removes the tree once those flushes land.
function nukeScratch() {
  try { rmSync(SCRATCH_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}
test.after(nukeScratch);
process.on('exit', nukeScratch);

// ── in-memory cache: no re-read after first load ──────────────────────────────

test('memory get/keys/snapshot read from cache and never re-read the file', () => {
  const dir = freshDir();
  const file = join(dir, 'store.json');
  writeFileSync(file, JSON.stringify({ a: 1 }), 'utf8');

  const mem = createMemory({ path: file });
  assert.equal(mem.get('a'), 1, 'first access lazily loads from disk');

  // Mutate the file underneath. A cache-backed store must NOT see this.
  writeFileSync(file, JSON.stringify({ a: 999, b: 2 }), 'utf8');

  assert.equal(mem.get('a'), 1, 'get() served from cache, ignores the on-disk change');
  assert.equal(mem.get('b'), undefined, 'key added on disk is invisible to the cache');
  assert.deepEqual(mem.keys(), ['a'], 'keys() reflects the cached store only');
  assert.deepEqual(mem.snapshot(), { a: 1 }, 'snapshot() is a copy of the cached store');

  // snapshot() must be an isolated COPY — mutating it cannot corrupt the cache.
  const snap = mem.snapshot();
  snap.a = 'tampered';
  assert.equal(mem.get('a'), 1, 'mutating the snapshot does not touch the cache');
});

test('memory set/delete/clear mutate the cache immediately (read-your-writes)', async () => {
  const dir = freshDir();
  const mem = createMemory({ path: join(dir, 's.json') });
  mem.set('x', 10);
  assert.equal(mem.get('x'), 10);
  mem.set('y', 20);
  assert.deepEqual(mem.keys().sort(), ['x', 'y']);
  mem.delete('x');
  assert.equal(mem.get('x'), undefined);
  assert.deepEqual(mem.keys(), ['y']);
  mem.clear();
  assert.deepEqual(mem.keys(), []);
  // Flush so the store is CLEAN at exit — otherwise its synchronous 'exit' flush
  // re-creates the file under the scratch dir after test.after() removed it.
  await mem.flush();
});

// ── path sandbox ──────────────────────────────────────────────────────────────

test('memory rejects a path that traverses out of the project root', () => {
  assert.throws(
    () => createMemory({ path: join(cwd(), '..', 'escape.json') }),
    /path escapes project root/,
  );
  assert.throws(
    () => createMemory({ path: '../../etc/passwd' }),
    /path escapes project root/,
  );
});

test('memory rejects an absolute path outside the project root', () => {
  assert.throws(
    () => createMemory({ path: '/tmp/adk-outside.json' }),
    /path escapes project root/,
  );
});

test('memory rejects the project root itself (empty relative)', () => {
  assert.throws(
    () => createMemory({ path: cwd() }),
    /path escapes project root/,
  );
});

test('memory accepts an in-root relative path', () => {
  const dir = freshDir();
  const rel = relative(cwd(), join(dir, 'ok.json'));
  assert.doesNotThrow(() => createMemory({ path: rel }));
});

// ── size bound ────────────────────────────────────────────────────────────────

test('memory ignores a file larger than the 5 MB cap (empty store, no throw)', () => {
  const dir = freshDir();
  const file = join(dir, 'big.json');
  // Write valid JSON whose byte length exceeds 5 MB. A 6 MB string value does it.
  const huge = JSON.stringify({ blob: 'x'.repeat(6 * 1024 * 1024) });
  writeFileSync(file, huge, 'utf8');

  const realWarn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  try {
    const mem = createMemory({ path: file });
    assert.deepEqual(mem.snapshot(), {}, 'oversized file → empty store');
    assert.ok(
      warnings.some((w) => /> .* cap|bytes/.test(w)),
      'warned about the oversize cap',
    );
  } finally {
    console.warn = realWarn;
  }
});

test('memory tolerates a corrupt file as an empty store (and quarantines it)', () => {
  const dir = freshDir();
  const file = join(dir, 'corrupt.json');
  writeFileSync(file, '{ not valid json', 'utf8');

  // The load now warns UNCONDITIONALLY (not debug-gated) about the corruption and
  // moves the bad bytes aside to a .corrupt-* sidecar so the next write can't
  // silently erase them. Capture warn to assert the message lands.
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  let mem;
  try {
    mem = createMemory({ path: file });
    assert.deepEqual(mem.snapshot(), {}, 'unparseable file → empty store');
  } finally {
    console.warn = realWarn;
  }

  assert.ok(
    warnings.some((w) => /corrupt|unreadable/i.test(w)),
    'warned loudly about the corrupt file',
  );
  // The corrupt original was renamed aside to a sidecar (so it's not clobbered).
  const sidecars = readdirSync(dir).filter((n) => n.startsWith('corrupt.json.corrupt-'));
  assert.equal(sidecars.length, 1, 'corrupt file quarantined to a .corrupt-* sidecar');
  assert.equal(
    readFileSync(join(dir, sidecars[0]), 'utf8'),
    '{ not valid json',
    'quarantined sidecar preserves the original bad bytes',
  );
  // The live path was vacated by the quarantine rename (until the next write).
  assert.equal(existsSync(file), false, 'corrupt original moved off the live path');
});

test('a MISSING file loads as an empty store with NO warn and NO sidecar', () => {
  // ENOENT must stay the silent first-run path — distinct from corruption.
  const dir = freshDir();
  const file = join(dir, 'never-existed.json');

  const realWarn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  try {
    const mem = createMemory({ path: file });
    assert.deepEqual(mem.snapshot(), {}, 'missing file → empty store');
  } finally {
    console.warn = realWarn;
  }
  assert.deepEqual(warnings, [], 'a missing file is silent (no corruption warning)');
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.includes('.corrupt-')),
    [],
    'no quarantine sidecar for a missing file',
  );
});

test('memory.corrupt event is emitted on a corrupt load', () => {
  const dir = freshDir();
  const file = join(dir, 'corrupt-evt.json');
  writeFileSync(file, 'not json at all', 'utf8');

  // Stub the host event bus (host.emit reads globalThis.__ccpBus live on each call).
  const events = [];
  const prevBus = globalThis.__ccpBus;
  globalThis.__ccpBus = { emit: (topic, payload) => events.push({ topic, payload }) };
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    // Load is lazy — touch the store to trigger readFromDisk (and the emit).
    createMemory({ path: file }).snapshot();
  } finally {
    console.warn = realWarn;
    globalThis.__ccpBus = prevBus;
  }
  const corrupt = events.find((e) => e.topic === 'memory.corrupt');
  assert.ok(corrupt, "emitted a 'memory.corrupt' event");
  assert.equal(corrupt.payload.path, file, 'event carries the offending path');
});

// ── flush() ───────────────────────────────────────────────────────────────────

test('flush() forces the debounced write to land and round-trips through JSON', async () => {
  const dir = freshDir();
  const file = join(dir, 'persist.json');
  const mem = createMemory({ path: file });

  mem.set('alpha', { nested: [1, 2, 3] });
  mem.set('beta', 'hi');
  // Write is debounced (~100ms) — the file may not exist yet. flush() makes it land.
  await mem.flush();

  assert.ok(existsSync(file), 'flush() created/persisted the file');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk, { alpha: { nested: [1, 2, 3] }, beta: 'hi' });

  // A second store reading the same file sees the persisted state.
  const mem2 = createMemory({ path: file });
  assert.deepEqual(mem2.snapshot(), { alpha: { nested: [1, 2, 3] }, beta: 'hi' });
});

test('flush() on a clean store is a no-op (no throw, file may be absent)', async () => {
  const dir = freshDir();
  const file = join(dir, 'clean.json');
  const mem = createMemory({ path: file });
  await assert.doesNotReject(() => mem.flush());
  // Nothing was set → nothing written.
  assert.equal(existsSync(file), false, 'clean flush writes nothing');
});

test('flush() coalesces rapid writes last-write-wins', async () => {
  const dir = freshDir();
  const file = join(dir, 'coalesce.json');
  const mem = createMemory({ path: file });
  mem.set('k', 1);
  mem.set('k', 2);
  mem.set('k', 3);
  await mem.flush();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { k: 3 }, 'last write wins on disk');
});

// ── 0600 file mode + atomic write ─────────────────────────────────────────────

test('persisted file is created mode 0600 (owner-only)', { skip: platform === 'win32' }, async () => {
  // POSIX-only: Windows does not honour Unix permission bits.
  const dir = freshDir();
  const file = join(dir, 'perms.json');
  const mem = createMemory({ path: file });
  mem.set('secret', 'hunter2');
  await mem.flush();

  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, 'persisted store is rw------- (no group/other access)');
});

test('overwriting an existing store re-tightens perms to 0600', { skip: platform === 'win32' }, async () => {
  // Even if a pre-existing target had looser perms, a rewrite must end up 0600.
  const dir = freshDir();
  const file = join(dir, 'loose.json');
  writeFileSync(file, JSON.stringify({ old: true }), { mode: 0o644 });
  assert.equal(statSync(file).mode & 0o777, 0o644, 'precondition: file starts world-readable');

  const mem = createMemory({ path: file });
  mem.set('new', 1);
  await mem.flush();
  assert.equal(statSync(file).mode & 0o777, 0o600, 'rewrite tightened perms to 0600');
});

test('atomic write leaves no leftover .tmp sibling', async () => {
  const dir = freshDir();
  const file = join(dir, 'atomic.json');
  const mem = createMemory({ path: file });
  mem.set('a', 1);
  await mem.flush();
  mem.set('b', 2); // a second rewrite, another temp+rename cycle
  await mem.flush();

  const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'no .tmp files remain after atomic temp+rename writes');
  // And the final file is the fully-merged JSON, never a half-written fragment.
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 1, b: 2 });
});

// ── deep-clone snapshot isolation ─────────────────────────────────────────────

test('snapshot() is a DEEP copy: mutating nested values does not leak into the store', () => {
  const dir = freshDir();
  const mem = createMemory({ path: join(dir, 'deep.json') });
  mem.set('cfg', { nested: { count: 1 }, list: [1, 2, 3] });

  const snap = mem.snapshot();
  // Mutate nested object AND nested array on the snapshot.
  snap.cfg.nested.count = 999;
  snap.cfg.list.push(4);
  snap.cfg.added = 'tampered';

  // The live store must be untouched at every level of nesting.
  assert.deepEqual(
    mem.get('cfg'),
    { nested: { count: 1 }, list: [1, 2, 3] },
    'nested mutation of the snapshot did not leak into the live store',
  );
  // Two snapshots are independent of each other too.
  const snap2 = mem.snapshot();
  assert.notEqual(snap2.cfg, snap.cfg, 'each snapshot deep-clones afresh');
});

// ── dispose(): exit-listener registry does not grow ───────────────────────────

test('createMemory() does not register a per-instance process exit listener', () => {
  // Many instances must NOT each add an 'exit' listener — the module installs a
  // single shared one. dispose() detaches an instance from the shared registry.
  const dir = freshDir();
  const before = process.listenerCount('exit');

  const mems = [];
  for (let i = 0; i < 50; i++) {
    mems.push(createMemory({ path: join(dir, `m-${i}.json`) }));
  }
  const after = process.listenerCount('exit');
  // At most ONE new 'exit' listener regardless of instance count.
  assert.ok(after - before <= 1, `exit listeners grew by ${after - before} across 50 instances`);

  // dispose() every instance; the shared listener count must not change.
  for (const m of mems) m.dispose();
  assert.equal(
    process.listenerCount('exit'),
    after,
    'dispose() does not add/remove the shared exit listener',
  );
});

test('dispose() cancels the pending debounce timer and is idempotent', async () => {
  const dir = freshDir();
  const file = join(dir, 'disposed.json');
  const mem = createMemory({ path: file });
  mem.set('x', 1); // arms the debounce timer (write is pending, file absent)
  assert.equal(existsSync(file), false, 'write is still debounced');

  mem.dispose(); // cancels the pending timer; does NOT flush
  mem.dispose(); // idempotent: second call is a harmless no-op

  // Give the (now-cancelled) debounce window (~100ms) time to have fired, had it survived.
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(existsSync(file), false, 'dispose() cancelled the pending write');

  // The instance still works post-dispose; explicit flush() persists on demand.
  mem.set('x', 2);
  await mem.flush();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { x: 2 });
});

// ── memoized snapshot clone ───────────────────────────────────────────────────

test('snapshot() memoizes the deep clone and invalidates it on writes', async () => {
  const dir = freshDir();
  const file = join(dir, 'memo.json');
  const mem = createMemory({ path: file });
  mem.set('a', { n: 1 });

  // A mutation to a returned snapshot must NOT bleed into a later snapshot —
  // each snapshot() returns an independent deep copy even when memoized.
  const s1 = mem.snapshot();
  s1.a.n = 999;
  s1.extra = 'tampered';
  const s2 = mem.snapshot();
  assert.deepEqual(s2, { a: { n: 1 } }, 'mutating a snapshot does not affect a later snapshot');
  assert.notEqual(s2.a, s1.a, 'each snapshot deep-clones afresh (no shared nested refs)');
  assert.deepEqual(mem.get('a'), { n: 1 }, 'the live store is untouched by snapshot mutation');

  // A write BETWEEN two snapshots must be reflected (memo invalidated on set()).
  mem.set('b', 2);
  assert.deepEqual(mem.snapshot(), { a: { n: 1 }, b: 2 }, 'write between snapshots is reflected');

  // delete() and clear() must invalidate the memo too.
  mem.delete('a');
  assert.deepEqual(mem.snapshot(), { b: 2 }, 'delete invalidates the memoized snapshot');
  mem.clear();
  assert.deepEqual(mem.snapshot(), {}, 'clear invalidates the memoized snapshot');

  await mem.flush();
});

// ── hard coalesce cap ─────────────────────────────────────────────────────────

test('continuous set() churn cannot starve the flush beyond the 1s hard cap', async () => {
  const dir = freshDir();
  const file = join(dir, 'churn.json');
  const mem = createMemory({ path: file });

  // Hammer set() faster than the 100ms debounce so the timer keeps re-arming and
  // would, without a hard cap, never fire. We drive wall-clock past MAX_COALESCE_MS
  // (1s) by busy-spinning small sleeps between sets; once the oldest dirty
  // mutation is >=1s old, the NEXT set() must flush synchronously.
  const start = Date.now();
  let n = 0;
  while (Date.now() - start < 1300) {
    mem.set('k', n++);
    // Re-arm the debounce well before it (100ms) can fire on its own.
    await new Promise((r) => setTimeout(r, 30));
  }

  // The file must exist even though we never let the 100ms debounce mature and
  // never called flush() — the hard cap forced at least one write mid-churn.
  assert.ok(existsSync(file), 'hard coalesce cap forced a write despite continuous churn');
  await mem.flush();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).k, n - 1, 'final value persisted');
});

// ── shape validation on load ──────────────────────────────────────────────────

test('a parseable-but-non-object file (array/primitive) resets to an empty store', () => {
  const dir = freshDir();

  for (const bad of ['[1,2,3]', '42', '"hi"', 'true', 'null']) {
    const file = join(dir, `shape-${bad.replace(/[^a-z0-9]/gi, '_')}.json`);
    writeFileSync(file, bad, 'utf8');
    const mem = createMemory({ path: file });
    assert.deepEqual(
      mem.snapshot(),
      {},
      `parseable non-object (${bad}) must not become the store`,
    );
    // The store must still be usable as a plain object after the reset.
    mem.set('ok', 1);
    assert.equal(mem.get('ok'), 1);
  }
});

// ── cross-process lost-write safety ───────────────────────────────────────────

test('an external write between load and flush is merged, not clobbered', async () => {
  const dir = freshDir();
  const file = join(dir, 'concurrent.json');
  // Initial on-disk state.
  writeFileSync(file, JSON.stringify({ shared: 'v0', ours: 'old' }, null, 2), 'utf8');

  const mem = createMemory({ path: file });
  assert.equal(mem.get('shared'), 'v0', 'loaded initial state');

  // We dirty our own key in-memory (debounced, not yet on disk).
  mem.set('ours', 'new');

  // Simulate ANOTHER process writing the file after we loaded it: it adds a key
  // we never touched AND changes `shared`. Bump mtime to the future so our
  // writeToDisk() detects the concurrent change.
  writeFileSync(
    file,
    JSON.stringify({ shared: 'v0', theirs: 'external', ours: 'theirOld' }, null, 2),
    'utf8',
  );
  const future = Date.now() / 1000 + 60;
  utimesSync(file, future, future);

  await mem.flush();

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  // Our dirty key wins (last-write-wins per dirty key)...
  assert.equal(onDisk.ours, 'new', 'our dirty key overwrites the disk value');
  // ...the other process's brand-new key is preserved (not dropped)...
  assert.equal(onDisk.theirs, 'external', "another process's key is not dropped");
  // ...and a key we never touched keeps the fresher disk value.
  assert.equal(onDisk.shared, 'v0', 'untouched key retains the concurrent disk value');
});

// ── concurrent write + local clear() merge semantics ──────────────────────────

test('local clear() drops keys we knew but preserves a concurrent writer\'s foreign keys', async () => {
  const dir = freshDir();
  const file = join(dir, 'clear-merge.json');
  // Initial on-disk state this instance will load (and thus "know about").
  writeFileSync(file, JSON.stringify({ ours: 'v0', alsoOurs: 'v0' }, null, 2), 'utf8');

  const mem = createMemory({ path: file });
  assert.equal(mem.get('ours'), 'v0', 'loaded initial state (these keys are now known)');

  // Locally wipe the store, then re-set one key after the clear.
  mem.clear();
  mem.set('reborn', 'fresh'); // a post-clear re-set: must survive the merge

  // Simulate ANOTHER process writing the file after we loaded it: it both
  // re-creates a key WE knew about (`ours`) and introduces a brand-new foreign
  // key (`theirs`) we never saw. Bump mtime so writeToDisk() merges.
  writeFileSync(
    file,
    JSON.stringify({ ours: 'theirValue', theirs: 'external' }, null, 2),
    'utf8',
  );
  const future = Date.now() / 1000 + 60;
  utimesSync(file, future, future);

  await mem.flush();

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  // A genuinely foreign key the concurrent writer introduced survives our clear.
  assert.equal(onDisk.theirs, 'external', "a concurrent writer's foreign key survives our clear()");
  // Our post-clear re-set lands.
  assert.equal(onDisk.reborn, 'fresh', 'a post-clear set() is persisted');
  // A key we KNEW about is dropped even though the concurrent writer re-created
  // it under the same name — we cannot tell their fresh key from the one we
  // intended to wipe, and we resolve that ambiguity in favour of the local clear.
  assert.ok(!('ours' in onDisk), 'a known key is wiped despite a concurrent same-name write');
  assert.ok(!('alsoOurs' in onDisk), 'every key we knew about is wiped by the clear');
});

test("local clear() emits 'memory.clear.conflict' carrying the dropped key on a concurrent same-name write", async () => {
  const dir = freshDir();
  const file = join(dir, 'clear-conflict.json');
  // Initial on-disk state this instance loads (and thus "knows about").
  writeFileSync(file, JSON.stringify({ ours: 'v0', alsoOurs: 'v0' }, null, 2), 'utf8');

  const mem = createMemory({ path: file });
  assert.equal(mem.get('ours'), 'v0', 'loaded initial state (these keys are now known)');

  mem.clear();
  mem.set('reborn', 'fresh'); // a post-clear re-set: NOT a dropped foreign write.

  // A concurrent process re-creates `ours` (a name we knew, so the clear drops
  // it) and adds a brand-new foreign key `theirs` (survives the clear). Bump
  // mtime so writeToDisk() takes the merge path.
  writeFileSync(
    file,
    JSON.stringify({ ours: 'theirValue', theirs: 'external' }, null, 2),
    'utf8',
  );
  const future = Date.now() / 1000 + 60;
  utimesSync(file, future, future);

  // Stub the host event bus (host.emit reads globalThis.__ccpBus live per call).
  const events = [];
  const prevBus = globalThis.__ccpBus;
  globalThis.__ccpBus = { emit: (topic, payload) => events.push({ topic, payload }) };
  try {
    await mem.flush();
  } finally {
    globalThis.__ccpBus = prevBus;
  }

  // The conflict is surfaced (not silently dropped) and names the dropped key.
  const conflicts = events.filter((e) => e.topic === 'memory.clear.conflict');
  const droppedKeys = conflicts.map((e) => e.payload?.key);
  assert.ok(
    droppedKeys.includes('ours'),
    "emitted 'memory.clear.conflict' carrying the dropped key 'ours'",
  );
  assert.ok(
    conflicts.every((e) => e.payload?.path === file),
    'every conflict event carries the store path',
  );
  // A foreign key the writer introduced is NOT a conflict (it survives the clear).
  assert.ok(!droppedKeys.includes('theirs'), 'a surviving foreign key is not reported as a conflict');
  // A post-clear re-set of a known name is NOT a dropped write (it lands), so it
  // must not be reported as a conflict.
  assert.ok(!droppedKeys.includes('reborn'), 'a post-clear re-set() is not reported as a conflict');

  // Drop semantics are unchanged: the known key is still wiped on disk.
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(!('ours' in onDisk), 'drop semantics preserved: the known key is still wiped');
  assert.equal(onDisk.theirs, 'external', 'the foreign key still survives');
  assert.equal(onDisk.reborn, 'fresh', 'the post-clear set() still lands');
});

// ── optional encryption/redaction transform hook ──────────────────────────────

test('transform { onWrite, onRead } round-trips through disk (base64)', async () => {
  const dir = freshDir();
  const file = join(dir, 'transformed.json');

  // Trivial reversible transform: base64 on the way out, decode on the way in.
  const transform = {
    onWrite: (s) => Buffer.from(s, 'utf8').toString('base64'),
    onRead: (s) => Buffer.from(s, 'base64').toString('utf8'),
  };

  const mem = createMemory({ path: file, transform });
  mem.set('secret', { token: 'hunter2', list: [1, 2, 3] });
  await mem.flush();

  // The raw on-disk bytes must NOT be plaintext JSON — they are base64.
  const raw = readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /hunter2/, 'on-disk bytes are encoded, not plaintext');
  assert.equal(
    Buffer.from(raw, 'base64').toString('utf8').includes('hunter2'),
    true,
    'decoding the on-disk bytes recovers the JSON',
  );

  // A second store with the SAME transform reads it back transparently.
  const mem2 = createMemory({ path: file, transform });
  assert.deepEqual(mem2.snapshot(), { secret: { token: 'hunter2', list: [1, 2, 3] } });

  // Default (no transform) is plaintext / backward compatible.
  const plainFile = join(dir, 'plain.json');
  const plain = createMemory({ path: plainFile });
  plain.set('k', 'v');
  await plain.flush();
  assert.match(readFileSync(plainFile, 'utf8'), /"k": "v"/, 'no transform → plaintext JSON');
});

// ── append-log (delta) mode ───────────────────────────────────────────────────

test('appendLog mode persists deltas to <path>.log and replays them on reload', async () => {
  const dir = freshDir();
  const file = join(dir, 'store.json');
  const m1 = createMemory({ path: file, appendLog: true });
  m1.set('a', 1);
  m1.set('b', 2);
  m1.delete('a');
  // Deltas are written synchronously on each mutation (no debounce in this mode).
  assert.ok(existsSync(`${file}.log`), 'delta log file is created');

  // A fresh instance reconstructs the store by replaying the log.
  const m2 = createMemory({ path: file, appendLog: true });
  assert.equal(m2.get('a'), undefined, 'deleted key not replayed');
  assert.equal(m2.get('b'), 2, 'surviving key replayed');
  assert.deepEqual(m2.keys().sort(), ['b']);
});

test('appendLog clear() is replayed (store empty after reload)', async () => {
  const dir = freshDir();
  const file = join(dir, 'store.json');
  const m1 = createMemory({ path: file, appendLog: true });
  m1.set('x', 'y');
  m1.clear();
  m1.set('z', 1);
  const m2 = createMemory({ path: file, appendLog: true });
  assert.deepEqual(m2.keys(), ['z'], 'clear wiped pre-clear keys; post-clear set survives');
});

test('appendLog compacts the log once it outgrows maxBytes (replay stays correct)', async () => {
  const dir = freshDir();
  const file = join(dir, 'store.json');
  // Tiny cap so a handful of deltas trips compaction.
  const m1 = createMemory({ path: file, appendLog: true, maxBytes: 200 });
  for (let i = 0; i < 50; i++) m1.set(`k${i}`, 'x'.repeat(20));
  // After compaction the log holds a single {snap:…} checkpoint instead of 50
  // separate delta lines (the checkpoint is one JSON object on one line).
  const logText = readFileSync(`${file}.log`, 'utf8');
  const lines = logText.split('\n').filter((l) => l.trim());
  assert.ok(lines.length < 50, `compaction collapsed 50 deltas into ${lines.length} line(s)`);
  assert.ok(lines.some((l) => l.includes('"snap"')), 'compacted log contains a snapshot checkpoint');

  const m2 = createMemory({ path: file, appendLog: true, maxBytes: 200 });
  assert.equal(m2.keys().length, 50, 'all keys survive compaction + replay');
  assert.equal(m2.get('k49'), 'x'.repeat(20));
});

test('maxBytes override raises the default-mode cap (no silent data loss)', async () => {
  const dir = freshDir();
  const file = join(dir, 'store.json');
  const m1 = createMemory({ path: file });
  m1.set('big', 'a'.repeat(1000));
  await m1.flush();
  // Reload with a generous cap — contents must load, not be ignored.
  const m2 = createMemory({ path: file, maxBytes: 10 * 1024 * 1024 });
  assert.equal(m2.get('big'), 'a'.repeat(1000));
});

// ── path sandbox: symlink escape (canonical check) ────────────────────────────

test('memory rejects a path whose ancestor dir is a symlink escaping the root', { skip: platform === 'win32' }, () => {
  // The lexical sandbox compares STRINGS and is blind to symlinks. Build a path
  // that passes the lexical check (it lives, textually, under cwd) but whose
  // parent directory is a symlink pointing OUTSIDE the project root. The canonical
  // (realpath) check must catch the escape.
  const dir = freshDir();

  // A real directory OUTSIDE the project root.
  const outside = mkdtempSync(join(tmpdir(), 'adk-escape-'));
  try {
    // A symlink UNDER cwd that points to the outside dir.
    const linkPath = join(dir, 'sneaky-link');
    symlinkSync(outside, linkPath, 'dir');

    // Target file sits "under" the symlink → lexically inside cwd, really outside.
    const escapingPath = join(linkPath, 'store.json');
    assert.throws(
      () => createMemory({ path: escapingPath }),
      /escapes project root .*after resolving symlinks/,
      'a symlinked ancestor escaping the root is rejected by the canonical check',
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('memory still accepts a legitimate in-root path whose tail does not exist yet', () => {
  // The canonical check must not over-reject: the target file (and even nested
  // parent dirs) may not exist yet — they are created lazily on first flush. Only
  // the deepest EXISTING ancestor is canonicalized.
  const dir = freshDir();
  const deep = join(dir, 'does', 'not', 'exist', 'yet', 'store.json');
  assert.doesNotThrow(() => createMemory({ path: deep }));
});

// ── durability: fsync before rename + dir fsync (functional smoke) ────────────

test('writeToDisk fsync path persists correctly (round-trips, no leftover tmp/lock)', async () => {
  // We can't induce a real power-loss in a unit test, but we can prove the new
  // openSync→writeSync→fsyncSync→closeSync→rename→dir-fsync sequence still produces
  // a correct, fully-written file and cleans up its temp + lock artifacts.
  const dir = freshDir();
  const file = join(dir, 'durable.json');
  const mem = createMemory({ path: file });
  mem.set('a', { nested: [1, 2, 3] });
  mem.set('b', 'hi');
  await mem.flush();

  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: { nested: [1, 2, 3] }, b: 'hi' });
  const leftovers = readdirSync(dir).filter((n) => n.endsWith('.tmp') || n.endsWith('.lock'));
  assert.deepEqual(leftovers, [], 'no leftover .tmp or .lock artifacts after a durable write');
});

// ── cross-process lock: stale lock is stolen; held lock falls back ────────────

test('writeToDisk steals a STALE lockfile and completes the write', async () => {
  const dir = freshDir();
  const file = join(dir, 'stale-lock.json');
  // Pre-create the store + a STALE lockfile (mtime far in the past).
  const mem = createMemory({ path: file });
  mem.set('seed', 0);
  await mem.flush();

  const lockPath = `${file}.lock`;
  const fd = openSync(lockPath, 'w');
  closeSync(fd);
  const past = Date.now() / 1000 - 3600; // 1h ago → well past the 10s stale window.
  utimesSync(lockPath, past, past);

  // A new write must detect the stale lock, steal it, and land the value.
  mem.set('after', 'stale');
  await mem.flush();

  assert.equal(JSON.parse(readFileSync(file, 'utf8')).after, 'stale', 'write completed after stealing stale lock');
  assert.equal(existsSync(lockPath), false, 'lockfile released after the write');
});

test('writeToDisk falls back (no hang/throw) and emits memory.lock.contended when a FRESH lock is held', async () => {
  const dir = freshDir();
  const file = join(dir, 'held-lock.json');
  const mem = createMemory({ path: file });
  mem.set('x', 1);
  await mem.flush();

  // Hold a FRESH (non-stale) lock to simulate a healthy concurrent writer.
  const lockPath = `${file}.lock`;
  const heldFd = openSync(lockPath, 'w'); // fresh mtime = now.

  const events = [];
  const prevBus = globalThis.__ccpBus;
  globalThis.__ccpBus = { emit: (topic, payload) => events.push({ topic, payload }) };
  try {
    mem.set('x', 2);
    // Must NOT hang or throw despite the contended lock — best-effort write lands.
    await mem.flush();
  } finally {
    globalThis.__ccpBus = prevBus;
    try { closeSync(heldFd); } catch { /* ignore */ }
    rmSync(lockPath, { force: true });
  }

  assert.ok(
    events.some((e) => e.topic === 'memory.lock.contended'),
    "emitted 'memory.lock.contended' when the lock could not be acquired",
  );
  // The fallback write still persisted our value (degraded, but never dropped).
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).x, 2, 'fallback write still persisted the value');
});

// ── cross-process lock: live-contention + pid-liveness backstops ──────────────
// These complement the two tests above with the LIVE-pid stamped variants that
// exercise tryStealStaleLock()/isPidAlive() directly: a live holder is NEVER
// stolen within the hard ceiling (bounded retry → degraded write), a dead holder
// IS stolen even with a fresh mtime, and a live-but-ancient holder is stolen by
// the hard-stale backstop.

/** A pid that is provably NOT a running process on this host (for steal tests). */
function findDeadPid() {
  for (let p = 99_999; p > 90_000; p--) {
    try { process.kill(p, 0); } catch (e) { if (e && e.code === 'ESRCH') return p; }
  }
  return 999_999; // extremely unlikely to be live; ESRCH search above almost always wins.
}

/** Run `fn` with a stub bus capturing emitted topics; restores the prior bus. */
async function withBusCapture(fn) {
  const topics = [];
  const prevBus = globalThis.__ccpBus;
  globalThis.__ccpBus = { emit: (topic) => topics.push(topic) };
  try {
    await fn();
  } finally {
    globalThis.__ccpBus = prevBus;
  }
  return topics;
}

test('M1: a FRESH lock stamped with a LIVE pid is NOT stolen — bounded retry then a degraded (contended) write', async () => {
  // LIVE contention: the lockfile holds THIS process's pid (provably alive) with a
  // fresh mtime. tryStealStaleLock() must refuse to steal it (alive && within the
  // hard ceiling). acquireLock() then does its bounded retry budget
  // (LOCK_RETRY_ATTEMPTS × LOCK_RETRY_MS ≈ 1s — the same real wait the existing
  // fresh-lock test pays) and finally degrades to a best-effort unlocked write that
  // emits memory.lock.contended rather than HANGING or stealing.
  const dir = freshDir();
  const file = join(dir, 'live-contention.json');
  const mem = createMemory({ path: file });
  mem.set('x', 1);
  await mem.flush();

  const lockPath = `${file}.lock`;
  const fd = openSync(lockPath, 'w'); // fresh mtime = now
  writeSync(fd, String(process.pid)); // stamp a LIVE pid (us)

  let topics;
  try {
    mem.set('x', 2);
    topics = await withBusCapture(() => mem.flush()); // must not hang/throw/steal
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
    rmSync(lockPath, { force: true });
  }

  assert.ok(
    topics.includes('memory.lock.contended'),
    'a live-held lock degrades to an unlocked write that emits memory.lock.contended',
  );
  assert.equal(
    JSON.parse(readFileSync(file, 'utf8')).x, 2,
    'the degraded write still persisted the value (never dropped, never hung)',
  );
});

test('M2(a): a lock with a DEAD pid + fresh mtime IS stolen and the write completes under the lock', async () => {
  // pid-liveness backstop: even with a brand-new mtime, a holder whose pid is dead
  // (ESRCH) is provably crashed, so tryStealStaleLock() removes it and the writer
  // re-acquires — no contended degrade, the value lands under a real lock.
  const dir = freshDir();
  const file = join(dir, 'dead-pid.json');
  const mem = createMemory({ path: file });
  mem.set('x', 1);
  await mem.flush();

  const lockPath = `${file}.lock`;
  const fd = openSync(lockPath, 'w'); // fresh mtime
  writeSync(fd, String(findDeadPid())); // stamp a DEAD pid
  closeSync(fd);

  mem.set('x', 2);
  const topics = await withBusCapture(() => mem.flush());

  assert.equal(existsSync(lockPath), false, 'the dead-holder lock was stolen and released');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).x, 2, 'write completed after stealing the dead lock');
  assert.equal(
    topics.includes('memory.lock.contended'), false,
    'no contended degrade — the steal succeeded so the write ran UNDER the lock',
  );
});

test('M2(b): a LIVE pid with an mtime past the hard-stale ceiling IS stolen (pid-reuse / hung-writer backstop)', async () => {
  // The hard-stale backstop: a live pid normally protects the lock, but a lock
  // OLDER than LOCK_HARD_STALE_MS (60s) is stolen anyway — otherwise a reused pid
  // (a crashed holder's number recycled by an unrelated live process) or a hung
  // writer would wedge the store forever.
  const dir = freshDir();
  const file = join(dir, 'hard-stale-live.json');
  const mem = createMemory({ path: file });
  mem.set('x', 1);
  await mem.flush();

  const lockPath = `${file}.lock`;
  const fd = openSync(lockPath, 'w');
  writeSync(fd, String(process.pid)); // a LIVE pid (us)
  closeSync(fd);
  // Age the lock to 2 minutes — well past the 60s hard ceiling.
  const old = Date.now() / 1000 - 120;
  utimesSync(lockPath, old, old);

  mem.set('x', 2);
  const topics = await withBusCapture(() => mem.flush());

  assert.equal(existsSync(lockPath), false, 'the live-but-ancient lock was stolen by the hard-stale backstop');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).x, 2, 'write completed under the re-acquired lock');
  assert.equal(topics.includes('memory.lock.contended'), false, 'steal succeeded → no contended degrade');
});

test('M2(c): a LIVE pid with a FRESH mtime is NOT stolen (the lock is respected)', async () => {
  // The complement of (a)/(b): a healthy holder (live pid, fresh mtime) within the
  // hard ceiling owns the lock and must NEVER be stolen — proven by the lockfile
  // surviving the contended write. (The degrade itself is the subject of M1.)
  const dir = freshDir();
  const file = join(dir, 'live-fresh.json');
  const mem = createMemory({ path: file });
  mem.set('x', 1);
  await mem.flush();

  const lockPath = `${file}.lock`;
  const fd = openSync(lockPath, 'w'); // fresh mtime
  writeSync(fd, String(process.pid)); // live pid

  let topics;
  try {
    mem.set('x', 2);
    topics = await withBusCapture(() => mem.flush());
    assert.equal(existsSync(lockPath), true, 'a live+fresh lock is NOT stolen — it still exists after the write');
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
    rmSync(lockPath, { force: true });
  }
  assert.ok(topics.includes('memory.lock.contended'), 'the writer degraded around the respected lock');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).x, 2, 'the degraded write still persisted the value');
});

// ── cross-process lock: release-after-takeover + unknown-holder fuse ───────────

test('M3: release-after-takeover — a writer whose lock was STOLEN and re-created by another holder does NOT delete the new owner\'s lock', async () => {
  // FIX #1 (ownership-checked release). createMemory stamps a UNIQUE token
  // (pid:nonce) into the lockfile on acquire. If holder A's lock gets stolen and
  // a different holder B re-creates the lockfile (a different token), A's
  // releaseLock() must re-read the on-disk content and, seeing B's token, SKIP the
  // rmSync — otherwise A would delete a lock B currently holds, putting two writers
  // in the critical section.
  //
  // We drive this directly through the lock primitives the way the M-series tests
  // do: build A's instance, take A's lock, simulate the takeover by overwriting the
  // lockfile content with B's distinct token, then prove A's flush/release leaves
  // B's lock intact.
  const dir = freshDir();
  const file = join(dir, 'takeover.json');

  const memA = createMemory({ path: file });
  memA.set('x', 1);
  await memA.flush(); // creates + releases cleanly; no lock left behind.

  const lockPath = `${file}.lock`;
  // Simulate the post-takeover world: B now owns the lockfile with B's OWN token,
  // distinct from anything A would mint. A's next write will find this fresh,
  // live-pid (us), within-ceiling lock and degrade around it WITHOUT stealing — and
  // critically, A must never delete it.
  const bToken = `${process.pid}:B-OWNS-THIS:${Math.random().toString(36).slice(2)}`;
  writeFileSync(lockPath, bToken, 'utf8');

  let topics;
  try {
    memA.set('x', 2);
    topics = await withBusCapture(() => memA.flush());
    assert.equal(existsSync(lockPath), true, 'B\'s lock still exists — A did not delete a lock it does not own');
    assert.equal(readFileSync(lockPath, 'utf8'), bToken, 'B\'s token is intact — A neither stole nor released it');
  } finally {
    rmSync(lockPath, { force: true });
  }
  assert.ok(
    topics.includes('memory.lock.contended'),
    'A degraded around B\'s live lock (could not acquire) rather than stealing/deleting it',
  );
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).x, 2, 'A\'s degraded write still persisted its value');
});

test('M4: an EMPTY/unknown-content lock with a FRESH-but-soft-stale mtime is RESPECTED, not stolen at the soft fuse', async () => {
  // FIX #2 (failed-stamp must not be soft-stealable). If a live writer's pid stamp
  // fails to land (ENOSPC/EIO), the lockfile has EMPTY content → readLockPid()
  // returns null (unknown holder). The old policy stole an unknown holder once the
  // lock crossed the ~10s soft fuse, which would rob a healthy live writer. The new
  // policy treats an unknown holder as LIVE until the HARD ceiling (60s): a lock
  // aged between the old soft fuse and the hard ceiling must NOT be stolen.
  const dir = freshDir();
  const file = join(dir, 'empty-soft.json');
  const mem = createMemory({ path: file });
  mem.set('x', 1);
  await mem.flush();

  const lockPath = `${file}.lock`;
  const fd = openSync(lockPath, 'w'); // EMPTY content — no pid/token stamp landed.
  closeSync(fd);
  // Age it to 30s: well past the old 10s soft fuse, but well within the 60s hard
  // ceiling. An unknown holder here must be respected (treated as live).
  const old = Date.now() / 1000 - 30;
  utimesSync(lockPath, old, old);

  let topics;
  try {
    mem.set('x', 2);
    topics = await withBusCapture(() => mem.flush());
    assert.equal(
      existsSync(lockPath), true,
      'an empty/unknown lock within the hard ceiling is NOT soft-stolen — it survives the write',
    );
  } finally {
    rmSync(lockPath, { force: true });
  }
  assert.ok(
    topics.includes('memory.lock.contended'),
    'the writer degraded around the respected unknown-holder lock instead of stealing it',
  );
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).x, 2, 'the degraded write still persisted the value');
});

test('M4(b): an EMPTY/unknown-content lock PAST the hard ceiling IS stolen (never-stamped crash backstop)', async () => {
  // Complement of M4: the hard ceiling is the ONLY thing that reclaims an unknown
  // holder. A never-stamped lock older than LOCK_HARD_STALE_MS (60s) is a crashed
  // writer whose stamp never landed — it must be stolen so the store can't wedge.
  const dir = freshDir();
  const file = join(dir, 'empty-hard.json');
  const mem = createMemory({ path: file });
  mem.set('x', 1);
  await mem.flush();

  const lockPath = `${file}.lock`;
  const fd = openSync(lockPath, 'w'); // EMPTY content
  closeSync(fd);
  const old = Date.now() / 1000 - 120; // 2 min — past the 60s hard ceiling.
  utimesSync(lockPath, old, old);

  mem.set('x', 2);
  const topics = await withBusCapture(() => mem.flush());

  assert.equal(existsSync(lockPath), false, 'an empty lock past the hard ceiling was stolen and released');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).x, 2, 'write completed under the re-acquired lock');
  assert.equal(topics.includes('memory.lock.contended'), false, 'steal succeeded → no contended degrade');
});

// ── transform round-trip verification at construction ─────────────────────────

test('createMemory THROWS when the transform is not a round-trip (onRead != inverse of onWrite)', () => {
  const dir = freshDir();
  const file = join(dir, 'bad-transform.json');
  // onRead is NOT the inverse of onWrite → store would silently corrupt on reload.
  const badTransform = {
    onWrite: (s) => Buffer.from(s, 'utf8').toString('base64'),
    onRead: (s) => s, // forgot to decode → onRead(onWrite(x)) !== x
  };
  assert.throws(
    () => createMemory({ path: file, transform: badTransform }),
    /not a round-trip|inverse/,
    'a non-inverse transform pair is rejected at construction',
  );
});

test('createMemory THROWS when a transform function itself throws during the probe', () => {
  const dir = freshDir();
  const file = join(dir, 'throwing-transform.json');
  const throwing = {
    onWrite: (s) => s,
    onRead: () => { throw new Error('decrypt failed'); },
  };
  assert.throws(
    () => createMemory({ path: file, transform: throwing }),
    /threw|inverse/,
    'a throwing transform is treated as a round-trip failure',
  );
});

test('createMemory accepts a valid round-trip transform (no false positive)', () => {
  const dir = freshDir();
  const file = join(dir, 'good-transform.json');
  const good = {
    onWrite: (s) => Buffer.from(s, 'utf8').toString('base64'),
    onRead: (s) => Buffer.from(s, 'base64').toString('utf8'),
  };
  assert.doesNotThrow(() => createMemory({ path: file, transform: good }));
});

test('set() rejects a non-JSON-serializable value synchronously and does NOT poison the store', async () => {
  const dir = freshDir();
  const file = join(dir, 'poison.json');
  const mem = createMemory({ path: file });

  mem.set('good', { a: 1 });

  // A cyclic value (and a BigInt) must be rejected AT THE CALL SITE. Otherwise it
  // would throw later inside the whole-cache JSON.stringify, dropping this write
  // AND blocking every future flush — silently poisoning the entire store.
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => mem.set('bad', cyclic), /not JSON-serializable/);
  assert.throws(() => mem.set('big', 10n), /not JSON-serializable/);

  // The rejected keys never entered the cache; the good key is unaffected.
  assert.equal(mem.get('bad'), undefined, 'rejected value did not enter the cache');
  assert.deepEqual(mem.snapshot(), { good: { a: 1 } });

  // And persistence of the good key is NOT blocked by the rejected writes.
  await mem.flush();
  assert.deepEqual(
    JSON.parse(readFileSync(file, 'utf8')), { good: { a: 1 } },
    'good key persisted despite the rejected non-serializable writes',
  );
});

test('an existing file failing with an OS access code (EACCES) is NOT quarantined — only corruption is', () => {
  const dir = freshDir();
  const file = join(dir, 'locked.json');
  writeFileSync(file, JSON.stringify({ keep: 'me' }), 'utf8');

  // Simulate a read that fails with an access code rather than a parse error.
  // onRead runs after readFileSync; we throw an EACCES-coded error only for the
  // real file content (not the construction-time round-trip probe, which must
  // still pass) so this exercises the SAME catch branch a real permission
  // failure would — a valid file we simply cannot read right now.
  const transform = {
    onWrite: (s) => s,
    onRead: (s) => {
      if (s.includes('keep')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return s;
    },
  };

  const realWarn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  try {
    const mem = createMemory({ path: file, transform });
    assert.deepEqual(mem.snapshot(), {}, 'unreadable file → empty store, no throw');
  } finally {
    console.warn = realWarn;
  }

  // The valid file must be LEFT IN PLACE — renaming it aside would be data loss.
  assert.equal(existsSync(file), true, 'access error must not move the file aside');
  assert.equal(
    readdirSync(dir).filter((n) => n.includes('.corrupt-')).length, 0,
    'no quarantine sidecar for an access error',
  );
  assert.deepEqual(
    JSON.parse(readFileSync(file, 'utf8')), { keep: 'me' },
    'original bytes preserved on disk',
  );
  assert.ok(
    warnings.some((w) => /not corruption/i.test(w)),
    'warned that the file was left in place (not corruption)',
  );
});

// ── cross-process concurrent writers (lock + merge) ───────────────────────────

// A standalone writer process: open the SAME store, write `rounds` batches of
// `perRound` keys (flushing between rounds so writers genuinely interleave and
// contend on the lockfile), then exit. Imports the package memory.mjs by URL.
const WRITER_SRC = `
const [, , modUrl, file, prefix, roundsStr, perRoundStr] = process.argv;
const rounds = Number(roundsStr), perRound = Number(perRoundStr);
const { createMemory } = await import(modUrl);
const mem = createMemory({ path: file });
for (let r = 0; r < rounds; r++) {
  for (let i = 0; i < perRound; i++) mem.set(prefix + '-' + r + '-' + i, { p: prefix, r, i });
  await mem.flush();
}
`;

function runWriter(workerPath, modUrl, file, prefix, rounds, perRound, root) {
  return new Promise((res, rej) => {
    const cp = spawn(
      execPath,
      [workerPath, modUrl, file, prefix, String(rounds), String(perRound)],
      { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] }, // child cwd = project root for the path sandbox
    );
    let errOut = '';
    cp.stderr.on('data', (d) => { errOut += d; });
    cp.on('error', rej);
    cp.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`writer ${prefix} exited ${code}: ${errOut}`)));
  });
}

test('concurrent writers across processes preserve every key (lockfile + merge)', async () => {
  const dir = freshDir();
  const file = join(dir, 'concurrent.json');
  const workerPath = join(dir, 'writer.mjs');
  writeFileSync(workerPath, WRITER_SRC, 'utf8');
  const modUrl = new URL('../memory.mjs', import.meta.url).href;

  const WRITERS = 5;
  const ROUNDS = 5;
  const PER_ROUND = 8; // 40 keys per writer

  // Spawn all writers concurrently so they actually contend on the lock.
  await Promise.all(
    Array.from({ length: WRITERS }, (_, w) =>
      runWriter(workerPath, modUrl, file, `w${w}`, ROUNDS, PER_ROUND, cwd())),
  );

  // EVERY key written by EVERY process must survive — the lock + merge must not
  // let one writer's atomic rename clobber another's keys.
  const final = JSON.parse(readFileSync(file, 'utf8'));
  const missing = [];
  for (let w = 0; w < WRITERS; w++) {
    for (let r = 0; r < ROUNDS; r++) {
      for (let i = 0; i < PER_ROUND; i++) {
        const k = `w${w}-${r}-${i}`;
        if (!Object.prototype.hasOwnProperty.call(final, k)) missing.push(k);
      }
    }
  }
  assert.deepEqual(missing, [], `no keys clobbered across ${WRITERS} concurrent writers`);
  assert.equal(
    Object.keys(final).length, WRITERS * ROUNDS * PER_ROUND,
    'exactly every writer\'s keys present — none lost, none invented',
  );
  // The lockfile must be released (not left wedging the store).
  assert.equal(existsSync(`${file}.lock`), false, 'lockfile released after all writers finished');
});

// ── append-log cap: no overshoot, single-huge value handled ───────────────────

test('appendLog never overshoots the cap by a whole record (compacts before crossing)', async () => {
  const dir = freshDir();
  const file = join(dir, 'cap.json');
  const CAP = 200;
  const mem = createMemory({ path: file, appendLog: true, maxBytes: CAP });
  // Re-set a SMALL fixed key set many times: the snapshot stays well under CAP
  // while the delta log keeps growing, exercising the compaction threshold. The
  // old `size > cap` check let the log overshoot to ~cap + one record; the fixed
  // `size + recordBytes > cap` check compacts BEFORE crossing, so when the
  // snapshot fits under the cap the log size never exceeds it.
  for (let r = 0; r < 40; r++) {
    for (const k of ['k0', 'k1', 'k2']) mem.set(k, 'v'.repeat(10) + r);
  }
  await mem.flush();

  const logSize = statSync(`${file}.log`).size;
  assert.ok(logSize <= CAP, `log never overshot the cap (${logSize}B <= ${CAP}B)`);

  const reloaded = createMemory({ path: file, appendLog: true, maxBytes: CAP });
  assert.equal(reloaded.keys().length, 3, 'keys replay correctly after cap-bounded compaction');
  assert.equal(reloaded.get('k2'), 'v'.repeat(10) + 39, 'last write wins on replay');
});

test('appendLog handles a single value larger than the cap without losing it', async () => {
  const dir = freshDir();
  const file = join(dir, 'huge.json');
  const CAP = 200;
  const mem = createMemory({ path: file, appendLog: true, maxBytes: CAP });
  const big = 'z'.repeat(CAP * 4); // one value several times the cap
  mem.set('huge', big);
  await mem.flush();

  // The value is NOT dropped — it lives in a compacted snapshot checkpoint.
  const reloaded = createMemory({ path: file, appendLog: true, maxBytes: CAP });
  assert.equal(reloaded.get('huge'), big, 'oversized single value preserved via snapshot');
});

test('opening a path in the OTHER persistence mode warns about ignored data', async () => {
  const dir = freshDir();
  const file = join(dir, 'modes.json');

  // 1) default-mode store on disk, then opened in append-log mode → warn.
  const d = createMemory({ path: file });
  d.set('a', 1);
  await d.flush();

  let realWarn = console.warn;
  let warnings = [];
  console.warn = (m) => warnings.push(String(m));
  try {
    createMemory({ path: file, appendLog: true });
  } finally {
    console.warn = realWarn;
  }
  assert.ok(warnings.some((w) => /append-log mode.*will be IGNORED/i.test(w)), 'warned on default→append-log');

  // 2) append-log store on disk, then opened in default mode → warn.
  const file2 = join(dir, 'modes2.json');
  const a = createMemory({ path: file2, appendLog: true });
  a.set('b', 2);
  await a.flush();

  warnings = [];
  realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    createMemory({ path: file2 });
  } finally {
    console.warn = realWarn;
  }
  assert.ok(warnings.some((w) => /default mode.*will be IGNORED/i.test(w)), 'warned on append-log→default');
});

// ── prototype-pollution hardening (untrusted file/log + user API) ─────────────

test('set() refuses prototype-polluting keys', () => {
  const dir = freshDir();
  const mem = createMemory({ path: join(dir, 'proto.json') });
  for (const k of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => mem.set(k, { polluted: true }), /unsafe key/, `set("${k}") rejected`);
  }
  // A normal key still works and nothing leaked onto Object.prototype.
  mem.set('ok', 1);
  assert.equal(mem.get('ok'), 1);
  assert.equal({}.polluted, undefined, 'Object.prototype not polluted');
});

test('a crafted delta log with a __proto__ set op does not pollute the replayed store', () => {
  const dir = freshDir();
  const file = join(dir, 'evil.json');
  // Hand-craft a delta log: a legit key plus a malicious __proto__ set op.
  const log =
    JSON.stringify({ op: 'set', key: 'safe', value: 1 }) + '\n' +
    JSON.stringify({ op: 'set', key: '__proto__', value: { polluted: true } }) + '\n';
  writeFileSync(`${file}.log`, log, 'utf8');

  const mem = createMemory({ path: file, appendLog: true });
  assert.equal(mem.get('safe'), 1, 'legit key replayed');
  assert.equal(mem.get('polluted'), undefined, 'no leaked prototype key');
  assert.equal({}.polluted, undefined, 'Object.prototype not polluted by replay');
  // The store object itself must not have had its prototype swapped.
  assert.equal(Object.getPrototypeOf(mem.snapshot()), Object.prototype, 'store prototype intact');
});
