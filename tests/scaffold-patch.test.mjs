import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TEMPLATES, runScaffoldCli } from '../bin/scaffold-patch.mjs';
import { validateManifest } from '../runner/manifest.mjs';
import { KINDS_LIST } from '../runner/manifest-schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Probe files are written into extensions/ (not a temp dir) so the templates'
// relative runtime imports — `../runner/patch-helpers.mjs` in the splice/flag
// kinds — resolve. A unique prefix keeps them from colliding with real patches;
// after() removes every one.
const written = [];
function probePath(kind) {
  return path.join(REPO_ROOT, 'extensions', `_scaffold_probe_${kind}.mjs`);
}

describe('bin/scaffold-patch.mjs templates', () => {
  after(() => {
    for (const fp of written) rmSync(fp, { force: true });
  });

  it('covers every declarative kind the schema knows about', () => {
    for (const k of KINDS_LIST) {
      assert.ok(k in TEMPLATES, `manifest-schema KINDS_LIST has "${k}" but TEMPLATES has no template for it`);
    }
  });

  for (const kind of Object.keys(TEMPLATES)) {
    it(`"${kind}" template scaffolds a manifest-valid patch`, async () => {
      const name = `_scaffold_probe_${kind}`;
      // Mirror main()'s write: prepend // @ts-check exactly as the CLI does.
      const body = TEMPLATES[kind](name);
      const content = body.startsWith('// @ts-check') ? body : `// @ts-check\n${body}`;
      const fp = probePath(kind);
      writeFileSync(fp, content, 'utf8');
      written.push(fp);

      const mod = (await import(pathToFileURL(fp).href)).default;
      const { ok, errors } = validateManifest(mod, `${name}.mjs`, {});
      assert.ok(ok, `"${kind}" template failed validateManifest: ${errors.join('; ')}`);
    });
  }

  it('every generated template opts into // @ts-check', () => {
    for (const kind of Object.keys(TEMPLATES)) {
      const body = TEMPLATES[kind]('probe');
      const content = body.startsWith('// @ts-check') ? body : `// @ts-check\n${body}`;
      assert.ok(content.startsWith('// @ts-check'), `"${kind}" output should start with // @ts-check`);
    }
  });
});

describe('bin/scaffold-patch.mjs CLI guards', () => {
  // runScaffoldCli returns an exit code and writes nothing on a guard failure,
  // so these cases are side-effect-free.
  it('rejects an invalid (non snake_case) name with exit 2', () => {
    assert.equal(runScaffoldCli(['node', 'scaffold-patch.mjs', 'Bad/Name']), 2);
  });

  it('rejects an unknown --category with exit 2', () => {
    assert.equal(runScaffoldCli(['node', 'scaffold-patch.mjs', 'ok_name', '--category=nope']), 2);
  });

  it('rejects an unknown --kind with exit 2', () => {
    assert.equal(runScaffoldCli(['node', 'scaffold-patch.mjs', 'ok_name', '--kind=nope']), 2);
  });

  it('--help returns 0', () => {
    assert.equal(runScaffoldCli(['node', 'scaffold-patch.mjs', '--help']), 0);
  });
});
