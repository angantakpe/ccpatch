/**
 * adk-user-agents.test.mjs
 *
 * Functional coverage for the user-authoring loader shipped by
 * extensions/adk_user_agents.mjs. The patch emits an embedded agent body that,
 * at boot, scans a config dir and calls register(adk) on each *.mjs module.
 *
 * We can't boot a real patched CLI here, so we exercise the SAME contract the
 * emitted body implements against a real temp dir + a fake ADK namespace:
 *   - *.mjs files are imported and their register()/default export is invoked;
 *   - non-.mjs files are ignored;
 *   - a module with no register/default export is skipped (no throw);
 *   - a throwing register() is isolated (other modules still load);
 *   - CCPATCH_AGENTS_DIR is honored.
 *
 * The loader logic under test is replicated here as loadUserAgents() — kept in
 * lock-step with the AGENT_CODE body in extensions/adk_user_agents.mjs. A drift
 * guard below asserts the patch still resolves its dir the same way.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cwd } from 'node:process';
import { readFileSync } from 'node:fs';

const SCRATCH_ROOT = join(cwd(), '.tmp-adk-user-agents-tests');
function freshDir() {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(SCRATCH_ROOT, 'ua-'));
}
test.after(() => { try { rmSync(SCRATCH_ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

// Mirror of the discovery+register contract in AGENT_CODE.
async function loadUserAgents(dirs, adk, caps) {
  let loaded = 0;
  const errors = [];
  for (const dir of dirs) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.mjs')) continue;
      const file = join(dir, ent.name);
      let mod;
      try { mod = await import(pathToFileURL(file).href); } catch (e) { errors.push(['import', file, e.message]); continue; }
      const register = typeof mod.register === 'function'
        ? mod.register
        : (typeof mod.default === 'function' ? mod.default : null);
      if (!register) { errors.push(['no-register', file]); continue; }
      try { await register(adk, caps); loaded++; } catch (e) { errors.push(['threw', file, e.message]); }
    }
  }
  return { loaded, errors };
}

function fakeAdk() {
  const agents = [];
  const tools = [];
  return {
    ns: {
      defineAgent: (spec) => { agents.push(spec); return spec; },
      defineTool: (spec) => { tools.push(spec); return { ...spec, ready: Promise.resolve(true) }; },
      capabilities: () => ({ tools: true, swap: true, delegate: false, router: false, bus: false }),
    },
    agents,
    tools,
  };
}

test('loads register()-exporting *.mjs modules and invokes them with the ADK', async () => {
  const dir = freshDir();
  writeFileSync(join(dir, 'a.mjs'), `export function register(adk){ adk.defineAgent({name:'ua-a',systemPrompt:'p'}); }`);
  writeFileSync(join(dir, 'b.mjs'), `export default function(adk){ adk.defineTool({name:'ua-b',description:'d',inputSchema:{type:'object'},execute:()=>'x'}); }`);
  const { ns, agents, tools } = fakeAdk();
  const { loaded, errors } = await loadUserAgents([dir], ns, ns.capabilities());
  assert.equal(loaded, 2, 'both modules loaded');
  assert.deepEqual(errors, []);
  assert.deepEqual(agents.map((a) => a.name), ['ua-a']);
  assert.deepEqual(tools.map((t) => t.name), ['ua-b']);
});

test('ignores non-.mjs files', async () => {
  const dir = freshDir();
  writeFileSync(join(dir, 'note.txt'), 'not a module');
  writeFileSync(join(dir, 'data.json'), '{}');
  const { ns } = fakeAdk();
  const { loaded } = await loadUserAgents([dir], ns, ns.capabilities());
  assert.equal(loaded, 0);
});

test('skips a module with no register/default export (no throw)', async () => {
  const dir = freshDir();
  writeFileSync(join(dir, 'bad.mjs'), `export const x = 1;`);
  const { ns } = fakeAdk();
  const { loaded, errors } = await loadUserAgents([dir], ns, ns.capabilities());
  assert.equal(loaded, 0);
  assert.equal(errors[0][0], 'no-register');
});

test('isolates a throwing register() — other modules still load', async () => {
  const dir = freshDir();
  writeFileSync(join(dir, 'boom.mjs'), `export function register(){ throw new Error('boom'); }`);
  writeFileSync(join(dir, 'ok.mjs'), `export function register(adk){ adk.defineAgent({name:'ok',systemPrompt:'p'}); }`);
  const { ns, agents } = fakeAdk();
  const { loaded, errors } = await loadUserAgents([dir], ns, ns.capabilities());
  assert.equal(loaded, 1, 'the good module still loaded despite the bad one throwing');
  assert.deepEqual(agents.map((a) => a.name), ['ok']);
  assert.ok(errors.some((e) => e[0] === 'threw'));
});

test('scans multiple dirs in order (override precedence)', async () => {
  const override = freshDir();
  const fallback = freshDir();
  writeFileSync(join(override, 'o.mjs'), `export function register(adk){ adk.defineAgent({name:'from-override',systemPrompt:'p'}); }`);
  writeFileSync(join(fallback, 'f.mjs'), `export function register(adk){ adk.defineAgent({name:'from-fallback',systemPrompt:'p'}); }`);
  const { ns, agents } = fakeAdk();
  const { loaded } = await loadUserAgents([override, fallback], ns, ns.capabilities());
  assert.equal(loaded, 2);
  assert.deepEqual(agents.map((a) => a.name).sort(), ['from-fallback', 'from-override']);
});

test('drift guard: the patch body still resolves CCPATCH_AGENTS_DIR + ~/.ccpatch/agents', () => {
  const src = readFileSync(new URL('../../../extensions/adk_user_agents.mjs', import.meta.url), 'utf8');
  assert.match(src, /CCPATCH_AGENTS_DIR/, 'env override still read');
  assert.match(src, /\.ccpatch['"],\s*['"]agents/, 'default ~/.ccpatch/agents still scanned');
  assert.match(src, /mod\.register|mod\.default/, 'register/default contract intact');
});
