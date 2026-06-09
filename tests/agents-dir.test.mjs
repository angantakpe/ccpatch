// Regression coverage for runner/agents-dir-builder.mjs — the agentDir collection,
// ADK runtime copy, and ccpatch-agents/ emission that wire @codehornets/adk into a
// patched session. Before this, emitAgentsDir had no callers and no tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  collectAgentDirPatches,
  emitAgentsDir,
  emitAdkRuntime,
} from '../runner/agents-dir-builder.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-agents-'));
}

test('collectAgentDirPatches picks only patches with a valid agentDir, in order', () => {
  const patches = {
    a: { agentDir: { name: 'agent-a', code: '// a' } },
    b: { /* no agentDir */ },
    c: { agentDir: { name: '', code: '// bad name' } },
    d: { agentDir: { name: 'agent-d', code: '' } },
    e: { agentDir: { name: 'agent-e', code: '// e' } },
  };
  const out = collectAgentDirPatches(patches, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(out, [
    { name: 'agent-a', code: '// a' },
    { name: 'agent-e', code: '// e' },
  ]);
});

test('collectAgentDirPatches respects the given name order', () => {
  const patches = {
    x: { agentDir: { name: 'agent-x', code: '// x' } },
    y: { agentDir: { name: 'agent-y', code: '// y' } },
  };
  const out = collectAgentDirPatches(patches, ['y', 'x']);
  assert.deepEqual(out.map((e) => e.name), ['agent-y', 'agent-x']);
});

test('emitAgentsDir writes each agent file plus a matching .sha256 sidecar', () => {
  const dir = tmpDir();
  const code = "// hello\nexport default 1;\n";
  const written = emitAgentsDir([{ name: 'adk-hello', code }], dir);

  assert.equal(written.length, 1);
  const f = path.join(dir, 'ccpatch-agents', 'adk-hello.mjs');
  assert.equal(written[0], f);
  assert.equal(fs.readFileSync(f, 'utf8'), code);

  const want = createHash('sha256').update(code, 'utf8').digest('hex');
  assert.equal(fs.readFileSync(f + '.sha256', 'utf8').trim(), want);
});

test('emitAgentsDir is a no-op on empty/invalid input', () => {
  const dir = tmpDir();
  assert.deepEqual(emitAgentsDir([], dir), []);
  assert.deepEqual(emitAgentsDir(null, dir), []);
  assert.equal(fs.existsSync(path.join(dir, 'ccpatch-agents')), false);
});

test('emitAdkRuntime copies the ADK runtime files with integrity sidecars', () => {
  const dir = tmpDir();
  const written = emitAdkRuntime(dir);

  // The repo ships the ADK at packages/adk, so the copy must succeed here.
  assert.ok(written.length >= 5, `expected >=5 ADK files, got ${written.length}`);

  const adkDir = path.join(dir, 'ccpatch-adk');
  for (const f of written) {
    assert.equal(path.dirname(f), adkDir);
    // Sidecar exists and matches the copied bytes.
    const want = createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    assert.equal(fs.readFileSync(f + '.sha256', 'utf8').trim(), want);
  }
  // index.mjs (the ADK entry the agent imports) must be present.
  assert.ok(written.some((f) => path.basename(f) === 'index.mjs'));
});
