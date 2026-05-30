#!/usr/bin/env node
/**
 * integration_roundtrip — headless agent-loop + tool-dispatch round-trip
 * against a real patched daemon-profile bundle.
 *
 * smoke_integration.mjs proves the bridge socket binds and the NDJSON protocol
 * round-trips during boot; boot-smoke.test.mjs proves `--version` exits clean.
 * Neither exercises the agent loop, the tool-dispatch path, or the API client —
 * `--version` exits before any of that initializes, and the bridge smoke never
 * drives a query.
 *
 * This tier closes that gap. It boots the patched daemon bundle in `--print`
 * mode with a STUBBED Anthropic API (no network, no credentials) whose first
 * SSE response is a tool_use(Read) block. The bundle's own agent loop must:
 *   1. boot far enough to install the fetch interceptor + expose tool dispatch,
 *   2. issue the first /v1/messages request (turn 1),
 *   3. dispatch the real Read tool against a temp file (tool round-trip),
 *   4. feed the tool_result back in a second /v1/messages request (turn 2),
 *   5. receive the final text response and exit 0.
 *
 * Determinism comes from the request/response handshake — we assert the second
 * request carried a `tool_result` block, which can only happen if the patched
 * CLI actually ran a tool. In parallel we connect the headless bridge, subscribe
 * to the bus, and require at least one tool/turn event to confirm the
 * event-bus + bridge layer observed the same round-trip.
 *
 * The API stub is injected as a `node --import` preload that overwrites
 * globalThis.fetch BEFORE the bundle's fetch_interceptor captures it as
 * __origFetch__, so every /v1/messages call is served locally.
 *
 * Resolution: CCPATCH_INTEGRATION_CLI (must be a daemon-profile bundle) or the
 * newest releases/<v>/cli.v<v>.patched.mjs that contains the bridge sentinel.
 *
 * Exits 0 on success; 1 on assertion failure; 2 on environment problems
 * (no daemon bundle available) so callers can treat 2 as a clean skip.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TIMEOUT_MS = Number(process.env.INTEGRATION_TIMEOUT_MS || 90_000);

const skip = (msg) => { console.error('INTEGRATION SKIP:', msg); process.exit(2); };
const fail = (msg) => { console.error('INTEGRATION FAIL:', msg); process.exit(1); };

// ── Resolve a daemon-profile bundle ────────────────────────────────────────
// The bridge sentinel (__ccpHeadlessBridge_v1) is only present when the bundle
// was built with the daemon/daemon_native profile, which is what this tier
// needs. A standard-profile bundle has no bridge and would never bind a socket.
const BRIDGE_SENTINEL = '__ccpHeadlessBridge_v1';

function hasBridge(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      // Bridge hook is injected near the top (post-shebang / IIFE seam); scan a
      // generous prefix rather than slurping a ~15 MB bundle into memory.
      const buf = Buffer.alloc(2 * 1024 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.slice(0, n).includes(BRIDGE_SENTINEL);
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

function resolveCli() {
  if (process.env.CCPATCH_INTEGRATION_CLI) {
    const p = process.env.CCPATCH_INTEGRATION_CLI;
    if (!fs.existsSync(p)) skip(`CCPATCH_INTEGRATION_CLI not found: ${p}`);
    if (!hasBridge(p)) skip(`CCPATCH_INTEGRATION_CLI is not a daemon-profile bundle (no ${BRIDGE_SENTINEL}); build with --profile daemon`);
    return p;
  }
  const releasesDir = path.join(ROOT, 'releases');
  if (!fs.existsSync(releasesDir)) skip(`no releases/ dir — run \`make patch-daemon\` first`);
  const versions = fs.readdirSync(releasesDir)
    .filter((d) => { try { return fs.statSync(path.join(releasesDir, d)).isDirectory(); } catch { return false; } })
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    const candidate = path.join(releasesDir, v, `cli.v${v}.patched.mjs`);
    if (fs.existsSync(candidate) && hasBridge(candidate)) return candidate;
  }
  skip(`no daemon-profile patched bundle under ${releasesDir}/ — run \`make patch-daemon\` first`);
}

const CLI = resolveCli();
console.error(`[integration] using daemon bundle: ${CLI}`);

// ── Scratch dir: stub preload + the file the agent will Read ────────────────
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-int-'));
const SOCK = path.join(work, 'bridge.sock');
const TOKEN = randomBytes(24).toString('hex');
const STUB_LOG = path.join(work, 'stub.jsonl');
const READ_PATH = path.join(work, 'agent-read-me.txt');
const READ_MARKER = 'CCPATCH-INTEGRATION-ROUNDTRIP-MARKER';
const STUB_MODULE = path.join(work, 'fetch-stub.mjs');

fs.writeFileSync(READ_PATH, READ_MARKER + '\n');

// The preload stub. It replaces globalThis.fetch before the bundle's preload
// runs, so the fetch_interceptor wraps the stub. Only POST /v1/messages to
// anthropic.com is served locally; anything else falls through to real fetch
// (there should be nothing else with telemetry disabled).
fs.writeFileSync(STUB_MODULE, `
import fs from 'node:fs';
const LOG = ${JSON.stringify(STUB_LOG)};
const READ_PATH = ${JSON.stringify(READ_PATH)};
const log = (o) => { try { fs.appendFileSync(LOG, JSON.stringify(o) + '\\n'); } catch {} };
const sse = (events) => new Response(
  events.map((e) => 'event: ' + e.type + '\\ndata: ' + JSON.stringify(e) + '\\n\\n').join(''),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);
let turn = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async function ccpStubFetch(url, options) {
  const urlStr = String((url && url.url) || url || '');
  const isMessages = (options && options.method) === 'POST'
    && /\\/v1\\/messages/.test(urlStr) && urlStr.includes('anthropic.com');
  if (!isMessages) return realFetch(url, options);
  let body = '';
  try { body = typeof (options && options.body) === 'string' ? options.body : ''; } catch {}
  const hasToolResult = body.includes('tool_result');
  turn++;
  log({ turn, hasToolResult });
  if (turn === 1) {
    return sse([
      { type: 'message_start', message: { id: 'msg_stub_1', type: 'message', role: 'assistant', model: 'claude', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_stub_1', name: 'Read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: READ_PATH }) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ]);
  }
  return sse([
    { type: 'message_start', message: { id: 'msg_stub_2', type: 'message', role: 'assistant', model: 'claude', content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'CCPATCH-INTEGRATION-DONE' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]);
};
`);

let cli = null;
const cleanup = () => {
  try { if (cli) cli.kill('SIGKILL'); } catch {}
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// ── Boot the patched daemon bundle in --print mode with the stubbed API ─────
const env = {
  ...process.env,
  CC_BRIDGE_ADDR: `unix:${SOCK}`,
  CC_BRIDGE_TOKEN: TOKEN,
  CCPATCH_PROFILE: 'daemon',
  // A syntactically-valid but fake key: auth never reaches the network because
  // the stub short-circuits /v1/messages.
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'sk-ant-ccpatch-integration-stub',
  // Suppress non-essential traffic so the only POST is the stubbed query.
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CC_DISABLE_TELEMETRY: '1',
};

let cliStderr = '';
cli = spawn(process.execPath, ['--import', STUB_MODULE, CLI, '--print', 'read the file and report back'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let cliStdout = '';
cli.stdout.on('data', (c) => { cliStdout += c.toString('utf8'); });
cli.stderr.on('data', (c) => {
  const s = c.toString('utf8');
  cliStderr += s;
  if (/ReferenceError|SyntaxError|Cannot find|EADDRINUSE/.test(s)) process.stderr.write('[cli stderr] ' + s);
});
const cliExit = new Promise((resolve) => cli.on('close', (code) => resolve(code)));

// ── Connect the bridge and watch the bus for the round-trip ─────────────────
const waitForSocket = () => new Promise((resolve, reject) => {
  const deadline = Date.now() + 30_000;
  const tick = () => {
    if (fs.existsSync(SOCK)) return resolve();
    if (Date.now() > deadline) return reject(new Error(`bridge socket never appeared at ${SOCK} within 30s`));
    setTimeout(tick, 100);
  };
  tick();
});

const watchBus = () => new Promise((resolve, reject) => {
  const sock = net.connect({ path: SOCK });
  const rl = readline.createInterface({ input: sock });
  let id = 0;
  const send = (o) => { try { sock.write(JSON.stringify(o) + '\n'); } catch {} };
  const seen = { turns: 0, toolUse: 0, assistantText: 0 };
  const timer = setTimeout(() => { try { sock.destroy(); } catch {}; resolve(seen); }, TIMEOUT_MS);

  rl.on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.kind === 'event') {
      if (m.event === 'turn.start') seen.turns++;
      if (m.event === 'tool.use' || m.event === 'tool.call') seen.toolUse++;
      if (m.event === 'assistant.text') seen.assistantText++;
      return;
    }
    if (m.kind === 'ack' && m.server) {
      // Authed — subscribe to everything so we observe the loop.
      send({ id: ++id, op: 'subscribe', topics: ['*'] });
    }
  });
  sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  // Resolve when the CLI process exits (round-trip complete) — give the bus a
  // tick to flush the last frames first.
  cliExit.then((code) => {
    setTimeout(() => { clearTimeout(timer); try { sock.end(); } catch {}; resolve({ ...seen, cliCode: code }); }, 200);
  });

  send({ id: ++id, op: 'hello', token: TOKEN });
});

(async () => {
  try {
    await waitForSocket();
    const seen = await watchBus();
    const code = (seen.cliCode != null) ? seen.cliCode : await cliExit;

    // ── Assert the deterministic handshake ─────────────────────────────────
    let turns = [];
    try {
      turns = fs.readFileSync(STUB_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      fail(`stub log missing at ${STUB_LOG} — the bundle never issued a /v1/messages request (agent loop did not run)\ncli stderr:\n${cliStderr.slice(0, 2000)}`);
    }
    if (turns.length < 2) {
      fail(`expected >=2 API turns (request, tool_result, response) but saw ${turns.length}: ${JSON.stringify(turns)}\ncli stdout:\n${cliStdout.slice(0, 500)}\ncli stderr:\n${cliStderr.slice(0, 2000)}`);
    }
    const turn2 = turns.find((t) => t.turn === 2);
    if (!turn2 || !turn2.hasToolResult) {
      fail(`turn 2 request did not carry a tool_result — the patched CLI did not dispatch the Read tool\nturns: ${JSON.stringify(turns)}`);
    }
    if (code !== 0) {
      fail(`patched CLI exited ${code} (expected 0)\ncli stderr:\n${cliStderr.slice(0, 2000)}`);
    }
    // ── Assert the bus/bridge observed the same round-trip ─────────────────
    if (seen.turns < 1 && seen.toolUse < 1) {
      fail(`bridge observed no turn/tool events on the bus (turns=${seen.turns}, toolUse=${seen.toolUse}) — event-bus layer did not see the round-trip`);
    }

    console.log(`OK: patched daemon CLI ran the agent loop + dispatched a tool over ${turns.length} API turns; bridge saw turns=${seen.turns} toolUse=${seen.toolUse} text=${seen.assistantText}`);
    cleanup();
    process.exit(0);
  } catch (e) {
    console.error('INTEGRATION FAIL:', e && e.message);
    console.error('cli stderr:\n' + cliStderr.slice(0, 2000));
    cleanup();
    process.exit(1);
  }
})();
