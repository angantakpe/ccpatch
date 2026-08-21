/**
 * Telegram adapter streaming/ordering tests.
 *
 * grammy is an optionalDependency and Telegram is unreachable from CI, so
 * nothing here constructs a real `Bot`. That is exactly why the adapter's
 * logic lives in `createMessageHandler` / `createMessageSurface` (telegram.mjs)
 * and `streamTurn` / `createThrottle` / `SerialQueue` (streaming.mjs): each
 * takes its Telegram and bridge surfaces as plain objects, so a fake ctx with
 * `reply()` + `api.editMessageText()` and a fake bridge with `on/off/submit`
 * are enough to exercise the real code paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMessageHandler, createMessageSurface } from '../adapters/telegram.mjs';
import { createThrottle, SerialQueue, streamTurn, clip, MAX_MESSAGE_CHARS } from '../streaming.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fake bridge: an EventEmitter (same interface BridgeClient exposes — it emits
 * per-topic, e.g. 'assistant.text') plus a scriptable submit().
 * @param {(emit: (text: string) => void) => Promise<any>} script
 */
function fakeBridge(script) {
  const bridge = new EventEmitter();
  bridge.submits = [];
  bridge.submit = async (prompt) => {
    bridge.submits.push(prompt);
    return script((text) => bridge.emit('assistant.text', { text }), prompt);
  };
  return bridge;
}

/** Fake grammy ctx recording every reply/edit in order. */
function fakeCtx(chatId, text, calls = []) {
  let nextId = 100;
  const ctx = {
    chat: { id: chatId },
    message: { text },
    calls,
    async reply(t) {
      const message_id = nextId++;
      calls.push({ chatId, op: 'reply', text: t, message_id });
      return { message_id, chat: { id: chatId } };
    },
    api: {
      async editMessageText(cid, message_id, t) {
        calls.push({ chatId: cid, op: 'edit', text: t, message_id });
        return { message_id };
      },
    },
  };
  return ctx;
}

test('createThrottle: collapses a burst into a leading + single trailing call', async () => {
  const seen = [];
  const throttled = createThrottle((v) => { seen.push(v); }, 60);

  for (let i = 0; i < 25; i++) throttled(i); // synchronous burst
  await sleep(0); // invocations are chained through a promise, so they land a tick later
  assert.deepEqual(seen, [0], 'leading edge fires immediately, the rest coalesce');

  await sleep(120);
  assert.deepEqual(seen, [0, 24], 'trailing edge fires once, with the newest value');

  await throttled.flush();
  assert.equal(seen.length, 2, 'flush with nothing pending is a no-op');
});

test('createThrottle: serializes fn invocations rather than overlapping them', async () => {
  const order = [];
  const throttled = createThrottle(async (v) => {
    order.push(`start:${v}`);
    await sleep(20);
    order.push(`end:${v}`);
  }, 10);

  throttled('a');
  await sleep(15);
  throttled('b');
  await throttled.flush();

  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test('streamTurn: streams mid-turn text as throttled edits, not one edit per event', async () => {
  const calls = [];
  const ctx = fakeCtx(1, 'hi', calls);

  const bridge = fakeBridge(async (emit) => {
    // 40 deltas over ~200ms — far more events than allowed edits.
    for (let i = 0; i < 40; i++) {
      emit(`chunk${i} `);
      await sleep(5);
    }
    return { final: 'FINAL ANSWER' };
  });

  await streamTurn({ bridge, prompt: 'hi', message: createMessageSurface(ctx), throttleMs: 50 });

  const replies = calls.filter((c) => c.op === 'reply');
  const edits = calls.filter((c) => c.op === 'edit');

  assert.equal(replies.length, 1, 'exactly one placeholder');
  assert.equal(replies[0].text, '…');
  assert.ok(edits.length >= 2, `expected several streaming edits, got ${edits.length}`);
  assert.ok(edits.length < 12, `expected throttling well below 40 events, got ${edits.length}`);
  assert.equal(edits.at(-1).text, 'FINAL ANSWER', 'final result supersedes partial text');
  assert.ok(edits[0].text.startsWith('chunk0 '), 'mid-turn edits carry accumulated text');
  assert.ok(edits.every((e) => e.message_id === replies[0].message_id), 'all edits target the placeholder');
});

test('streamTurn: a rejected submit edits the placeholder with the error instead of leaving "…"', async () => {
  const calls = [];
  const ctx = fakeCtx(7, 'boom', calls);
  const bridge = fakeBridge(async () => { throw new Error('bridge exploded'); });

  const outcome = await streamTurn({ bridge, prompt: 'boom', message: createMessageSurface(ctx), throttleMs: 20 });

  assert.equal(outcome.ok, false);
  const edits = calls.filter((c) => c.op === 'edit');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].text, 'error: bridge exploded');
});

test('streamTurn: falls back to result.text, then JSON, matching the adapter\'s original logic', async () => {
  const a = fakeCtx(1, 'x');
  await streamTurn({ bridge: fakeBridge(async () => ({ text: 'via-text' })), prompt: 'x', message: createMessageSurface(a), throttleMs: 20 });
  assert.equal(a.calls.filter((c) => c.op === 'edit').at(-1).text, 'via-text');

  const b = fakeCtx(2, 'x');
  await streamTurn({ bridge: fakeBridge(async () => ({ weird: 1 })), prompt: 'x', message: createMessageSurface(b), throttleMs: 20 });
  assert.equal(b.calls.filter((c) => c.op === 'edit').at(-1).text, '{"weird":1}');
});

