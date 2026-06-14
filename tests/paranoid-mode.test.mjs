// WS6 Item 5: --paranoid / strict mode.
//
// Three surfaces:
//   1. CLI parsing: --paranoid is a global flag, lifted out of argv and exported
//      as CCPATCH_PARANOID=1 (so doctor + child processes + the injected
//      fetch_interceptor hook all see it). parseBuildArgs also records it on
//      patchOptions and honors a pre-set env.
//   2. fetch_interceptor: the injected __ccpBusWarn becomes LOUD (writes to
//      stderr unconditionally) when process.env.CCPATCH_PARANOID === '1'.
//   3. build: a [repack:skip] degradation is a hard FAILURE under paranoid, and
//      --allow-unverified is never forwarded to the repacker.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseBuildArgs, runPatchCli } from '../runner/cli.mjs';
import fetchInterceptor from '../core/fetch_interceptor.mjs';

const PREV_PARANOID = process.env.CCPATCH_PARANOID;
afterEach(() => {
  if (PREV_PARANOID === undefined) delete process.env.CCPATCH_PARANOID;
  else process.env.CCPATCH_PARANOID = PREV_PARANOID;
  delete process.env.CCPATCH_REPACK_SKIP;
});

describe('parseBuildArgs — --paranoid', () => {
  it('records paranoid on patchOptions', () => {
    const o = parseBuildArgs(['in.js', 'out.js', '--paranoid']);
    assert.equal(o.patchOptions.paranoid, true);
  });

  it('does not set paranoid by default', () => {
    const o = parseBuildArgs(['in.js', 'out.js']);
    assert.notEqual(o.patchOptions.paranoid, true);
  });

  it('honors CCPATCH_PARANOID=1 from the environment', () => {
    const prev = process.env.CCPATCH_PARANOID;
    process.env.CCPATCH_PARANOID = '1';
    try {
      const o = parseBuildArgs(['in.js', 'out.js']);
      assert.equal(o.patchOptions.paranoid, true);
    } finally {
      if (prev === undefined) delete process.env.CCPATCH_PARANOID;
      else process.env.CCPATCH_PARANOID = prev;
    }
  });

  it('parses --allow-unverified as an explicit opt-out', () => {
    const o = parseBuildArgs(['in.js', 'out.js', '--allow-unverified']);
    assert.equal(o.patchOptions.allowUnverified, true);
  });
});

describe('runPatchCli — --paranoid is a global flag', () => {
  it('exports CCPATCH_PARANOID=1 and strips the flag from argv', async () => {
    delete process.env.CCPATCH_PARANOID;
    // Drive a cheap path (doctor on a missing file returns 1 fast) — we only
    // care that the global flag was lifted and exported before dispatch.
    const logger = { log() {}, warn() {}, error() {} };
    await runPatchCli(['doctor', '/nonexistent/cli.js', '--paranoid'], logger);
    assert.equal(process.env.CCPATCH_PARANOID, '1');
  });
});

