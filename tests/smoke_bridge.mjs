#!/usr/bin/env node
/**
 * smoke_bridge — minimal end-to-end check of the headless_bridge protocol.
 *
 * This test does NOT boot a real patched CLI (that's a heavier integration
 * task). Instead it loads the runtime hook out of headless_bridge.mjs into a
 * sandboxed Node context with the minimal __ccpBus / __ccpAuth / submit / tool
 * shims, then talks to the resulting socket using the NDJSON protocol.
 *
 * What this verifies:
 *   - hello + token check round-trips
 *   - submit goes through __ccpSubmitInput and returns its result
 *   - subscribed bus events arrive as event frames on the same connection
 *   - bye closes cleanly
 *
 * Run via:   make smoke-bridge
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 8000);

const SOCK  = path.join(os.tmpdir(), `ccpatch-smoke-${process.pid}.sock`);
const TOKEN = randomBytes(24).toString('hex');

const die = (msg) => { console.error('SMOKE FAIL:', msg); process.exit(1); };

// ── Extract the runtime hook by running the patch's apply() on a stub ─────
const bridgeMod = await import(path.join(ROOT, 'extensions/headless_bridge.mjs'));
const STUB_SHEBANG = '#!/usr/bin/env node';
const patched = bridgeMod.default.apply(STUB_SHEBANG + '\n// stub\n');
const hookSrc = patched.slice(STUB_SHEBANG.length, patched.indexOf('// stub\n'));

// ── Build a minimal sandbox approximating the patched-bundle environment ───
const events = new Map();
const bus = {
  on(topic, fn) {
    if (topic.includes('*')) {
      const re = new RegExp('^' + topic.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$');
      const entry = { re, fn };
      bus._globs.add(entry);
      return () => bus._globs.delete(entry);
    }
    let s = events.get(topic);
    if (!s) { s = new Set(); events.set(topic, s); }
    s.add(fn);
    return () => s.delete(fn);
  },
  emit(topic, payload) {
    const s = events.get(topic);
    if (s) for (const fn of s) { try { fn(payload, topic); } catch {} }
    for (const { re, fn } of bus._globs) {
      if (re.test(topic)) { try { fn(payload, topic); } catch {} }
    }
  },
  _globs: new Set(),
};

process.env.CC_BRIDGE_ADDR = 'unix:' + SOCK;
globalThis.__ccpBus = bus;
globalThis.__ccpAuth = {
  has: () => true,
  verify: (presented) => {
    const got = (presented || '').replace(/^Bearer\s+/i, '');
    return got === TOKEN;
  },
};
globalThis.__ccpSubmitInput = async (prompt) => {
  bus.emit('turn.start', { id: 't1' });
  bus.emit('tool.call',   { id: 'tc1', agent_path: 'root', name: 'Read', input: {} });
  bus.emit('tool.result', { id: 'tc1', agent_path: 'root', name: 'Read', ok: true, bytes: 4 });
  bus.emit('turn.end',    { id: 't1', usage: { in: 1, out: 1 } });
  return { final: 'PONG:' + prompt };
};
globalThis.__ccpInvokeTool = async (name, input) => ({ tool: name, echoed: input });

// Evaluate the hook in this context. The hook uses CommonJS `require`, so we
// expose the createRequire'd require on globalThis before eval.
globalThis.require = require;
(0, eval)(hookSrc);

// ── Wait for the socket file, then drive the protocol ─────────────────────
const waitForSocket = () => new Promise((resolve, reject) => {
  const deadline = Date.now() + 3000;
  const tick = () => {
    if (fs.existsSync(SOCK)) return resolve();
    if (Date.now() > deadline) return reject(new Error('socket never appeared'));
    setTimeout(tick, 50);
  };
  tick();
});

const runClient = () => new Promise((resolve, reject) => {
  const sock = net.connect({ path: SOCK });
  const rl = readline.createInterface({ input: sock });
  const pending = new Map();
  let nextId = 0;
  const idFor = () => 'c' + (++nextId);
  const send = (obj) => sock.write(JSON.stringify(obj) + '\n');
  const call = (op, extra = {}, terminalOnAck = false) => new Promise((res, rej) => {
    const id = idFor();
    pending.set(id, { res, rej, terminalOnAck });
    send({ id, op, ...extra });
  });

  const seen = { turnStart: false, toolCall: false, toolResult: false, turnEnd: false };
  const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, TIMEOUT_MS);

  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.kind === 'event') {
      if (msg.event === 'turn.start')  seen.turnStart = true;
      if (msg.event === 'tool.call')   seen.toolCall = true;
      if (msg.event === 'tool.result') seen.toolResult = true;
      if (msg.event === 'turn.end')    seen.turnEnd = true;
      return;
    }
    if (!msg.id) return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    if (msg.kind === 'ack' && !slot.terminalOnAck) return;
    pending.delete(msg.id);
    if (msg.ok === false) { clearTimeout(timer); sock.destroy(); return reject(new Error(msg.error)); }
    slot.res(msg);
  });

  sock.on('error', (e) => { clearTimeout(timer); reject(e); });

  (async () => {
    await call('hello', { token: TOKEN }, true);
    await call('subscribe', { topics: ['turn.start','turn.end','tool.call','tool.result'] }, true);
    const r = await call('submit', { prompt: 'hello' });
    if (!r.result || r.result.final !== 'PONG:hello') {
      clearTimeout(timer); sock.destroy(); return reject(new Error('submit result mismatch: ' + JSON.stringify(r)));
    }
    await call('bye', {}, true);
    sock.end();
    clearTimeout(timer);
    // Give the event loop one tick to deliver the last event lines.
    setTimeout(() => {
      const missing = Object.entries(seen).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length) return reject(new Error('missing events: ' + missing.join(',')));
      resolve();
    }, 50);
  })().catch(reject);
});

const cleanup = () => { try { fs.unlinkSync(SOCK); } catch {} };
process.on('exit', cleanup);

(async () => {
  try {
    await waitForSocket();
    await runClient();
    console.log('OK: hello + subscribe + submit + bus events + bye');
    process.exit(0);
  } catch (e) {
    die(e.message);
  }
})();
