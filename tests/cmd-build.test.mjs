// tests/cmd-build.test.mjs — end-to-end tests for the `ccpatch build` (default,
// no-subcommand) command: argument parsing (parseBuildArgs) and the apply
// pipeline (runBuild) driven with synthetic patches against a synthetic bundle.
//
// The build is exercised WITHOUT a real Claude Code bundle: a tiny hand-written
// JS bundle + synthetic patch objects flow through the same runBuild path the
// CLI dispatches to, so the patched output, the .sha256 sidecar, and (under
// --emit-revert) the reverse-diff sidecar are all asserted concretely.
//
// Coverage:
//   - parseBuildArgs: positionals, --patch comma-split, --strict/--dry-run,
//     and the flag-in-a-positional-slot error guard.
//   - runBuild: writes a patched bundle that contains the injected sentinel,
//     plus a .sha256 sidecar; exit code 0.
//   - runBuild --emit-revert: writes a .ccp-revert.json reverse-diff sidecar.
//   - runBuild --dry-run: writes NOTHING and exits 0 (shadow report path).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { parseBuildArgs } from '../runner/cli.mjs';
import { runBuild } from '../runner/cli/cmd-build.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

function captureLogger() {
  const lines = [];
  const errs = [];
  return {
    lines, errs,
    log: (...a) => lines.push(a.join(' ')),
    warn: (...a) => lines.push('WARN ' + a.join(' ')),
    error: (...a) => errs.push(a.join(' ')),
    debug: () => {},
  };
}
function err(l) { return l.errs.join('\n'); }
function sha256(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }

const SENTINEL = '__ccp_build_sentinel__';
const BUNDLE = '#!/usr/bin/env node\nvar head=1;\nvar tail=2;\n';

// A synthetic patch: idempotent insert of a unique sentinel, strongly verified.
function sentinelPatch() {
  return {
    description: 'insert a unique sentinel, strongly verified',
    capabilities: [],
    verify: { present: SENTINEL, count: { present: 1 } },
    apply: (code) => code.includes(SENTINEL)
      ? code
      : code.replace('var head=1;', `var head=1;/*${SENTINEL}*/`),
  };
}

// runBuild + parseBuildArgs read ccpatch.yml from process.cwd(); run from a
// scratch cwd with none so resolveEffectivePatches falls back to the explicit
// --patch list and the build cache / storage writes land in throwaway dirs.
let cwdGuard, scratchCwd;
before(() => {
  cwdGuard = process.cwd();
  scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-build-cwd-'));
  process.chdir(scratchCwd);
});
after(() => { process.chdir(cwdGuard); });

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(scratchCwd, 'proj-'));
  const inputPath = path.join(dir, 'cli.js');
  const outputPath = path.join(dir, 'cli.patched.js');
  fs.writeFileSync(inputPath, BUNDLE, 'utf8');
  return { dir, inputPath, outputPath };
}

// ── parseBuildArgs ────────────────────────────────────────────────────────────

describe('parseBuildArgs — flag parsing', () => {
  it('resolves positional <input> <output> and a comma-split --patch list', () => {
    const r = parseBuildArgs(['in.js', 'out.js', '--patch', 'a,b , c']);
    assert.equal(r.inputPath, path.resolve('in.js'));
    assert.equal(r.outputPath, path.resolve('out.js'));
    assert.deepEqual(r.requestedPatches, ['a', 'b', 'c']);
    assert.ok(!r.error);
  });

  it('records --strict and --dry-run on patchOptions', () => {
    const r = parseBuildArgs(['in.js', 'out.js', '--strict', '--dry-run']);
    assert.equal(r.patchOptions.strict, true);
    assert.equal(r.patchOptions.dryRun, true);
  });

  it('errors with USAGE when fewer than two positionals are given', () => {
    const r = parseBuildArgs(['in.js']);
    assert.ok(r.error);
    assert.match(r.error, /Usage|usage/);
  });

  it('rejects a flag occupying the input position', () => {
    const r = parseBuildArgs(['--patch', 'foo']);
    assert.ok(r.error);
    assert.match(r.error, /input position/);
  });

  it('rejects a flag occupying the output position', () => {
    const r = parseBuildArgs(['in.js', '--patch']);
    assert.ok(r.error);
    assert.match(r.error, /output position/);
  });
});

// ── runBuild — produces a patched bundle ──────────────────────────────────────

describe('runBuild — writes a patched bundle + sha sidecar', () => {
  it('applies the requested patch, embeds the sentinel, and writes .sha256', async () => {
    const { inputPath, outputPath } = tmpProject();
    const logger = captureLogger();
    const rc = await runBuild({
      options: { inputPath, outputPath, requestedPatches: ['sentinel'], profile: null, patchOptions: {} },
      patches: { sentinel: sentinelPatch() },
      logger,
    });
    assert.equal(rc, 0, `build failed: ${err(logger)}`);

    const patched = fs.readFileSync(outputPath, 'utf8');
    assert.ok(patched.includes(SENTINEL), 'patched bundle must contain the injected sentinel');
    // Exactly once — the strong verify count asserts idempotence held.
    assert.equal(patched.split(SENTINEL).length - 1, 1);

    // .sha256 sidecar is written and matches the patched bytes.
    const shaSidecar = outputPath + '.sha256';
    assert.ok(fs.existsSync(shaSidecar), 'expected a .sha256 sidecar');
    assert.ok(fs.readFileSync(shaSidecar, 'utf8').includes(sha256(patched)));
  });

  it('writes a .ccp-revert.json reverse-diff sidecar under --emit-revert', async () => {
    const { inputPath, outputPath } = tmpProject();
    const logger = captureLogger();
    const rc = await runBuild({
      options: {
        inputPath, outputPath, requestedPatches: ['sentinel'], profile: null,
        patchOptions: { emitRevert: true },
      },
      patches: { sentinel: sentinelPatch() },
      logger,
    });
    assert.equal(rc, 0, `build failed: ${err(logger)}`);

    const revertSidecar = outputPath + '.ccp-revert.json';
    assert.ok(fs.existsSync(revertSidecar), 'expected a .ccp-revert.json sidecar');
    const sidecar = JSON.parse(fs.readFileSync(revertSidecar, 'utf8'));
    assert.ok(Array.isArray(sidecar.patches), 'sidecar must carry a patches array');
    assert.equal(sidecar.patches.length, 1);
    assert.equal(sidecar.patches[0].name, 'sentinel');
    // The pre-state recorded is the original (unpatched) bundle.
    assert.equal(sidecar.inputSha256, sha256(BUNDLE));
  });
});

// ── runBuild — dry-run writes nothing ─────────────────────────────────────────

describe('runBuild — dry-run', () => {
  it('does not write the output bundle and exits 0', async () => {
    const { inputPath, outputPath } = tmpProject();
    const logger = captureLogger();
    const rc = await runBuild({
      options: {
        inputPath, outputPath, requestedPatches: ['sentinel'], profile: null,
        patchOptions: { dryRun: true },
      },
      patches: { sentinel: sentinelPatch() },
      logger,
    });
    assert.equal(rc, 0, `dry-run failed: ${err(logger)}`);
    assert.ok(!fs.existsSync(outputPath), 'dry-run must not write the patched bundle');
    assert.ok(!fs.existsSync(outputPath + '.sha256'), 'dry-run must not write a sha sidecar');
  });
});