describe('fetch_interceptor — paranoid makes __ccpBusWarn loud', () => {
  // The hook is a string of injected source; eval it into a sandbox-ish global
  // surface so we can call __ccpBusWarn directly and observe console.error.
  function installHook() {
    // Reset the relevant globals so each run re-installs cleanly.
    delete globalThis.__ccpBusWarn;
    delete globalThis.__ccpDebug;
    delete globalThis.__ccpBusWarnBudget; // bounded-surfacing budget (review fix)
    // The hook references console + process.env, both available here. We only
    // need the __ccpBusWarn definition, which runs at the top of the hook.
    // eslint-disable-next-line no-eval
    (0, eval)(fetchInterceptor.preloadCode);
  }

  function withCapturedStderr(fn) {
    const calls = [];
    const orig = console.error;
    console.error = (...a) => calls.push(a.join(' '));
    try { fn(); } finally { console.error = orig; }
    return calls;
  }

  it('surfaces the first N errors then goes silent by default (bounded surfacing)', () => {
    // Review fix: even with all debug knobs off, a buggy subscriber must never
    // fail in TOTAL silence. The first __ccpBusWarnBudget (3) swallowed errors
    // are printed once to stderr (so the operator notices "set CLAUDE_DEBUG=1"),
    // then the hook goes quiet. The diag sink still records every one; blast-
    // radius containment (error still caught) is unchanged.
    const prevP = process.env.CCPATCH_PARANOID;
    const prevD = process.env.CLAUDE_DEBUG;
    delete process.env.CCPATCH_PARANOID;
    delete process.env.CLAUDE_DEBUG;
    try {
      installHook();
      const calls = withCapturedStderr(() => {
        for (let i = 0; i < 6; i++) globalThis.__ccpBusWarn('subA', 'after', new Error('boom' + i));
      });
      // Exactly 3 surfaced, the rest silenced.
      assert.equal(calls.length, 3);
      assert.match(calls[0], /\[ccp:bus\]/);
      assert.match(calls[0], /boom0/);
      // The last surfaced line points the operator at the full-detail knob.
      assert.match(calls[2], /CLAUDE_DEBUG=1/);
    } finally {
      if (prevP === undefined) delete process.env.CCPATCH_PARANOID; else process.env.CCPATCH_PARANOID = prevP;
      if (prevD === undefined) delete process.env.CLAUDE_DEBUG; else process.env.CLAUDE_DEBUG = prevD;
    }
  });

  it('is LOUD on stderr when CCPATCH_PARANOID=1', () => {
    const prevP = process.env.CCPATCH_PARANOID;
    const prevD = process.env.CLAUDE_DEBUG;
    process.env.CCPATCH_PARANOID = '1';
    delete process.env.CLAUDE_DEBUG;
    try {
      installHook();
      const calls = withCapturedStderr(() => {
        globalThis.__ccpBusWarn('subA', 'after', new Error('boom'));
      });
      assert.equal(calls.length, 1);
      assert.match(calls[0], /\[ccp:bus\]\[paranoid\]/);
      assert.match(calls[0], /subA/);
      assert.match(calls[0], /boom/);
    } finally {
      if (prevP === undefined) delete process.env.CCPATCH_PARANOID; else process.env.CCPATCH_PARANOID = prevP;
      if (prevD === undefined) delete process.env.CLAUDE_DEBUG; else process.env.CLAUDE_DEBUG = prevD;
    }
  });
});

// ── build path: paranoid fail-closed on [repack:skip] ───────────────────────

function captureLogger() {
  const lines = [];
  return {
    lines,
    log: (...a) => lines.push(a.join(' ')),
    warn: (...a) => lines.push('WARN ' + a.join(' ')),
    error: (...a) => lines.push('ERR ' + a.join(' ')),
  };
}

// A minimal "patch" that always applies cleanly so runBuild reaches the
// platform-degradation block. verify is satisfied by the marker it injects.
const MARKER = '__ws6_paranoid_marker__';
const PATCHES = {
  ws6_noop: {
    description: 'ws6 test patch',
    verify: { present: MARKER, count: { present: 1 } },
    apply: (code) => code + `\n/*${MARKER}*/\n`,
  },
};

async function runBuildWith({ paranoid, skipLine }) {
  const { runBuild } = await import('../runner/cli/cmd-build.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-ws6-build-'));
  const inputPath = path.join(dir, 'in.js');
  const outputPath = path.join(dir, 'out.js');
  fs.writeFileSync(inputPath, '#!/usr/bin/env node\nconsole.log(1);\n');
  const logger = captureLogger();
  const prev = process.env.CCPATCH_REPACK_SKIP;
  if (skipLine) process.env.CCPATCH_REPACK_SKIP = skipLine;
  else delete process.env.CCPATCH_REPACK_SKIP;
  let rc;
  try {
    rc = await runBuild({
      options: {
        inputPath,
        outputPath,
        requestedPatches: ['ws6_noop'],
        profile: null,
        patchOptions: { paranoid },
      },
      patches: PATCHES,
      logger,
    });
  } finally {
    if (prev === undefined) delete process.env.CCPATCH_REPACK_SKIP;
    else process.env.CCPATCH_REPACK_SKIP = prev;
  }
  return { rc, out: logger.lines.join('\n'), outputPath };
}

describe('runBuild — paranoid treats [repack:skip] as a build failure', () => {
  const SKIP = '[repack:skip] {"platform":"darwin-arm64","droppedPatches":["esm_compat","bun_shim"]}';

  it('WARNs and succeeds by default', async () => {
    const { rc, out, outputPath } = await runBuildWith({ paranoid: false, skipLine: SKIP });
    assert.equal(rc, 0);
    assert.match(out, /native grow-path unavailable on darwin-arm64/);
    assert.ok(fs.existsSync(outputPath), 'bundle should still be written');
  });

  it('FAILS (exit 1) under paranoid', async () => {
    const { rc, out } = await runBuildWith({ paranoid: true, skipLine: SKIP });
    assert.equal(rc, 1);
    assert.match(out, /ERR .*\[paranoid\]/);
    assert.match(out, /native grow-path unavailable on darwin-arm64/);
  });

  it('succeeds with no skip line present', async () => {
    const { rc } = await runBuildWith({ paranoid: true, skipLine: null });
    assert.equal(rc, 0);
  });
});
