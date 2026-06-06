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
} from 'node:fs';
import { join, relative } from 'node:path';
import { cwd, platform } from 'node:process';

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

test('memory tolerates a corrupt file as an empty store', () => {
  const dir = freshDir();
  const file = join(dir, 'corrupt.json');
  writeFileSync(file, '{ not valid json', 'utf8');
  const mem = createMemory({ path: file });
  assert.deepEqual(mem.snapshot(), {}, 'unparseable file → empty store');
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
