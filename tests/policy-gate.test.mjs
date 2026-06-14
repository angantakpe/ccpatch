/**
 * policy-gate.test.mjs
 *
 * Runtime behavior of the policy_gate extension's injected BOOT:
 *  - inert (no throw) when no host module is configured,
 *  - SOFT: installs the host steer via __ccpSetSystemPrompt,
 *  - HARD: registers an __ccpOnFetchBefore gate that honors the host verdict
 *    (allow / scrub / block), and never throws on a bad/throwing policy.
 *
 * We apply() the patch to a tiny shebang stub, strip the hashbang line (illegal
 * inside a Function body), and eval the injected IIFE against stubbed bus
 * globals — mirroring the "IIFE eval must run cleanly" layer of test:patches.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import patch from '../extensions/policy_gate.mjs';

const require = createRequire(import.meta.url);

/** Apply the patch to a shebang stub and return the runnable body (no hashbang). */
function applied() {
  const out = patch.apply('#!/usr/bin/env node\nvoid 0;\n');
  return out.replace(/^#![^\n]*\n/, '');
}

/** Fresh bus stubs + a synchronous setTimeout so the deferred register() runs. */
function makeEnv(envVars, consoleOverride) {
  const calls = { steer: [], before: null, stream: null };
  const g = {
    __ccpGetSystemPromptNonce: () => 'NONCE',
    __ccpSetSystemPrompt: (nonce, s) => { calls.steer.push([nonce, s]); return s; },
    __ccpOnFetchBefore: (name, handler) => { calls.before = { name, handler }; },
    __ccpOnFetchStream: (name, handler) => { calls.stream = { name, handler }; },
  };
  const proc = { env: { ...envVars }, stderr: { write() {} } };
  const syncTimeout = (fn) => { fn(); return 0; };
  // Run the injected source with our stubs in scope.
  const fn = new Function('require', 'process', 'globalThis', 'setTimeout', 'Response', 'console', applied());
  fn(require, proc, g, syncTimeout, Response, consoleOverride || console);
  return calls;
}

/** Capture console.warn lines emitted during boot. */
function captureWarn(envVars) {
  const warnings = [];
  const c = { warn: (...a) => warnings.push(a.join(' ')), error: () => {}, log: () => {} };
  const calls = makeEnv(envVars, c);
  return { calls, warnings };
}

/** Write a temp host policy module and return its absolute path. */
function writePolicy(src) {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-pg-'));
  const p = join(dir, 'policy.cjs');
  writeFileSync(p, src, 'utf8');
  return p;
}

test('inert and non-throwing when no host module is configured', () => {
  const { calls, warnings } = captureWarn({}); // no CCP_POLICY_GATE_MODULE
  assert.equal(calls.steer.length, 0);
  assert.equal(calls.before, null);
  // No module configured ⇒ inert, NOT degraded — must not print the boot warn.
  assert.ok(!warnings.some((w) => /DEGRADED/i.test(w)), `unexpected degrade warn: ${warnings.join('\n')}`);
});

test('SOFT: installs the host steer via the nonce-gated setter', () => {
  const mod = writePolicy(`module.exports = { steer: () => "## day-zero: do not brief on numbers" };`);
  const calls = makeEnv({ CCP_POLICY_GATE_MODULE: mod });
  assert.ok(calls.steer.length >= 1, 'steer should be set at least once');
  const [nonce, text] = calls.steer[0];
  assert.equal(nonce, 'NONCE');
  assert.match(text, /day-zero/);
});

test('HARD: allow leaves the request untouched', async () => {
  const mod = writePolicy(`module.exports = { inspectRequest: () => ({ action: 'allow' }) };`);
  const calls = makeEnv({ CCP_POLICY_GATE_MODULE: mod });
  assert.ok(calls.before, 'gate should register a before-handler');
  const ctx = { url: 'https://api.anthropic.com/v1/messages', isApi: true, options: { body: '{"x":1}' } };
  await calls.before.handler(ctx);
  assert.equal(ctx.options.body, '{"x":1}');
  assert.equal(ctx._intercept, undefined);
});

test('HARD: scrub replaces the outbound body, no intercept', async () => {
  const mod = writePolicy(`module.exports = { inspectRequest: (r) => ({ action: 'scrub', body: r.body.replace('BREACH','') }) };`);
  const calls = makeEnv({ CCP_POLICY_GATE_MODULE: mod });
  const ctx = { url: 'https://api.anthropic.com/v1/messages', isApi: true, options: { body: 'cash BREACH alert' } };
  await calls.before.handler(ctx);
  assert.equal(ctx.options.body, 'cash  alert');
  assert.equal(ctx._intercept, undefined);
});

test('HARD: block short-circuits with a synthetic SSE assistant response', async () => {
  const mod = writePolicy(`module.exports = { inspectRequest: () => ({ action: 'block', message: 'blocked by policy' }) };`);
  const calls = makeEnv({ CCP_POLICY_GATE_MODULE: mod });
  const ctx = { url: 'https://api.anthropic.com/v1/messages', isApi: true, options: { body: '{}' } };
  await calls.before.handler(ctx);
  assert.ok(ctx._intercept instanceof Response, 'block should set ctx._intercept to a Response');
  assert.equal(ctx._intercept.status, 200);
  assert.match(ctx._intercept.headers.get('content-type') || '', /event-stream/);
  const text = await ctx._intercept.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /blocked by policy/);
});

