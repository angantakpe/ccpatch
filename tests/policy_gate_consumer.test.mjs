/**
 * policy_gate_consumer.test.mjs — end-to-end contract test for `policy_gate`
 * wired to the shipped reference consumer (`consumers/policy_gate.reference.cjs`).
 *
 * This is the proof that the patch is EXERCISED, not just present. It loads the
 * real boot block produced by `extensions/policy_gate.mjs`, points
 * CCP_POLICY_GATE_MODULE at the reference consumer, runs the block in a vm
 * sandbox with stubbed `__ccp*` bus globals, and asserts the FULL contract
 * actually fires through those buses:
 *
 *   - steer()           -> overlay installed via __ccpSetSystemPrompt(nonce, str)
 *   - inspectRequest()  -> allow / scrub (body replaced) / block (synthetic
 *                          short-circuit via ctx._intercept) honored through
 *                          __ccpOnFetchBefore
 *   - onStreamEvent()   -> abort honored through __ccpOnFetchStream
 *
 * Non-vacuity: a companion case loads the SAME boot block with NO consumer
 * configured and asserts NONE of the gating fires — so this test is red without
 * the consumer wired and green with it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PATCH_PATH = resolve(ROOT, 'extensions/policy_gate.mjs');
const CONSUMER_PATH = resolve(ROOT, 'consumers/policy_gate.reference.cjs');

// The CJS-IIFE header spliceBoot() injects before. A minimal fixture carrying it
// lets us recover the exact boot block the patch produces, without a real bundle.
const CJS_IIFE = '(function(exports, require, module, __filename, __dirname)';
const FIXTURE = `${CJS_IIFE}{ /* bundle body */ }\n`;

/** Load the patch and recover the injected boot block by diffing apply() output. */
async function getBootBlock() {
  const mod = await import(pathToFileURL(PATCH_PATH).href);
  const patch = mod.default ?? mod;
  const out = patch.apply(FIXTURE);
  assert.notEqual(out, FIXTURE, 'policy_gate.apply must mutate the fixture');
  const idx = out.indexOf(CJS_IIFE);
  assert.ok(idx > 0, 'boot block must be spliced BEFORE the CJS-IIFE header');
  return out.slice(0, idx);
}

/**
 * Build a sandbox that records every bus interaction the boot block performs.
 * `env` becomes process.env. Returns { sandbox, rec } where `rec` captures the
 * registered before/stream hooks and system-prompt writes.
 */
function makeGateSandbox(env) {
  const rec = {
    beforeHooks: [], // { label, fn, priority }
    streamHooks: [], // { label, fn }
    systemPrompts: [], // { nonce, value }
    warnings: [],
    errors: [],
  };
  const realRequire = createRequire(PATCH_PATH);

  const sandbox = {
    console: {
      log() {},
      warn(...a) { rec.warnings.push(a.join(' ')); },
      error(...a) { rec.errors.push(a.join(' ')); },
    },
    // register() runs synchronously inside the IIFE; setTimeout is a no-op so we
    // don't double-register. The sync path is enough because the bus globals are
    // present up-front in this sandbox.
    setTimeout: () => 0,
    clearTimeout: () => {},
    process: {
      env: { ...env },
      argv: [],
      versions: { node: '20.0.0' },
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    },
    require: realRequire,
    URL,
    Response,
    // expose_system_prompt bus
    __ccpGetSystemPromptNonce: () => 'test-nonce',
    __ccpSetSystemPrompt: (nonce, value) => { rec.systemPrompts.push({ nonce, value }); },
    // fetch_interceptor buses
    __ccpOnFetchBefore: (label, fn, priority) => {
      rec.beforeHooks.push({ label, fn, priority });
      return () => {};
    },
    __ccpOnFetchStream: (label, fn) => {
      rec.streamHooks.push({ label, fn });
      return () => {};
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return { sandbox, rec };
}

/** Run the boot block in a recording sandbox with the given env. */
function runBoot(block, env) {
  const { sandbox, rec } = makeGateSandbox(env);
  new vm.Script(block).runInContext(sandbox);
  return { sandbox, rec };
}

/** Find the policy_gate before-hook (not the fail-closed one). */
function gateBeforeHook(rec) {
  return rec.beforeHooks.find((h) => h.label === 'policy_gate');
}

test('policy_gate + reference consumer — steer overlay installed via __ccpSetSystemPrompt', async () => {
  const block = await getBootBlock();
  const { rec } = runBoot(block, { CCP_POLICY_GATE_MODULE: CONSUMER_PATH });

  assert.ok(rec.systemPrompts.length >= 1, 'steer() overlay must be installed at boot');
  const last = rec.systemPrompts[rec.systemPrompts.length - 1];
  assert.equal(last.nonce, 'test-nonce', 'overlay must be written with the gated nonce');
  assert.match(last.value, /Policy gate \(reference consumer\)/, 'overlay must carry the house rules');
});

test('policy_gate + reference consumer — inspectRequest ALLOW passes through unchanged', async () => {
  const block = await getBootBlock();
  const { rec } = runBoot(block, { CCP_POLICY_GATE_MODULE: CONSUMER_PATH });

  const hook = gateBeforeHook(rec);
  assert.ok(hook, 'policy_gate before-hook must be registered');

  const ctx = {
    isApi: true,
    url: 'https://api.anthropic.com/v1/messages',
    options: { body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) },
  };
  const originalBody = ctx.options.body;
  hook.fn(ctx);

  assert.equal(ctx._intercept, undefined, 'allow must NOT short-circuit');
  assert.equal(ctx.options.body, originalBody, 'allow must NOT mutate the body');
});

test('policy_gate + reference consumer — inspectRequest SCRUB replaces the outgoing body', async () => {
  const block = await getBootBlock();
  const { rec } = runBoot(block, { CCP_POLICY_GATE_MODULE: CONSUMER_PATH });

  const hook = gateBeforeHook(rec);
  assert.ok(hook, 'policy_gate before-hook must be registered');

  const secret = 'sk-ABCDEFGHIJ0123456789';
  const ctx = {
    isApi: true,
    url: 'https://api.anthropic.com/v1/messages',
    options: { body: JSON.stringify({ messages: [{ role: 'user', content: 'my key is ' + secret }] }) },
  };
  hook.fn(ctx);

  assert.equal(ctx._intercept, undefined, 'scrub must not short-circuit');
  assert.ok(!ctx.options.body.includes(secret), 'scrub must remove the secret from the outgoing body');
  assert.match(ctx.options.body, /\[REDACTED-BY-POLICY-GATE\]/, 'scrub must insert the redaction marker');
});

test('policy_gate + reference consumer — inspectRequest BLOCK short-circuits with a synthetic turn', async () => {
  const block = await getBootBlock();
  const { rec } = runBoot(block, { CCP_POLICY_GATE_MODULE: CONSUMER_PATH });

  const hook = gateBeforeHook(rec);
  assert.ok(hook, 'policy_gate before-hook must be registered');

  const ctx = {
    isApi: true,
    url: 'https://blocked.example.invalid/v1/messages',
    options: { body: '{}' },
  };
  hook.fn(ctx);

  assert.ok(ctx._intercept instanceof Response, 'block must install a synthetic Response on ctx._intercept');
  const text = await ctx._intercept.text();
  assert.match(text, /blocked by the reference policy gate/, 'synthetic turn must carry the block message');
  assert.match(text, /content_block_delta/, 'synthetic turn must be a valid SSE assistant stream');
});

test('policy_gate + reference consumer — onStreamEvent abort honored via __ccpOnFetchStream', async () => {
  const block = await getBootBlock();
  const { rec } = runBoot(block, { CCP_POLICY_GATE_MODULE: CONSUMER_PATH });

  assert.ok(rec.streamHooks.length >= 1, 'stream hook must be registered');
  const sh = rec.streamHooks.find((h) => h.label === 'policy_gate');
  assert.ok(sh, 'policy_gate stream hook must be registered');

  let aborted = 0;
  const abortFn = () => { aborted++; };

  // The reference consumer reads CCP_POLICY_REF_BANNED_TOKEN at call time from
  // ITS OWN process scope (the consumer is loaded by the real Node require, so it
  // closes over the real process.env, not the sandbox env). The default banned
  // token is 'BANNED_DEMO_TOKEN' — exercise that default here.
  const BANNED = 'BANNED_DEMO_TOKEN';

  // Benign event — no abort.
  sh.fn({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello world' } }, abortFn);
  assert.equal(aborted, 0, 'benign stream event must not abort');

  // Banned token — abort.
  sh.fn({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'about to ' + BANNED } }, abortFn);
  assert.equal(aborted, 1, 'banned-token stream event must abort the stream');
});

test('policy_gate non-vacuity — with NO consumer configured the gate is inert', async () => {
  const block = await getBootBlock();
  const { rec } = runBoot(block, {}); // no CCP_POLICY_GATE_MODULE

  assert.equal(rec.systemPrompts.length, 0, 'no steer overlay must be installed when inert');
  assert.equal(gateBeforeHook(rec), undefined, 'no policy_gate before-hook must be registered when inert');
  assert.equal(
    rec.streamHooks.find((h) => h.label === 'policy_gate'),
    undefined,
    'no policy_gate stream hook must be registered when inert',
  );
  assert.equal(rec.warnings.length, 0, 'an unset module is inert, not degraded — no boot warning');
});
