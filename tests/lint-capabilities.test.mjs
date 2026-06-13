import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanFile } from '../scripts/lint-capabilities.mjs';

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
