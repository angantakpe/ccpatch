/**
 * fetch-response-fidelity.test.mjs
 *
 * The fetch_interceptor's _ccpFanOut tees an SSE body and returns a fresh
 * `new Response(tee[0], …)`. The Response(body, init) constructor cannot carry
 * url / redirected / type (fetch sets them internally), so before the fidelity
 * fix the wrapped response reported url='' — silently breaking bundle code
 * that checks response.url.
 *
 * These tests run the real injected hook (patch.preloadCode) in a child
 * process with a stubbed original fetch and assert the wrapped Response
 * delegates url / redirected / type to the original while the teed body stays
 * readable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { default: fetchInterceptor } = await import('../core/fetch_interceptor.mjs');

function runDriver(body) {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-fid-'));
  const script = join(dir, 'driver.mjs');
  // Stub the original fetch BEFORE the hook installs, so __origFetch__ is ours.
  writeFileSync(script, body.replace('__CCP_HOOK__', () => fetchInterceptor.preloadCode));
  const res = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 20_000 });
  rmSync(dir, { recursive: true, force: true });
  return res;
}

const COMMON_PREAMBLE = `
function makeOriginal() {
  const sse = 'data: {"type":"message_start"}\\n\\ndata: {"type":"message_stop"}\\n\\n';
  const body = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); },
  });
  const orig = new Response(body, { status: 200, statusText: 'OK', headers: { 'x-probe': 'kept' } });
  Object.defineProperty(orig, 'url', { get: () => 'https://api.anthropic.com/v1/messages' });
  Object.defineProperty(orig, 'redirected', { get: () => true });
  Object.defineProperty(orig, 'type', { get: () => 'basic' });
  return orig;
}
`;

test('fidelity — wrapped Response preserves url, redirected, and type from the original', () => {
  const res = runDriver(`
${COMMON_PREAMBLE}
const orig = makeOriginal();
globalThis.fetch = async () => orig;
__CCP_HOOK__
// An after-subscriber forces the tee/fan-out (wrapped Response) path.
globalThis.__ccpOnFetch('fidelity-probe', () => {});
const resp = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST' });
if (resp === orig) throw new Error('expected a wrapped Response, got the original (tee path not taken)');
if (resp.url !== 'https://api.anthropic.com/v1/messages') throw new Error('url dropped: ' + JSON.stringify(resp.url));
if (resp.redirected !== true) throw new Error('redirected dropped: ' + resp.redirected);
if (resp.type !== 'basic') throw new Error('type dropped: ' + resp.type);
if (resp.status !== 200) throw new Error('status mismatch');
if (resp.headers.get('x-probe') !== 'kept') throw new Error('headers dropped');
const text = await resp.text();
if (!text.includes('message_start') || !text.includes('message_stop')) {
  throw new Error('teed body not intact: ' + JSON.stringify(text));
}
console.log('FIDELITY-OK');
`);
  assert.equal(res.status, 0, `driver failed\nstderr: ${res.stderr}\nstdout: ${res.stdout}`);
  assert.match(res.stdout, /FIDELITY-OK/);
});

test('fidelity — non-API responses still pass through as the original object', () => {
  const res = runDriver(`
${COMMON_PREAMBLE}
const orig = makeOriginal();
globalThis.fetch = async () => orig;
__CCP_HOOK__
globalThis.__ccpOnFetch('fidelity-probe', () => {});
// GET → _ccpIsApiCall false → fan-out hands the original back untouched.
const resp = await fetch('https://example.com/asset', { method: 'GET' });
if (resp !== orig) throw new Error('non-API path must return the original Response');
console.log('PASSTHROUGH-OK');
`);
  assert.equal(res.status, 0, `driver failed\nstderr: ${res.stderr}\nstdout: ${res.stdout}`);
  assert.match(res.stdout, /PASSTHROUGH-OK/);
});

test('fidelity — verify token count unchanged (sentinel appears exactly twice in hook source)', () => {
  // The patch declares verify { present: <sentinel>, count: { present: 2 } }.
  // The fidelity fix must not add occurrences of the sentinel token.
  const sentinel = fetchInterceptor.verify.present;
  const n = fetchInterceptor.preloadCode.split(sentinel).length - 1;
  assert.equal(n, fetchInterceptor.verify.count.present);
});