test('non-API requests are ignored by the gate', async () => {
  const mod = writePolicy(`module.exports = { inspectRequest: () => ({ action: 'block', message: 'x' }) };`);
  const calls = makeEnv({ CCP_POLICY_GATE_MODULE: mod });
  const ctx = { url: 'https://example.com/telemetry', isApi: false, options: { body: '{}' } };
  await calls.before.handler(ctx);
  assert.equal(ctx._intercept, undefined);
});

test('fail-open: a throwing policy never throws out of the gate', async () => {
  const mod = writePolicy(`module.exports = { steer: () => { throw new Error('boom'); }, inspectRequest: () => { throw new Error('boom'); } };`);
  const calls = makeEnv({ CCP_POLICY_GATE_MODULE: mod }); // steer throw must be swallowed at boot
  assert.ok(calls.before, 'gate still registers despite a throwing steer');
  const ctx = { url: 'https://api.anthropic.com/v1/messages', isApi: true, options: { body: '{}' } };
  await assert.doesNotReject(async () => calls.before.handler(ctx));
  assert.equal(ctx._intercept, undefined); // threw -> treated as allow
});

// ─────────────────────────────────────────────────────────────────────────────
// Boot probe — loud, one-time, fail-open degradation warning (review fix).
// ─────────────────────────────────────────────────────────────────────────────
test('boot probe: missing module ⇒ loud degrade warn, gate stays fail-open', () => {
  const { calls, warnings } = captureWarn({ CCP_POLICY_GATE_MODULE: '/no/such/policy.cjs' });
  const w = warnings.find((x) => /DEGRADED/i.test(x));
  assert.ok(w, `expected a loud degrade warning; got: ${warnings.join('\n')}`);
  assert.match(w, /NO-GATING|fail-open/i);
  assert.match(w, /\/no\/such\/policy\.cjs/);
  // Fail-open: no gate registered, but boot did not throw.
  assert.equal(calls.before, null);
});

test('boot probe: wrong export shape ⇒ loud degrade warn', () => {
  // Object with none of steer/inspectRequest/onStreamEvent gates nothing.
  const mod = writePolicy(`module.exports = { unrelated: 1 };`);
  const { warnings } = captureWarn({ CCP_POLICY_GATE_MODULE: mod });
  const w = warnings.find((x) => /DEGRADED/i.test(x));
  assert.ok(w, `expected a degrade warning for wrong shape; got: ${warnings.join('\n')}`);
  assert.match(w, /shape/i);
});

