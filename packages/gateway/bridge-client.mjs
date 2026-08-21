/**
 * BridgeClient — long-lived NDJSON client for a running CLI patched with
 * `extensions/headless_bridge.mjs`.
 *
 * The wire protocol (hello/submit/dispatch/subscribe/cancel/bye over one
 * newline-delimited-JSON socket connection) is not reinvented here — this is
 * a generalization of the same request/response handling already proven in
 * `tools/ccpatch-bridge.mjs` and exercised end-to-end by `tests/smoke_bridge.mjs`
 * against `tests/bridge_host.mjs`. That CLI tool is connect-once-per-invocation
 * (one command, one response, exit); this class is the reusable, long-lived
 * counterpart a gateway process needs — one connection shared by many
 * submit()/dispatch() calls and channel adapters, with events surfaced via a
 * normal EventEmitter interface instead of being written to stderr.
 *
 * See extensions/headless_bridge.mjs for the authoritative protocol docs and
 * EXTENSIONS_API.md for the exposed __ccp* surface this rides on.
 */
import net from 'node:net';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

const parseAddr = (addr) => {
  if (addr.startsWith('unix:')) return { path: addr.slice(5) };
  if (addr.startsWith('tcp://')) {
    const [host, port] = addr.slice(6).split(':');
    return { host: host || '127.0.0.1', port: Number(port) };
  }
  throw new Error(`BridgeClient: addr must start with "unix:" or "tcp://" (got ${JSON.stringify(addr)})`);
};

export class BridgeClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.addr]  unix:/path or tcp://host:port — defaults to CC_BRIDGE_ADDR
   * @param {string} [opts.token] shared secret — defaults to CC_BRIDGE_TOKEN
   */
  constructor({ addr = process.env.CC_BRIDGE_ADDR, token = process.env.CC_BRIDGE_TOKEN } = {}) {
    super();
    if (!addr) throw new Error('BridgeClient: addr (or CC_BRIDGE_ADDR) is required');
    if (!token) throw new Error('BridgeClient: token (or CC_BRIDGE_TOKEN) is required');
    this.addr = addr;
    this.token = token;
    this.sock = null;
    this.rl = null;
    this.connected = false;
    this._pending = new Map(); // id -> { resolve, reject, terminalOnAck }
    this._nextId = 0;
  }

  /** Open the socket and complete the hello handshake. Idempotent. */
  connect() {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sock = net.connect(parseAddr(this.addr));
      const onEarlyError = (err) => reject(new Error(`BridgeClient: connect failed: ${err.message}`));
      sock.once('error', onEarlyError);
      sock.once('connect', () => {
        sock.off('error', onEarlyError);
        sock.on('error', (err) => this.emit('error', err));
        sock.on('close', () => { this.connected = false; this.emit('close'); });
        this.sock = sock;
        this.rl = readline.createInterface({ input: sock });
        this.rl.on('line', (line) => this._onLine(line));
        this.connected = true;
        this._call('hello', { token: this.token }, true).then(resolve, reject);
      });
    });
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.kind === 'event') {
      this.emit('event', msg.event, msg.payload, msg.ref);
      this.emit(msg.event, msg.payload);
      return;
    }
    if (!msg.id) return;
    const slot = this._pending.get(msg.id);
    if (!slot) return;
    if (msg.kind === 'ack' && !slot.terminalOnAck) return; // intermediate ack for submit/dispatch
    this._pending.delete(msg.id);
    if (msg.ok === false) slot.reject(new Error(msg.error || 'bridge rpc error'));
    else slot.resolve(msg);
  }

  _call(op, extra = {}, terminalOnAck = false) {
    if (!this.sock) return Promise.reject(new Error('BridgeClient: not connected — call connect() first'));
    return new Promise((resolve, reject) => {
      const id = 'g' + (++this._nextId);
      this._pending.set(id, { resolve, reject, terminalOnAck });
      this.sock.write(JSON.stringify({ id, op, ...extra }) + '\n');
    });
  }

  /** Submit a prompt as a fresh turn; resolves with the turn's final result. */
  async submit(prompt) {
    const r = await this._call('submit', { prompt });
    return r.result;
  }

  /** Dispatch a single tool call directly (subject to the bridge's server-side allowlist). */
  async dispatch(name, input = {}) {
    const r = await this._call('dispatch', { name, input });
    return r.result;
  }

  /** Subscribe this connection to event topics (glob-capable, e.g. "tool.*"). */
  async subscribe(topics = ['*']) {
    await this._call('subscribe', { topics }, true);
  }

  /** Cancel an in-flight submit/dispatch by its id. */
  async cancel(ref) {
    await this._call('cancel', { ref }, true);
  }

  /** Say bye and close the socket. Safe to call more than once. */
  async close() {
    if (!this.connected) return;
    try { await this._call('bye', {}, true); } catch { /* best-effort */ }
    this.sock.end();
    this.connected = false;
  }
}

export default BridgeClient;
