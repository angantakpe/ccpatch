import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  spliceBoot,
  spliceAfter,
  replaceFunctionByLiteral,
  forceFeatureFlag,
} from '../runner/patch-helpers.mjs';

describe('spliceBoot', () => {
  it('splices after the shebang line', () => {
    const code = '#!/usr/bin/env node\nconsole.log(1);\n';
    const out = spliceBoot(code, '/*BOOT*/');
    assert.equal(out, '#!/usr/bin/env node\n/*BOOT*/console.log(1);\n');
  });

  it('splices before the CJS IIFE when no shebang', () => {
    const code = 'var x=1;(function(exports, require, module, __filename, __dirname){body();})()';
    const out = spliceBoot(code, '/*BOOT*/');
    assert.ok(out.includes('/*BOOT*/(function(exports, require, module'));
  });

  it('throws when no boot anchor is present', () => {
    assert.throws(() => spliceBoot('var x=1;', '/*BOOT*/'), /no safe boot site/);
  });
});

describe('spliceAfter', () => {
  it('inserts after a string anchor', () => {
    const out = spliceAfter('abc-MARKER-xyz', '-MARKER-', '/*X*/');
    assert.equal(out, 'abc-MARKER-/*X*/xyz');
  });

  it('inserts after a regex anchor (uses matched length)', () => {
    const out = spliceAfter('foo123bar', /foo\d+/, '/*X*/');
    assert.equal(out, 'foo123/*X*/bar');
  });

  it('throws when the anchor is missing (strict by default)', () => {
    assert.throws(() => spliceAfter('abc', 'MISSING', '/*X*/'), /not found/);
    assert.throws(() => spliceAfter('abc', /MISSING/, '/*X*/'), /not found/);
  });

  it('honours allowMissing by returning code unchanged', () => {
    assert.equal(spliceAfter('abc', 'MISSING', '/*X*/', { allowMissing: true }), 'abc');
  });

  it('is unaffected by passing /g (uses a local non-sticky copy)', () => {
    const re = /MARK_\d+/g;
    re.lastIndex = 999;
    const out = spliceAfter('aMARK_1b', re, '|');
    assert.equal(out, 'aMARK_1|b');
  });
});

describe('replaceFunctionByLiteral / forceFeatureFlag', () => {
  // findFunctionByLiteral needs parseable JS — wrap the literal in a function.
  const FIXTURE = 'var pre=0;function Qx7(){return helper("tengu_test_flag",!1)};var post=1;';

  it('replaces the wrapping function body via build()', () => {
    const { code, fnName, changed } = replaceFunctionByLiteral(
      FIXTURE,
      'tengu_test_flag',
      (name) => `function ${name}(){return !0}`,
    );
    assert.equal(fnName, 'Qx7');
    assert.ok(changed);
    assert.ok(code.includes('function Qx7(){return !0}'));
    assert.ok(!code.includes('tengu_test_flag'));
  });

  it('forceFeatureFlag is a one-liner shortcut', () => {
    const { code, fnName } = forceFeatureFlag(FIXTURE, 'tengu_test_flag');
    assert.equal(fnName, 'Qx7');
    assert.ok(code.includes('function Qx7(){return !0}'));
  });

  it('throws when the literal is missing', () => {
    assert.throws(() => forceFeatureFlag(FIXTURE, 'no_such_flag'), /no function wraps literal/);
  });

  it('allowMissing returns the original code untouched', () => {
    const { code, fnName, changed } = forceFeatureFlag(FIXTURE, 'no_such_flag', { allowMissing: true });
    assert.equal(code, FIXTURE);
    assert.equal(fnName, null);
    assert.equal(changed, false);
  });

  it('respects custom value (e.g. !1 to force-disable)', () => {
    const { code } = forceFeatureFlag(FIXTURE, 'tengu_test_flag', { value: '!1' });
    assert.ok(code.includes('function Qx7(){return !1}'));
  });
});
