#!/usr/bin/env node
/**
 * ccpatch-bridge — NDJSON client for a running CLI patched with headless_bridge.
 *
 * Usage:
 *   ccpatch-bridge submit  "summarize the PRs opened today"
 *   ccpatch-bridge dispatch Read '{"file_path":"/etc/hostname"}'
 *   ccpatch-bridge tail    [topic-glob ...]      # default: *
 *   ccpatch-bridge cancel  <ref>
 *
 * Env:
 *   CC_BRIDGE_ADDR    unix:/run/ccpatch.sock | tcp://127.0.0.1:7878   (required)
 *   CC_BRIDGE_TOKEN   shared secret matching the server side          (required)
 *
 * Stream layout:
 *   stdout — final result JSON (for submit/dispatch) or nothing (for tail)
 *   stderr — live event stream prefixed with "· <topic> <payload>"
 *
 * Exit codes:
 *   0  ok
 *   1  rpc error (server returned ok:false)
 *   2  bad args / missing env
 *   3  transport error
 */
import net from 'node:net';
import readline from 'node:readline';

const ADDR  = process.env.CC_BRIDGE_ADDR;
const TOKEN = process.env.CC_BRIDGE_TOKEN;
if (!ADDR || !TOKEN) {
  console.error('CC_BRIDGE_ADDR and CC_BRIDGE_TOKEN are required');
  process.exit(2);
}

const target = ADDR.startsWith('unix:')
  ? { path: ADDR.slice(5) }
  : (() => {
      if (!ADDR.startsWith('tcp://')) { console.error('CC_BRIDGE_ADDR must start with unix: or tcp://'); process.exit(2); }
      const [host, port] = ADDR.slice(6).split(':');
      return { host: host || '127.0.0.1', port: Number(port) };
    })();

const sock = net.connect(target);
sock.on('error', (e) => { console.error('transport:', e.message); process.exit(3); });

const rl = readline.createInterface({ input: sock });
const pending = new Map();        // id -> { resolve, reject }
let nextId = 0;
const idFor = () => 'c' + (++nextId);

const send = (obj) => sock.write(JSON.stringify(obj) + '\n');
const call = (op, extra = {}) => new Promise((resolve, reject) => {
  const id = idFor();
  pending.set(id, { resolve, reject });
  send({ id, op, ...extra });
});

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.kind === 'event') {
    process.stderr.write('· ' + msg.event + ' ' + JSON.stringify(msg.payload || {}) + '\n');
    return;
  }
  if (msg.kind === 'ack') {
    // ack frames for submit are intermediate — we resolve on result/error
    if (msg.id && pending.has(msg.id) && !['hello','subscribe','cancel','bye'].includes(msg._opHint)) {
      // For hello/subscribe/cancel/bye we treat ack as terminal.
    }
    const slot = pending.get(msg.id);
    if (slot && slot._terminalOnAck) { pending.delete(msg.id); slot.resolve(msg); }
    return;
  }
  if (!msg.id) return;
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.ok === false) slot.reject(new Error(msg.error || 'rpc error'));
  else slot.resolve(msg);
});

const ackOnly = (op, extra = {}) => new Promise((resolve, reject) => {
  const id = idFor();
  pending.set(id, { resolve, reject, _terminalOnAck: true });
  send({ id, op, ...extra });
});

const main = async () => {
  await ackOnly('hello', { token: TOKEN });
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'submit': {
      await ackOnly('subscribe', { topics: ['tool.*', 'turn.*', 'cost.delta', 'agent.*'] });
      const r = await call('submit', { prompt: rest.join(' ') });
      process.stdout.write(JSON.stringify(r.result, null, 2) + '\n');
      break;
    }
    case 'dispatch': {
      const [name, json] = rest;
      if (!name) { console.error('usage: dispatch <tool> [input-json]'); process.exit(2); }
      const r = await call('dispatch', { name, input: json ? JSON.parse(json) : {} });
      process.stdout.write(JSON.stringify(r.result, null, 2) + '\n');
      break;
    }
    case 'cancel': {
      const ref = rest[0];
      if (!ref) { console.error('usage: cancel <ref>'); process.exit(2); }
      await ackOnly('cancel', { ref });
      break;
    }
    case 'tail': {
      await ackOnly('subscribe', { topics: rest.length ? rest : ['*'] });
      // never resolve — keep streaming until SIGINT
      return;
    }
    default:
      console.error('usage: ccpatch-bridge {submit|dispatch|tail|cancel} ...');
      process.exit(2);
  }
  await ackOnly('bye');
  sock.end();
};

main().catch((e) => { console.error(e.message); process.exit(1); });
