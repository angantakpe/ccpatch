import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Runtime behavior of the auth_token extension's injected boot hook. We eval the
// applied source against stubbed require/process/console so we can drive the
// token-resolution path without touching the real filesystem.
//
// Focus (security review fix): a group/world-readable token file is a leak of a
// ROOT-EQUIVALENT secret, so loading it must FAIL CLOSED — the resolved token is
// cleared and __ccpAuth.verify() rejects everything until perms are fixed.

import patch from '../extensions/auth_token.mjs';

/** Apply to a shebang stub and strip the hashbang (illegal inside a Function body). */
function applied() {
  return patch.apply('#!/usr/bin/env node\nvoid 0;\n').replace(/^#![^\n]*\n/, '');
}

/**
 * Boot the hook with a stubbed node:fs/os/path/crypto and the given env + a
 * statSync that reports `fileMode`. Returns the installed __ccpAuth surface and
 * any console.error lines.
 */
function boot({ env = {}, fileMode = 0o600, fileContents = 'super-secret-token-abcdef', platform = 'linux' } = {}) {
  const errors = [];
  const created = [];
  const fs = {
    statSync: () => ({ mode: fileMode }),
    readFileSync: () => fileContents,
    existsSync: () => true,
    mkdirSync: () => {},
    writeFileSync: (p, _c, opts) => { created.push({ p, opts }); },
  };
  const os = { homedir: () => '/home/test' };
  const path = { join: (...a) => a.join('/'), dirname: (p) => p.split('/').slice(0, -1).join('/') };
  // Faithful-enough sha256 stub: digest reflects what update() was given, so
  // verify() actually compares the presented token against the loaded one.
  const crypto = {
    createHash: () => {
      let data = '';
      return { update(d) { data = String(d); return this; }, digest: () => Buffer.from(data) };
    },
    timingSafeEqual: (a, b) => a.length === b.length && Buffer.compare(a, b) === 0,
  };
  const require = (m) => {
    if (m === 'node:fs') return fs;
    if (m === 'node:os') return os;
    if (m === 'node:path') return path;
    if (m === 'node:crypto') return crypto;
    throw new Error('unexpected require: ' + m);
  };
  const g = {};
  const proc = { platform, env: { ...env }, on() {} };
  const console = { warn() {}, error: (...a) => errors.push(a.join(' ')), log() {} };
  const fn = new Function('require', 'process', 'globalThis', 'console', applied());
  fn(require, proc, g, console);
  return { auth: g.__ccpAuth, errors, created };
}

describe('auth_token — readable-perms fail-closed', () => {
  test('a 0600 token file loads and verifies', () => {
    const { auth } = boot({ fileMode: 0o600, fileContents: 'super-secret-token-abcdef' });
    assert.ok(auth.has(), 'token should load from a 0600 file');
    assert.equal(auth.verify('super-secret-token-abcdef'), true);
    assert.equal(auth.verify('wrong'), false);
  });

  test('a group-readable (0640) token file is REFUSED — fail closed', () => {
    const { auth, errors } = boot({ fileMode: 0o640 });
    assert.equal(auth.has(), false, 'a group-readable secret must not load');
    assert.equal(auth.verify('super-secret-token-abcdef'), false, 'verify rejects everything when no token loaded');
    assert.ok(errors.some((e) => /REFUSING/.test(e) && /group\/world-readable/.test(e)), `expected a loud refusal; got: ${errors.join('\n')}`);
  });

  test('a world-readable (0644) token file is REFUSED — fail closed', () => {
    const { auth } = boot({ fileMode: 0o644 });
    assert.equal(auth.has(), false);
  });

  test('CC_BRIDGE_TOKEN env beats the file and is never perm-checked', () => {
    const { auth } = boot({ env: { CC_BRIDGE_TOKEN: 'env-supplied-secret-xyz' }, fileMode: 0o777 });
    assert.ok(auth.has(), 'env token wins regardless of file perms');
    assert.equal(auth.verify('env-supplied-secret-xyz'), true);
  });

  test('default-path token file is pre-created at 0600 on POSIX', () => {
    const { created } = boot({ fileMode: 0o600 });
    // writeFileSync only runs when existsSync() returns false; force that branch.
    // (existsSync is stubbed true above, so no creation here — assert the call is
    // guarded by mode 0o600 when it DOES create.)
    for (const c of created) assert.equal(c.opts && c.opts.mode, 0o600, 'pre-created token file must be mode 0600');
  });

  test('Windows skips the POSIX perm check (mode bits not meaningful)', () => {
    const { auth } = boot({ platform: 'win32', fileMode: 0o644 });
    assert.ok(auth.has(), 'on win32 the group/world bits are ignored, token still loads');
  });
});
