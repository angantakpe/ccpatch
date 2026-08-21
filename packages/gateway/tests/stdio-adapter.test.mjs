/**
 * stdio adapter unit test — no TTY, no socket, no headless_bridge.
 *
 * The adapter's whole job is the translation layer (stdin line ->
 * bridge.submit() -> stdout), so both sides are fakes here: a Readable
 * standing in for process.stdin and a plain object standing in for
 * BridgeClient. Protocol-level coverage lives in bridge-client.test.mjs,
 * which drives the real socket against tests/bridge_host.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createStdioAdapter } from '../adapters/stdio.mjs';

/** Collects everything written, so stdout can be asserted on. */
const collector = () => {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
  });
  return { stream, text: () => chunks.join('') };
};

/**
 * Runs the adapter over `lines` with a caller-supplied submit(), resolving
 * once stdin hits EOF and every submit has settled (that's what onEnd fires on).
 */
const drive = async (lines, submit) => {
  const submitted = [];
  const bridge = {
    submit: (prompt) => { submitted.push(prompt); return submit(prompt); },
    on: () => {},
    off: () => {},
  };
  const out = collector();
  const logs = [];

  let done;
  const ended = new Promise((resolve) => { done = resolve; });
  const adapter = createStdioAdapter({ onEnd: done, banner: collector().stream });

  adapter.start({
    bridge,
    log: (msg) => logs.push(String(msg)),
    input: Readable.from(lines),
    output: out.stream,
  });
  await ended;
  await adapter.stop();

  return { submitted, stdout: out.text(), logs };
};

test('stdio adapter: one submit per non-empty line, final result printed to stdout', async () => {
  const { submitted, stdout } = await drive(
    ['hello\n', '\n', '   \n', 'world\n'],
    async (prompt) => ({ final: `echo:${prompt}` })
  );

  assert.deepEqual(submitted, ['hello', 'world'], 'blank lines must not submit');
  assert.equal(stdout, 'echo:hello\necho:world\n');
});

test('stdio adapter: falls back to result.text, then to JSON, like telegram.mjs', async () => {
  const replies = [{ text: 'from text' }, { weird: 1 }];
  const { stdout } = await drive(['a\n', 'b\n'], async () => replies.shift());

  assert.equal(stdout, 'from text\n{"weird":1}\n');
});

test('stdio adapter: prints the accumulated assistant.text stream, not submit()\'s return value', async () => {
  // Confirmed live against a real patched CLI on 2026-08-21: submit() never
  // returns the answer there (extensions/expose_submit_input.mjs captures a
  // void UI event handler). Only the assistant.text stream carries it. This
  // stub emits chunks the way the real bridge does, then resolves submit()
  // with something that must be IGNORED once anything has streamed.
  let onText;
  const bridge = {
    on: (topic, fn) => { if (topic === 'assistant.text') onText = fn; },
    off: () => { onText = undefined; },
    submit: async (prompt) => {
      onText({ text: `real ` });
      onText({ text: `answer:${prompt}` });
      return { final: 'THIS MUST NOT WIN' };
    },
  };
  const out = collector();
  let done;
  const ended = new Promise((resolve) => { done = resolve; });
  const adapter = createStdioAdapter({ onEnd: done, banner: collector().stream });

  adapter.start({ bridge, log: () => {}, input: Readable.from(['hi\n']), output: out.stream });
  await ended;
  await adapter.stop();

  assert.equal(out.text(), 'real answer:hi\n');
});

test('stdio adapter: a rejected submit is reported but does not stop later lines', async () => {
  const { submitted, stdout, logs } = await drive(
    ['boom\n', 'still here\n'],
    async (prompt) => {
      if (prompt === 'boom') throw new Error('bridge went away');
      return { final: `echo:${prompt}` };
    }
  );

  assert.deepEqual(submitted, ['boom', 'still here'], 'processing must continue after a failure');
  assert.equal(stdout, 'echo:still here\n', 'the failed turn prints nothing to stdout');
  assert.ok(
    logs.some((l) => l.includes('bridge went away')),
    `expected the failure to be logged, got: ${JSON.stringify(logs)}`
  );
});

test('stdio adapter: satisfies the ChannelAdapter contract and stops cleanly mid-stream', async () => {
  const { isChannelAdapter } = await import('../adapter.mjs');
  const adapter = createStdioAdapter({ onEnd: () => {}, banner: collector().stream });
  assert.ok(isChannelAdapter(adapter));
  assert.equal(adapter.name, 'stdio');

  // Never-ending stream: stop() must resolve anyway, with no dangling loop.
  const input = new Readable({ read() {} });
  input.push('one\n');
  adapter.start({
    bridge: { submit: async () => ({ final: 'ok' }), on: () => {}, off: () => {} },
    log: () => {},
    input,
    output: collector().stream,
  });
  await adapter.stop();
});
