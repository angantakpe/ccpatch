/**
 * BridgeClient smoke test — proves the reusable client actually speaks the
 * headless_bridge NDJSON protocol correctly, against a real socket.
 *
 * Reuses the repo's existing fixture, tests/bridge_host.mjs, which boots the
 * real headless_bridge runtime hook (extracted from extensions/headless_bridge.mjs)
 * in a stub host with fake __ccpSubmitInput/__ccpInvokeTool — no patched
 * Claude Code CLI required. Do not duplicate that fixture here; it's already
 * the canonical protocol-level test double (see tests/smoke_bridge.mjs for
 * the equivalent inline check this generalizes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { BridgeClient } from '../bridge-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const BRIDGE_HOST = path.join(REPO_ROOT, 'tests/bridge_host.mjs');

const waitForSocket = (sockPath, timeoutMs = 5000) => new Promise((resolve, reject) => {
  const deadline = Date.now() + timeoutMs;
  const tick = () => {
    if (fs.existsSync(sockPath)) return resolve();
    if (Date.now() > deadline) return reject(new Error('bridge_host: socket never appeared'));
    setTimeout(tick, 50);
  };
  tick();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('BridgeClient: hello -> subscribe -> submit -> event stream -> close against a real headless_bridge socket', async () => {
  const sockPath = path.join(os.tmpdir(), `ccpatch-gateway-smoke-${process.pid}.sock`);
  const token = randomBytes(24).toString('hex');
  try { fs.unlinkSync(sockPath); } catch { /* fine if it doesn't exist */ }

  const host = spawn(process.execPath, [BRIDGE_HOST], {
    cwd: REPO_ROOT,
    env: { ...process.env, CC_BRIDGE_ADDR: `unix:${sockPath}`, CC_BRIDGE_TOKEN: token },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let hostStderr = '';
  host.stderr.on('data', (d) => { hostStderr += d.toString(); });

  const bridge = new BridgeClient({ addr: `unix:${sockPath}`, token });

  try {
    await waitForSocket(sockPath);

    const events = [];
    bridge.on('event', (topic, payload) => events.push({ topic, payload }));

    await bridge.connect();
    await bridge.subscribe(['turn.start', 'turn.end', 'tool.call', 'tool.result']);

    const result = await bridge.submit('hello from gateway smoke test');
    assert.equal(result.final, 'echo:hello from gateway smoke test');

    // bridge_host's stub emits its events synchronously before returning the
    // submit result, but give the socket one tick to flush the last lines —
    // same margin tests/smoke_bridge.mjs uses for the same reason.
    await sleep(50);

    const topics = events.map((e) => e.topic);
    assert.ok(topics.includes('turn.start'), `expected turn.start among: ${topics.join(',')}`);
    assert.ok(topics.includes('turn.end'), `expected turn.end among: ${topics.join(',')}`);
    assert.ok(topics.includes('tool.call'), `expected tool.call among: ${topics.join(',')}`);
    assert.ok(topics.includes('tool.result'), `expected tool.result among: ${topics.join(',')}`);

    await bridge.close();
  } catch (e) {
    if (hostStderr) e.message += `\n--- bridge_host stderr ---\n${hostStderr}`;
    throw e;
  } finally {
    host.kill('SIGTERM');
    try { fs.unlinkSync(sockPath); } catch { /* already gone */ }
  }
});
