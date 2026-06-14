import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

import { scanFile } from '../scripts/lint-capabilities.mjs';
import { readPatchCapabilities } from '../runner/capability-reader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Write a throwaway patch file; return its absolute path. */
function fixture(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-cap-lint-'));
  const p = path.join(dir, 'synthetic.mjs');
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

describe('lint-capabilities — scanFile', () => {
  it('flags fetch( without a network declaration', () => {
    const p = fixture('export default { apply: (c) => { fetch("https://x"); return c; } };\n');
    const hits = scanFile(p, []);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].cap, 'network');
  });

  it('passes fetch( when network is declared', () => {
    const p = fixture('export default { capabilities: ["network"], apply: (c) => { fetch("https://x"); return c; } };\n');
    assert.deepEqual(scanFile(p, ['network']), []);
  });

  it('flags a node:fs write shape but not reads', () => {
    const p = fixture('import fs from "node:fs";\nconst a = fs.readFileSync("x");\nfs.writeFileSync("y", a);\n');
    const hits = scanFile(p, []);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].cap, 'fs');
    assert.equal(hits[0].line, 3);
  });

  it('flags child_process import and spawn shapes as exec', () => {
    const p = fixture('import { spawn } from "node:child_process";\nspawn("ls");\n');
    const caps = scanFile(p, []).map(h => h.cap);
    assert.ok(caps.includes('exec'));
  });

  it('does NOT flag RegExp .exec( calls', () => {
    const p = fixture('const m = /x/.exec(code);\nconst n = re.exec(s);\n');
    assert.deepEqual(scanFile(p, []), []);
  });

  it('flags process.env WRITES but not reads', () => {
    const p = fixture('const a = process.env.FOO;\nprocess.env.BAR = "1";\n');
    const hits = scanFile(p, []);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].cap, 'env');
    assert.equal(hits[0].line, 2);
  });

  it('does not flag env equality comparisons', () => {
    const p = fixture('if (process.env.FOO === "1") {}\nif (process.env.BAR == 1) {}\n');
    assert.deepEqual(scanFile(p, []), []);
  });

  it('skips comment-only lines', () => {
    const p = fixture('// fetch("https://example.com") — documented, not executed\n * fetch(also-a-comment)\n');
    assert.deepEqual(scanFile(p, []), []);
  });

  it('flags require/import of node:net|http(s) as network', () => {
    const p = fixture('import net from "node:net";\n');
    const hits = scanFile(p, []);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].cap, 'network');
  });

  it('reports one hit per (capability, pattern) per file', () => {
    const p = fixture('fetch("a");\nfetch("b");\nfetch("c");\n');
    assert.equal(scanFile(p, []).length, 1);
  });
});

// Regression for the capability-gate hole: capture_interactive_request writes
// storage/logs/ but used to declare only ['network'], a real fs gap that the
// lint ALLOWLIST suppressed (so the gate reported OK while a gap shipped). The
// fix declares 'fs' honestly and empties the allowlist. These assertions pin
// that the declaration — not a suppression — is what closes the gap, so a future
// regression (dropping 'fs' from the patch) re-surfaces as a lint hit.
describe('lint-capabilities — capture_interactive_request is honestly declared', () => {
  const real = path.join(ROOT, 'extensions/capture_interactive_request.mjs');

  it('declares fs (its injected capture does mkdirSync + writeFileSync)', () => {
    const caps = readPatchCapabilities(real);
    assert.ok(caps.includes('fs'), `expected 'fs' in declared caps, got [${caps.join(', ')}]`);
    assert.ok(caps.includes('network'), `expected 'network' in declared caps, got [${caps.join(', ')}]`);
  });

  it('would be flagged for fs if it only declared network (the gap is real)', () => {
    const hits = scanFile(real, ['network']);
    assert.ok(hits.some(h => h.cap === 'fs'), 'expected an fs hit under the old network-only declaration');
  });

  it('is clean once scanned against its real declared capabilities (no allowlist needed)', () => {
    const caps = readPatchCapabilities(real);
    assert.deepEqual(scanFile(real, caps), []);
  });
});