test('boot probe: a throwing steer() is announced once at boot', () => {
  const mod = writePolicy(`module.exports = { steer: () => { throw new Error('kaboom'); }, inspectRequest: () => ({ action: 'allow' }) };`);
  const { calls, warnings } = captureWarn({ CCP_POLICY_GATE_MODULE: mod });
  const degrade = warnings.filter((x) => /DEGRADED/i.test(x));
  assert.equal(degrade.length, 1, `expected exactly one boot degrade warn; got: ${warnings.join('\n')}`);
  assert.match(degrade[0], /steer\(\)/);
  // Despite the broken steer, the hard gate still registers (fail-open).
  assert.ok(calls.before, 'inspectRequest gate should still register');
});

test('boot probe: a healthy module does NOT print the degrade warn', () => {
  const mod = writePolicy(`module.exports = { steer: () => "## ok", inspectRequest: () => ({ action: 'allow' }) };`);
  const { calls, warnings } = captureWarn({ CCP_POLICY_GATE_MODULE: mod });
  assert.ok(!warnings.some((w) => /DEGRADED/i.test(w)), `healthy module must not warn; got: ${warnings.join('\n')}`);
  assert.ok(calls.before, 'gate should register for a healthy module');
  assert.ok(calls.steer.length >= 1, 'steer should be installed for a healthy module');
});

// ── FAIL-CLOSED opt-in (review fix) ─────────────────────────────────────────
// CCP_POLICY_GATE_REQUIRED=1 turns a configured-but-degraded gate from silent
// fail-OPEN into a hard BLOCK on every outbound API request, so a typo'd module
// path can never silently disable enforcement.

test('fail-closed: required + missing module BLOCKS every outbound API request', async () => {
  const missing = join(tmpdir(), 'ccp-pg-does-not-exist-' + process.pid + '.cjs');
  const calls = makeEnv({ CCP_POLICY_GATE_MODULE: missing, CCP_POLICY_GATE_REQUIRED: '1' });
  assert.ok(calls.before, 'fail-closed gate must register a before-handler even with no valid module');
  const ctx = { url: 'https://api.anthropic.com/v1/messages', isApi: true, options: { body: '{"x":1}' } };
  await calls.before.handler(ctx);
  assert.ok(ctx._intercept, 'required+degraded gate must intercept (synthetic block) the request');
  // It must be a real Response (the synthetic assistant turn), not a thrown error.
  assert.ok(ctx._intercept instanceof Response, '_intercept should be a synthetic Response');
});

test('fail-closed: a non-API request is NOT blocked (only API calls are gated)', async () => {
  const missing = join(tmpdir(), 'ccp-pg-does-not-exist-2-' + process.pid + '.cjs');
  const calls = makeEnv({ CCP_POLICY_GATE_MODULE: missing, CCP_POLICY_GATE_REQUIRED: '1' });
  const ctx = { url: 'https://example.com/telemetry', isApi: false, options: {} };
  await calls.before.handler(ctx);
  assert.equal(ctx._intercept, undefined, 'non-API requests must pass through even when failing closed');
});

test('fail-open (default): required UNSET ⇒ missing module degrades to no-gating, no block', async () => {
  const missing = join(tmpdir(), 'ccp-pg-does-not-exist-3-' + process.pid + '.cjs');
  const { calls } = captureWarn({ CCP_POLICY_GATE_MODULE: missing }); // no CCP_POLICY_GATE_REQUIRED
  // With no required flag and no valid module, nothing intercepts (fail-open).
  // The before-handler may be absent entirely (nothing to register).
  if (calls.before) {
    const ctx = { url: 'https://api.anthropic.com/v1/messages', isApi: true, options: { body: '{}' } };
    await calls.before.handler(ctx);
    assert.equal(ctx._intercept, undefined, 'fail-open must never block');
  }
});
