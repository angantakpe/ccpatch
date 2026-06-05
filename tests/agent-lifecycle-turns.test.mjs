/**
 * agent-lifecycle-turns.test.mjs
 *
 * Verifies the agent_lifecycle patch brackets a turn correctly: turn.start fires
 * from the fetch BEFORE hook (request dispatch) and turn.end from the AFTER hook
 * (stream complete), correlated by the per-call `options` object — so the two
 * timestamps span the turn instead of both being stamped at completion.
 *
 * The patch boot IIFE is eval'd in a vm sandbox (same approach as
 * tests/patch-verification.test.mjs Layer 3) with stubbed __ccpOnFetchBefore /
 * __ccpOnFetch / __ccpBus that capture the registered handlers and emitted events.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import lifecycle from '../extensions/agent_lifecycle.mjs';

/** Boot the patch in a sandbox; return { fire, emits } to drive the hooks. */
function bootLifecycle() {
  const applied = lifecycle.apply('#!/usr/bin/env node\n');
  const body = applied.replace(/^#!.*\n/, '');

  const handlers = {};
  const emits = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setInterval: () => 0,
    clearInterval: () => {},
    process: { env: {}, argv: [], versions: { node: '20.0.0' } },
  };
  sandbox.globalThis = sandbox;
  sandbox.__ccpBus = { emit: (topic, payload) => emits.push({ topic, payload }) };
  sandbox.__ccpOnFetchBefore = (_name, fn) => { handlers.before = fn; };
  sandbox.__ccpOnFetch = (_name, fn) => { handlers.after = fn; };

  vm.createContext(sandbox);
  new vm.Script(body).runInContext(sandbox);

  assert.equal(typeof handlers.before, 'function', 'registered a before hook');
  assert.equal(typeof handlers.after, 'function', 'registered an after hook');
  return { handlers, emits };
}

const apiCtx = (options) => ({ url: 'https://api.anthropic.com/v1/messages', options, isApi: true });
const deltaEvents = (input = 10, output = 5) => [
  { type: 'message_start' },
  { type: 'message_delta', usage: { input_tokens: input, output_tokens: output } },
];

test('turn.start fires on dispatch and turn.end on completion with a matching id', () => {
  const { handlers, emits } = bootLifecycle();
  const options = { method: 'POST', body: '{}' };

  handlers.before(apiCtx(options));
  assert.equal(emits.length, 1);
  assert.equal(emits[0].topic, 'turn.start');
  const startId = emits[0].payload.id;
  assert.ok(startId);
  assert.equal(typeof emits[0].payload.ts, 'number');

  handlers.after({ options, isApi: true, events: deltaEvents(10, 5) });
  // Exactly one more event — turn.end — and NO duplicate turn.start.
  assert.equal(emits.length, 2);
  const end = emits[1];
  assert.equal(end.topic, 'turn.end');
  assert.equal(end.payload.id, startId, 'end correlates to the start via options');
  assert.equal(end.payload.usage.in, 10);
  assert.equal(end.payload.usage.out, 5);
  assert.ok(end.payload.ms >= 0, 'carries a duration');
});

test('after hook without a paired start still emits a start+end pair (fallback)', () => {
  const { handlers, emits } = bootLifecycle();
  // No before hook ran for this options object.
  handlers.after({ options: { method: 'POST' }, isApi: true, events: deltaEvents() });
  assert.deepEqual(emits.map((e) => e.topic), ['turn.start', 'turn.end']);
  assert.equal(emits[0].payload.id, emits[1].payload.id);
});

test('a non-streaming/failed response (events null) still closes an open turn', () => {
  const { handlers, emits } = bootLifecycle();
  const options = { method: 'POST' };
  handlers.before(apiCtx(options));
  assert.deepEqual(emits.map((e) => e.topic), ['turn.start']);

  handlers.after({ options, isApi: true, events: null });
  assert.deepEqual(emits.map((e) => e.topic), ['turn.start', 'turn.end']);
  assert.equal(emits[1].payload.id, emits[0].payload.id);
  assert.equal(emits[1].payload.usage, null);
});

test('concurrent turns keep distinct ids correlated by their own options', () => {
  const { handlers, emits } = bootLifecycle();
  const o1 = { method: 'POST', body: '1' };
  const o2 = { method: 'POST', body: '2' };

  handlers.before(apiCtx(o1));
  handlers.before(apiCtx(o2));
  const id1 = emits[0].payload.id;
  const id2 = emits[1].payload.id;
  assert.notEqual(id1, id2);

  // Complete out of order: o2 finishes first.
  handlers.after({ options: o2, isApi: true, events: deltaEvents() });
  handlers.after({ options: o1, isApi: true, events: deltaEvents() });

  const ends = emits.filter((e) => e.topic === 'turn.end');
  assert.equal(ends.length, 2);
  assert.equal(ends[0].payload.id, id2, 'first end matches the turn that finished first');
  assert.equal(ends[1].payload.id, id1);
});

test('non-API fetches are ignored', () => {
  const { handlers, emits } = bootLifecycle();
  handlers.before({ url: 'https://example.com', options: {}, isApi: false });
  handlers.after({ options: {}, isApi: false, events: deltaEvents() });
  assert.equal(emits.length, 0);
});
