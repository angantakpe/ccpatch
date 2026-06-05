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
} from 'node:fs';
import { join, relative } from 'node:path';
import { cwd, platform } from 'node:process';

import { createMemory } from '../packages/adk/memory.mjs';

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

// ── 0600 file mode + atomic write (FINDING 7) ─────────────────────────────────

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

// ── deep-clone snapshot isolation (FINDING 15) ────────────────────────────────

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

// ── dispose(): exit-listener registry does not grow (FINDING 8) ───────────────

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
