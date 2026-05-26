/**
 * headless_bridge — NDJSON over Unix socket (or TCP) for driving the
 * running CLI from outside the terminal.
 *
 * One long-lived connection; one JSON object per line; bidirectional.
 *
 * Client → server ops (must hello first):
 *   { id, op:"hello", token }
 *   { id, op:"submit", prompt }
 *   { id, op:"dispatch", name, input }
 *   { id, op:"subscribe", topics:[ "tool.*", "turn.*", ... ] }
 *   { id, op:"cancel", ref }
 *   { id, op:"bye" }
 *
 * Server → client frames:
 *   { id, ok:true,  kind:"ack",    server:{...} }
 *   { id, ok:true,  kind:"result", result:... }
 *   { id, ok:false, kind:"error",  error:"..." }
 *   { ref?, kind:"event", event:"<topic>", payload:{...} }
 *   { id, ok:true,  kind:"bye" }
 *
 * Bind via CC_BRIDGE_ADDR:
 *   unix:/run/ccpatch.sock      (recommended; filesystem perms gate access)
 *   tcp://127.0.0.1:7878        (loopback only — not bound publicly)
 *
 * Auth: globalThis.__ccpAuth.verify(token) — constant-time compare.
 */
export default {
  category: 'feature',
  description: 'NDJSON bridge into the running CLI (submit/dispatch/subscribe/cancel).',
  capabilities: ['network', 'prompt', 'tools'],
  dependsOn: ['event_bus', 'auth_token', 'expose_submit_input', 'expose_tool_dispatch'],
  verify: { present: '__ccpHeadlessBridge_v1', count: { present: 1 } },
  apply: (code) => {
    const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] headless_bridge — NDJSON socket
// ══════════════════════════════════════════════════════════════════════════
(() => {
  if (globalThis.__ccpHeadlessBridge_v1) return;
  if (!process.env.CC_BRIDGE_ADDR) return;
  globalThis.__ccpHeadlessBridge_v1 = true;
  // See auth_token for the same require-resolution dance.
  const __req = (typeof globalThis.__hm_require === 'function')
    ? globalThis.__hm_require
    : (typeof require === 'function' ? require : null);
  if (!__req) { console.warn('[ccpatch] headless_bridge: no require available — skipping'); return; }
  const net = __req('node:net');
  const ADDR = process.env.CC_BRIDGE_ADDR;
  const MAX_LINE = Number(process.env.CC_BRIDGE_MAX_LINE || 1048576);
  const TOPICS = ['turn.start','turn.end','tool.call','tool.result','agent.spawn','agent.exit','cost.delta'];

  const server = net.createServer((sock) => {
    let buf = '';
    let authed = false;
    const subs = new Map();        // topic -> off()
    const inflight = new Map();    // id -> { cancel }

    const send = (obj) => {
      try { sock.write(JSON.stringify(obj) + '\\n'); } catch (_) {}
    };

    const subscribe = (topics) => {
      if (!globalThis.__ccpBus) return;
      for (const t of (topics || [])) {
        if (subs.has(t)) continue;
        const off = globalThis.__ccpBus.on(t, (payload, topic) => {
          send({ kind: 'event', event: topic || t, payload });
        });
        subs.set(t, off);
      }
    };

    const unsubAll = () => {
      for (const off of subs.values()) { try { off(); } catch (_) {} }
      subs.clear();
    };

    const handle = async (line) => {
      let msg;
      try { msg = JSON.parse(line); }
      catch (_) { return send({ kind: 'error', error: 'bad json' }); }
      const { id, op } = msg;
      if (!authed) {
        if (op !== 'hello' || !globalThis.__ccpAuth || !globalThis.__ccpAuth.verify(msg.token)) {
          send({ id, ok: false, kind: 'error', error: 'auth' });
          return sock.destroy();
        }
        authed = true;
        return send({
          id, ok: true, kind: 'ack',
          server: {
            profile: process.env.CCPATCH_PROFILE || null,
            topics: TOPICS,
            pid: process.pid,
          },
        });
      }
      switch (op) {
        case 'submit': {
          if (typeof globalThis.__ccpSubmitInput !== 'function') {
            return send({ id, ok: false, kind: 'error', error: 'submit not exposed' });
          }
          const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
          inflight.set(id, { cancel: () => { try { ctrl && ctrl.abort(); } catch (_) {} } });
          send({ id, ok: true, kind: 'ack' });
          try {
            const result = await globalThis.__ccpSubmitInput(msg.prompt, {
              signal: ctrl ? ctrl.signal : undefined,
              requestId: id,
            });
            send({ id, ok: true, kind: 'result', result: (result == null ? null : result) });
          } catch (e) {
            send({ id, ok: false, kind: 'error', error: String(e && e.message || e) });
          } finally {
            inflight.delete(id);
          }
          return;
        }
        case 'dispatch': {
          if (typeof globalThis.__ccpInvokeTool !== 'function') {
            return send({ id, ok: false, kind: 'error', error: 'dispatch not exposed' });
          }
          try {
            const result = await globalThis.__ccpInvokeTool(msg.name, msg.input);
            return send({ id, ok: true, kind: 'result', result });
          } catch (e) {
            return send({ id, ok: false, kind: 'error', error: String(e && e.message || e) });
          }
        }
        case 'subscribe':
          subscribe(msg.topics && msg.topics.length ? msg.topics : TOPICS);
          return send({ id, ok: true, kind: 'ack' });
        case 'cancel': {
          const slot = inflight.get(msg.ref);
          if (slot) slot.cancel();
          return send({ id, ok: true, kind: 'ack' });
        }
        case 'bye':
          send({ id, ok: true, kind: 'bye' });
          return sock.end();
        default:
          return send({ id, ok: false, kind: 'error', error: 'unknown op' });
      }
    };

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.length) handle(line);
        if (buf.length > MAX_LINE) {
          send({ kind: 'error', error: 'line too long' });
          return sock.destroy();
        }
      }
      if (buf.length > MAX_LINE) {
        send({ kind: 'error', error: 'line too long' });
        return sock.destroy();
      }
    });

    sock.on('close', () => {
      unsubAll();
      for (const { cancel } of inflight.values()) { try { cancel(); } catch (_) {} }
      inflight.clear();
    });
    sock.on('error', () => { /* swallow client noise */ });
  });

  server.on('error', (e) => {
    console.error('[ccpatch] headless_bridge: server error', e && e.message);
  });

  if (ADDR.startsWith('unix:')) {
    const fs = __req('node:fs');
    const sockPath = ADDR.slice(5);
    try { fs.unlinkSync(sockPath); } catch (_) {}
    server.listen(sockPath, () => {
      try { fs.chmodSync(sockPath, 0o600); } catch (_) {}
    });
    process.on('exit', () => { try { fs.unlinkSync(sockPath); } catch (_) {} });
  } else if (ADDR.startsWith('tcp://')) {
    const [host, port] = ADDR.slice(6).split(':');
    server.listen(Number(port), host || '127.0.0.1');
  } else {
    console.warn('[ccpatch] headless_bridge: invalid CC_BRIDGE_ADDR (use unix: or tcp://)');
  }
})();
`;
    const SHEBANG = '#!/usr/bin/env node';
    const IIFE = '(function(exports, require, module, __filename, __dirname)';
    if (code.includes(SHEBANG)) return code.replace(SHEBANG, () => SHEBANG + '\n' + hook);
    if (code.includes(IIFE)) return code.replace(IIFE, () => hook + IIFE);
    console.warn('  [!] headless_bridge: anchor not found — skipping');
    return code;
  },
};
