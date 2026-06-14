// Security coverage for extensions/adk_user_agents.mjs — the $CCPATCH_AGENTS_DIR /
// ~/.ccpatch/agents ownership+permission gate. The loader must REFUSE to import
// user modules from a directory (or a file) that is group/other-writable or not
// owned by the current uid, because such a path is an arbitrary-code-execution
// vector (anyone who can write there gets full in-process execution).
//
// We exercise the REAL emitted AGENT_CODE end-to-end: lay out a fake
// <bundle>/ccpatch-adk/index.mjs (so the stub's ADK import resolves), drop the
// AGENT_CODE as <bundle>/ccpatch-agents/adk-user-agents.mjs, point
// CCPATCH_AGENTS_DIR at a controlled dir, import the stub, and assert whether the
// planted user module registered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import userAgents from '../extensions/adk_user_agents.mjs';

const POSIX = process.platform !== 'win32' && typeof process.getuid === 'function';

// Minimal ADK stub so the AGENT_CODE's `import('../ccpatch-adk/index.mjs')` and
// `adk.capabilities()` preflight succeed, letting it reach the dir scan.
const ADK_STUB = `
export function capabilities() { return { tools: true, prompt: true, detail: {} }; }
export function defineAgent() {}
export function defineTool() { return { ready: Promise.resolve(true) }; }
export function defineHandoff() {}
`;

// A user module that records it ran by writing a marker file. Path is injected.
function userModule(markerPath) {
  return `
import { writeFileSync } from 'node:fs';
export function register() { writeFileSync(${JSON.stringify(markerPath)}, 'registered'); }
`;
}

// Build a bundle layout in a fresh tmp dir; return { bundle, stubPath }.
function makeLayout() {
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-sec-'));
  fs.mkdirSync(path.join(bundle, 'ccpatch-adk'));
  fs.mkdirSync(path.join(bundle, 'ccpatch-agents'));
  fs.writeFileSync(path.join(bundle, 'ccpatch-adk', 'index.mjs'), ADK_STUB, 'utf8');
  const stubPath = path.join(bundle, 'ccpatch-agents', 'adk-user-agents.mjs');
  fs.writeFileSync(stubPath, userAgents.agentDir.code, 'utf8');
  return { bundle, stubPath };
}

// Import the stub with a given CCPATCH_AGENTS_DIR and wait for its async body to
// settle (the AGENT_CODE is a fire-and-forget async IIFE). We poll briefly for
// the marker; absence after the grace window means "did not register".
async function runStub(stubPath, agentsDir, markerPath) {
  const prev = process.env.CCPATCH_AGENTS_DIR;
  process.env.CCPATCH_AGENTS_DIR = agentsDir;
  try {
    // Cache-bust so each test re-runs the IIFE.
    await import(pathToFileURL(stubPath).href + `?t=${Date.now()}-${Math.random()}`);
    // Give the async IIFE time to scan + (maybe) import. The positive case
    // resolves fast; the negative cases just need enough grace to be sure the
    // module did NOT register.
    for (let i = 0; i < 16; i++) {
      if (fs.existsSync(markerPath)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    if (prev === undefined) delete process.env.CCPATCH_AGENTS_DIR;
    else process.env.CCPATCH_AGENTS_DIR = prev;
  }
  return fs.existsSync(markerPath);
}

test('loads a user module from a private (0700) CCPATCH_AGENTS_DIR', async () => {
  const { bundle, stubPath } = makeLayout();
  try {
    const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-priv-'));
    fs.chmodSync(agentsDir, 0o700);
    const marker = path.join(bundle, 'OK');
    fs.writeFileSync(path.join(agentsDir, 'u.mjs'), userModule(marker), 'utf8');
    if (POSIX) fs.chmodSync(path.join(agentsDir, 'u.mjs'), 0o600);

    const ran = await runStub(stubPath, agentsDir, marker);
    assert.equal(ran, true, 'private dir module should load');
    fs.rmSync(agentsDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(bundle, { recursive: true, force: true });
  }
});

test('REFUSES a world-writable CCPATCH_AGENTS_DIR (ACE vector)', { skip: !POSIX }, async () => {
  const { bundle, stubPath } = makeLayout();
  try {
    const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-ww-'));
    const marker = path.join(bundle, 'BAD');
    fs.writeFileSync(path.join(agentsDir, 'u.mjs'), userModule(marker), 'utf8');
    fs.chmodSync(path.join(agentsDir, 'u.mjs'), 0o600);
    // Make the DIRECTORY group/other-writable — the gate must reject it.
    fs.chmodSync(agentsDir, 0o777);

    const ran = await runStub(stubPath, agentsDir, marker);
    assert.equal(ran, false, 'world-writable dir module must NOT load');
    fs.rmSync(agentsDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(bundle, { recursive: true, force: true });
  }
});

test('REFUSES a world-writable FILE inside an otherwise-safe dir', { skip: !POSIX }, async () => {
  const { bundle, stubPath } = makeLayout();
  try {
    const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-wwf-'));
    fs.chmodSync(agentsDir, 0o700);
    const marker = path.join(bundle, 'BADFILE');
    const f = path.join(agentsDir, 'u.mjs');
    fs.writeFileSync(f, userModule(marker), 'utf8');
    // The file itself is group/other-writable — per-file gate must reject it.
    fs.chmodSync(f, 0o666);

    const ran = await runStub(stubPath, agentsDir, marker);
    assert.equal(ran, false, 'world-writable file must NOT load');
    fs.rmSync(agentsDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(bundle, { recursive: true, force: true });
  }
});
