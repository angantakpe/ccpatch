import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  spliceBoot,
  spliceAfter,
  replaceFunctionByLiteral,
  forceFeatureFlag,
  registerFetchHook,
  injectAtModuleTop,
  FETCH_PRIORITY,
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

  it('injects a snippet containing $& literally into the CJS-IIFE branch (no replace-pattern expansion)', () => {
    // Regression: the CJS branch used the STRING form of String.replace, so a
    // snippet containing `$&` would expand to the whole matched IIFE header,
    // ballooning the bundle (observed 15.5MB→62MB for the event_bus hook).
    const code = 'var x=1;(function(exports, require, module, __filename, __dirname){body();})()';
    const snippet = '/*pre $& $\' $` $0 mid*/';
    const out = spliceBoot(code, snippet);
    // The literal snippet must appear verbatim — no `$&` expansion.
    assert.ok(out.includes(snippet), 'snippet must be injected literally');
    // And it must NOT have expanded `$&` into the matched IIFE header.
    assert.ok(
      !out.includes('/*pre (function(exports, require, module'),
      'the $& sequence must not expand to the matched IIFE header',
    );
    // Size sanity: output is the original plus exactly the snippet length.
    assert.equal(out.length, code.length + snippet.length);
  });

  it('injects a snippet containing $& literally into the shebang branch', () => {
    const code = '#!/usr/bin/env node\nconsole.log(1);\n';
    const snippet = '/* $& $1 keep */';
    const out = spliceBoot(code, snippet);
    assert.equal(out, '#!/usr/bin/env node\n' + snippet + 'console.log(1);\n');
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

describe('FETCH_PRIORITY', () => {
  it('exposes the named tiers with their real values and is frozen', () => {
    assert.deepEqual(
      { ...FETCH_PRIORITY },
      { GATE: 0, EARLY: 15, INSPECT: 20, TRIM: 40, DEFAULT: 50, LATE: 80, LAST: 95 },
    );
    assert.ok(Object.isFrozen(FETCH_PRIORITY));
  });
});

describe('registerFetchHook', () => {
  it('emits the canonical guard + registration wiring', () => {
    const out = registerFetchHook('my_hook', 'function(ctx){}', FETCH_PRIORITY.TRIM);
    assert.equal(
      out,
      "if (typeof globalThis.__ccpOnFetchBefore === 'function') {\n" +
        "  globalThis.__ccpOnFetchBefore('my_hook', function(ctx){}, 40);\n" +
        '}',
    );
  });

  it('defaults to FETCH_PRIORITY.DEFAULT (50)', () => {
    const out = registerFetchHook('h', 'function(){}');
    assert.ok(out.includes("'h', function(){}, 50);"));
  });

  it('indents the wrapper to reproduce a hand-written 2-space layout', () => {
    const out = registerFetchHook('h', 'function(){}', 80, { indent: '  ' });
    assert.equal(
      out,
      "  if (typeof globalThis.__ccpOnFetchBefore === 'function') {\n" +
        "    globalThis.__ccpOnFetchBefore('h', function(){}, 80);\n" +
        '  }',
    );
  });

  it('rejects empty name / handler and non-finite priority', () => {
    assert.throws(() => registerFetchHook('', 'f', 0), /non-empty string/);
    assert.throws(() => registerFetchHook('n', '', 0), /non-empty string/);
    assert.throws(() => registerFetchHook('n', 'f', NaN), /finite number/);
  });
});

describe('injectAtModuleTop', () => {
  const SHEBANG = '#!/usr/bin/env node';
  const IIFE_NO_BRACE = '(function(exports, require, module, __filename, __dirname)';
  const IIFE_BRACE = '(function(exports, require, module, __filename, __dirname) {';

  it('splices after the shebang regardless of placement', () => {
    const code = SHEBANG + '\nbody();\n';
    assert.equal(injectAtModuleTop(code, '/*X*/'), SHEBANG + '/*X*/\nbody();\n');
    assert.equal(
      injectAtModuleTop(code, '/*X*/', { placement: 'after' }),
      SHEBANG + '/*X*/\nbody();\n',
    );
  });

  it("placement 'before' splices ahead of the no-brace IIFE (outer scope)", () => {
    const code = 'pre;' + IIFE_NO_BRACE + '{body();})()';
    const out = injectAtModuleTop(code, '/*X*/');
    assert.ok(out.includes('/*X*/' + IIFE_NO_BRACE));
  });

  it("placement 'after' splices inside the brace IIFE (wrapper scope)", () => {
    const code = 'pre;' + IIFE_BRACE + '\nbody();})()';
    const out = injectAtModuleTop(code, '/*X*/', { placement: 'after' });
    assert.ok(out.includes(IIFE_BRACE + '/*X*/'));
  });

  it('injects a snippet containing $& literally (function-form replace)', () => {
    const code = 'pre;' + IIFE_NO_BRACE + '{body();})()';
    const snippet = '/* $& $1 keep */';
    const out = injectAtModuleTop(code, snippet);
    assert.ok(out.includes(snippet));
    assert.equal(out.length, code.length + snippet.length);
  });

  it("onMissing 'warn' (default) returns code unchanged on a miss", () => {
    const orig = console.warn;
    let warned = '';
    console.warn = (m) => { warned = String(m); };
    try {
      assert.equal(injectAtModuleTop('var x=1;', '/*X*/', { label: 'demo' }), 'var x=1;');
    } finally {
      console.warn = orig;
    }
    assert.match(warned, /demo: anchor not found/);
  });

  it("onMissing 'throw' raises on a miss", () => {
    assert.throws(
      () => injectAtModuleTop('var x=1;', '/*X*/', { onMissing: 'throw' }),
      /no safe boot site/,
    );
  });
});
