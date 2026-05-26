#!/usr/bin/env node
/**
 * bridge_host — boot the headless_bridge runtime hook in a stub host so the
 * ccpatch-bridge CLI client (and curl/nc) can talk to it. No patched Claude
 * Code CLI required — useful for protocol-level prodding during development.
 *
 * Required env:
 *   CC_BRIDGE_ADDR    unix:/tmp/foo.sock | tcp://127.0.0.1:7878
 *   CC_BRIDGE_TOKEN   shared secret (used to gate the hello frame)
 *
 * The stub implementations of __ccpSubmitInput / __ccpInvokeTool emit a
 * representative event sequence so subscribers see realistic frames:
 *   turn.start → tool.call → tool.result → (optional agent.spawn/exit + nested
 *   tool.call with agent_path) → turn.end → submit-result frame.
 *
 * Stays running until SIGINT. Use `make bridge-host-stop` to clean up the
 * socket file if a previous run died abnormally.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

if (!process.env.CC_BRIDGE_ADDR || !process.env.CC_BRIDGE_TOKEN) {
  console.error('bridge_host: CC_BRIDGE_ADDR and CC_BRIDGE_TOKEN are required');
  process.exit(2);
}

// Pull the real runtime hook out of each extension by running its apply() on
// a stub bundle, then slicing the injected block between the markers. Same
// technique as tests/smoke_bridge.mjs.
const stubShebang = '#!/usr/bin/env node';
const stubMarker = '// stub\n';
const stub = stubShebang + '\n' + stubMarker;

const extractHook = (mod) => {
  const out = mod.default.apply(stub);
  return out.slice(stubShebang.length, out.indexOf(stubMarker));
};

const busMod    = await import(path.join(ROOT, 'extensions/event_bus.mjs'));
const authMod   = await import(path.join(ROOT, 'extensions/auth_token.mjs'));
const bridgeMod = await import(path.join(ROOT, 'extensions/headless_bridge.mjs'));

globalThis.require = require;

// Load event_bus and auth_token hooks first so the bridge can find them.
(0, eval)(extractHook(busMod));
(0, eval)(extractHook(authMod));

// Stub the two cli-side globals the bridge depends on.
globalThis.__ccpSubmitInput = async (prompt) => {
  const bus = globalThis.__ccpBus;
  bus.emit('turn.start', { id: 't1', prompt });
  bus.emit('tool.call',   { id: 'tc1', agent_path: 'root', name: 'Read', input: { p: '/etc/hostname' } });
  bus.emit('tool.result', { id: 'tc1', agent_path: 'root', name: 'Read', ok: true, bytes: 12 });
  // Simulate a subagent spawn + nested tool call so consumers can see the
  // agent_path threading.
  const child_id = 'agent-' + Math.random().toString(36).slice(2, 8);
  bus.emit('agent.spawn', { parent_id: 'root', child_id, prompt: 'sub-task' });
  bus.emit('tool.call',   { id: 'tc2', agent_path: 'root/' + child_id, name: 'Grep', input: { q: 'x' } });
  bus.emit('tool.result', { id: 'tc2', agent_path: 'root/' + child_id, name: 'Grep', ok: true, bytes: 32 });
  bus.emit('agent.exit',  { id: child_id, ok: true, usage: { in: 10, out: 20 } });
  bus.emit('turn.end',    { id: 't1', usage: { in: 30, out: 40 } });
  return { final: 'echo:' + prompt };
};
globalThis.__ccpInvokeTool = async (name, input) => ({ tool: name, echoed: input });

// Boot the bridge.
(0, eval)(extractHook(bridgeMod));

console.error(`[bridge_host] listening on ${process.env.CC_BRIDGE_ADDR} (token from CC_BRIDGE_TOKEN)`);
console.error('[bridge_host] Ctrl-C to stop.');

// Keep the process alive.
const keepalive = setInterval(() => {}, 60_000);
process.on('SIGINT', () => { clearInterval(keepalive); process.exit(0); });
process.on('SIGTERM', () => { clearInterval(keepalive); process.exit(0); });