test('streamTurn: unsubscribes its assistant.text listener when the turn ends', async () => {
  const ctx = fakeCtx(1, 'x');
  const bridge = fakeBridge(async () => ({ final: 'done' }));
  await streamTurn({ bridge, prompt: 'x', message: createMessageSurface(ctx), throttleMs: 20 });
  assert.equal(bridge.listenerCount('assistant.text'), 0, 'no listener leak across turns');
});

test('clip: keeps output inside the channel message cap', () => {
  assert.equal(clip('short'), 'short');
  const clipped = clip('x'.repeat(MAX_MESSAGE_CHARS + 500));
  assert.equal(clipped.length, MAX_MESSAGE_CHARS);
  assert.ok(clipped.endsWith('…'));
});

test('SerialQueue: same key runs strictly in order, different keys run concurrently', async () => {
  const q = new SerialQueue();
  const order = [];
  const job = (name, ms) => async () => {
    order.push(`start:${name}`);
    await sleep(ms);
    order.push(`end:${name}`);
    return name;
  };

  const a = q.run('k', job('a', 40));
  const b = q.run('k', job('b', 5));
  const c = q.run('other', job('c', 5));
  assert.deepEqual(await Promise.all([a, b, c]), ['a', 'b', 'c']);

  assert.deepEqual(order.filter((o) => o.endsWith('a') || o.endsWith('b')), ['start:a', 'end:a', 'start:b', 'end:b']);
  assert.ok(order.indexOf('end:c') < order.indexOf('end:a'), 'a different key is not blocked');
  assert.equal(q.size, 0, 'drained keys are dropped from the map');
});

test('SerialQueue: a rejected job does not poison the rest of its key', async () => {
  const q = new SerialQueue();
  await assert.rejects(q.run('k', async () => { throw new Error('nope'); }), /nope/);
  assert.equal(await q.run('k', async () => 'still works'), 'still works');
});

test('per-chat serialization: two messages from one chat are handled strictly in order', async () => {
  const calls = [];
  const chatTurns = new SerialQueue();
  const started = [];

  // Deliberately slow submit, so message 2 would overtake message 1 without
  // the per-chat queue.
  const bridge = fakeBridge(async (emit, prompt) => {
    started.push(prompt);
    emit(`streaming for ${prompt} `);
    await sleep(60);
    return { final: `done:${prompt}` };
  });

  const handler = createMessageHandler({
    bridge,
    isAllowed: () => true,
    chatTurns,
    log: () => {},
    editThrottleMs: 15,
  });

  // Fire both without awaiting the first — the race the queue has to prevent.
  const first = handler(fakeCtx(42, 'first', calls));
  const second = handler(fakeCtx(42, 'second', calls));
  await Promise.all([first, second]);

  assert.deepEqual(started, ['first', 'second'], 'submits reach the bridge in arrival order');
  assert.deepEqual(bridge.submits, ['first', 'second']);

  // The whole of message 1's exchange precedes any of message 2's — including
  // the placeholder, which is what proves the handler (not just submit) queued.
  const texts = calls.map((c) => c.text);
  const firstDone = texts.indexOf('done:first');
  const secondPlaceholder = calls.findIndex((c, i) => c.op === 'reply' && i > 0);
  assert.ok(firstDone >= 0 && secondPlaceholder >= 0);
  assert.ok(firstDone < secondPlaceholder, `message 1 finished at ${firstDone} before message 2 started at ${secondPlaceholder}`);
  assert.equal(texts.at(-1), 'done:second');
});

test('no-correlation fallback: concurrent chats are serialized so streamed text is never mixed', async () => {
  // headless_bridge does not put a `ref` on event frames and assistant.text
  // carries only { text } (see streaming.mjs's header), so the ONLY way a
  // streamed chunk is attributable is if exactly one submit is in flight
  // gateway-wide. This asserts that invariant holds across different chats,
  // which the per-chat queue alone would NOT give.
  const calls = [];
  const inFlight = { now: 0, max: 0 };

  const bridge = fakeBridge(async (emit, prompt) => {
    inFlight.now += 1;
    inFlight.max = Math.max(inFlight.max, inFlight.now);
    try {
      emit(`${prompt}-a `);
      await sleep(40);
      emit(`${prompt}-b `);
      await sleep(40);
      return { final: `done:${prompt}` };
    } finally {
      inFlight.now -= 1;
    }
  });

  const handler = createMessageHandler({ bridge, isAllowed: () => true, chatTurns: new SerialQueue(), log: () => {}, editThrottleMs: 15 });

  // Two DIFFERENT chats — the per-chat queue does not serialize these.
  await Promise.all([handler(fakeCtx(1, 'alpha', calls)), handler(fakeCtx(2, 'beta', calls))]);

  assert.equal(inFlight.max, 1, 'at most one submit in flight across the whole gateway');

  // Every edit for a chat mentions only that chat's own prompt.
  for (const c of calls.filter((x) => x.op === 'edit')) {
    const mine = c.chatId === 1 ? 'alpha' : 'beta';
    const theirs = c.chatId === 1 ? 'beta' : 'alpha';
    assert.ok(c.text.includes(mine), `chat ${c.chatId} edit should carry its own text: ${c.text}`);
    assert.ok(!c.text.includes(theirs), `chat ${c.chatId} leaked the other chat's text: ${c.text}`);
  }
});

test('createMessageHandler: a denied chat never reaches the bridge and gets no message', async () => {
  const calls = [];
  const bridge = fakeBridge(async () => ({ final: 'should not happen' }));
  const handler = createMessageHandler({ bridge, isAllowed: () => false, chatTurns: new SerialQueue(), log: () => {} });

  await handler(fakeCtx(999, 'let me in', calls));

  assert.deepEqual(calls, []);
  assert.deepEqual(bridge.submits, []);
});
