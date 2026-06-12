import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateManifest } from '../runner/manifest.mjs';
import {
  compileKind,
  locateTarget,
  rewriteReturns,
  rewriteArrowExpressionBody,
  KINDS,
} from '../runner/patch-kinds.mjs';

// Original force_thinking implementation, inlined for parity testing.
function originalForceThinkingApply(code) {
  const anchor = /function (\w+)\(\)\{if\(process\.env\.MAX_THINKING_TOKENS\)return parseInt\(process\.env\.MAX_THINKING_TOKENS,10\)>0;let\{settings:(\w+)\}=\w+\(\);if\(\2\.alwaysThinkingEnabled===!1\)return!1;return!0\}/;
  const m = code.match(anchor);
  if (!m) return code;
  const fnName = m[1];
  const original = m[0];
  const envCheck = 'if(process.env.CC_THINKING&&process.env.CC_THINKING!=="disabled"&&process.env.CC_THINKING!=="0")return!0;';
  const prefix = 'function ' + fnName + '(){';
  const replacement = prefix + envCheck + original.slice(prefix.length);
  return code.replace(original, replacement);
}

describe('patch-kinds: prefix', () => {
  it('injects code immediately after the opening brace of a literal-anchored function', () => {
    const code = `function foo(){let x="STABLE_LITERAL";return x}`;
    const patch = {
      kind: 'prefix',
      target: { function: { literal: 'STABLE_LITERAL' } },
      code: 'console.log("entered");',
    };
    const apply = compileKind(patch);
    const out = apply(code);
    assert.equal(out, `function foo(){console.log("entered");let x="STABLE_LITERAL";return x}`);
  });

  it('injects into a function looked up by name', () => {
    const code = `function bar(){return 1}function baz(){return 2}`;
    const patch = {
      kind: 'prefix',
      target: { function: 'baz' },
      code: 'a();',
    };
    const out = compileKind(patch)(code);
    assert.equal(out, `function bar(){return 1}function baz(){a();return 2}`);
  });

  it('returns code unchanged when the target is not found', () => {
    const code = `function foo(){return 1}`;
    const patch = {
      kind: 'prefix',
      target: { function: { literal: 'NOPE' } },
      code: 'x();',
    };
    assert.equal(compileKind(patch)(code), code);
  });

  it('re-apply is a byte-identical no-op (rule 2)', () => {
    const code = `function foo(){let x="STABLE_LITERAL";return x}`;
    const patch = {
      kind: 'prefix',
      target: { function: { literal: 'STABLE_LITERAL' } },
      code: 'console.log("entered");',
    };
    const apply = compileKind(patch);
    const once = apply(code);
    assert.notEqual(once, code);
    assert.equal(apply(once), once);
  });
});

describe('patch-kinds: postfix', () => {
  it('wraps every return X in a passthrough that exposes __r', () => {
    const code = `function foo(){let x="LIT";if(x)return 1;return 2}`;
    const patch = {
      kind: 'postfix',
      target: { function: { literal: 'LIT' } },
      code: 'if(__r===1)__r=42',
    };
    const out = compileKind(patch)(code);
    assert.ok(out.includes('return (function(__r){if(__r===1)__r=42;return __r})(1)'));
    assert.ok(out.includes('return (function(__r){if(__r===1)__r=42;return __r})(2)'));
  });

  it('handles void return', () => {
    const code = `function foo(){let x="LIT";if(x)return;doSomething()}`;
    const patch = {
      kind: 'postfix',
      target: { function: { literal: 'LIT' } },
      code: 'sideEffect()',
    };
    const out = compileKind(patch)(code);
    // void return becomes a block with the injected code before the bare return.
    assert.ok(out.includes('{sideEffect();return;}'));
  });

  it('does not rewrite returns inside nested functions', () => {
    const code = `function outer(){let x="LIT";function inner(){return 99}return inner()}`;
    const patch = {
      kind: 'postfix',
      target: { function: { literal: 'LIT' } },
      code: 'mark()',
    };
    const out = compileKind(patch)(code);
    // The nested `return 99` must NOT be wrapped.
    assert.ok(out.includes('function inner(){return 99}'));
    // The outer return IS wrapped.
    assert.ok(out.includes('return (function(__r){mark();return __r})(inner())'));
  });

  it('rewrites arrow expression bodies', () => {
    const arrowText = `x => x + 1`;
    const out = rewriteArrowExpressionBody(arrowText, 'log(__r)');
    assert.equal(out, `x => (function(__r){log(__r);return __r})(x + 1)`);
  });

  it('rewriteArrowExpressionBody returns null for block-body arrows', () => {
    assert.equal(rewriteArrowExpressionBody(`x => { return x }`, 'log()'), null);
  });

  it('re-apply is a byte-identical no-op (rule 2)', () => {
    const code = `function foo(){let x="LIT";if(x)return 1;return 2}`;
    const patch = {
      kind: 'postfix',
      target: { function: { literal: 'LIT' } },
      code: 'if(__r===1)__r=42',
    };
    const apply = compileKind(patch);
    const once = apply(code);
    assert.notEqual(once, code);
    assert.equal(apply(once), once);
  });
});

describe('patch-kinds: transpiler', () => {
  it('passes the function body to transform and splices the result back', () => {
    const code = `before;function foo(){let x="LIT";return x}after;`;
    const patch = {
      kind: 'transpiler',
      target: { function: { literal: 'LIT' } },
      transform: (body) => body.replace('return x', 'return x*2'),
    };
    const out = compileKind(patch)(code);
    assert.equal(out, `before;function foo(){let x="LIT";return x*2}after;`);
  });

  it('returning the input unchanged leaves the bundle byte-identical', () => {
    const code = `before;function foo(){let x="LIT";return x}after;`;
    const patch = {
      kind: 'transpiler',
      target: { function: { literal: 'LIT' } },
      transform: (body) => body,
    };
    assert.equal(compileKind(patch)(code), code);
  });

  it('throws when transform returns a non-string', () => {
    const code = `function foo(){let x="LIT";return x}`;
    const patch = {
      kind: 'transpiler',
      target: { function: { literal: 'LIT' } },
      transform: () => 42,
    };
    assert.throws(() => compileKind(patch)(code), /must return a string/);
  });
});

describe('patch-kinds: manifest validation', () => {
  it('rejects apply() combined with a non-free kind', () => {
    const mod = {
      description: 'mix',
      verify: { present: 'x', weak: true },
      kind: 'prefix',
      target: { function: 'foo' },
      code: 'x()',
      apply: () => '',
    };
    const { ok, errors } = validateManifest(mod, 'mix.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('must not export apply')), `errors: ${errors}`);
  });

  it('requires target.function for non-free kinds', () => {
    const mod = {
      description: 'no target',
      verify: { present: 'x', weak: true },
      kind: 'prefix',
      code: 'x()',
    };
    const { ok, errors } = validateManifest(mod, 'np.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('target.function')), `errors: ${errors}`);
  });

  it('requires code: string for prefix kind', () => {
    const mod = {
      description: 'no code',
      verify: { present: 'x', weak: true },
      kind: 'prefix',
      target: { function: 'foo' },
    };
    const { ok, errors } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('code: string')), `errors: ${errors}`);
  });

  it('requires transform: function for transpiler kind', () => {
    const mod = {
      description: 'no transform',
      verify: { present: 'x', weak: true },
      kind: 'transpiler',
      target: { function: 'foo' },
    };
    const { ok, errors } = validateManifest(mod, 't.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('transform')), `errors: ${errors}`);
  });

  it('accepts a valid prefix manifest and normalizes kind', () => {
    const mod = {
      description: 'good',
      verify: { present: 'x', weak: true },
      kind: 'prefix',
      target: { function: 'foo' },
      code: 'x()',
    };
    const { ok, errors, normalized } = validateManifest(mod, 'g.mjs');
    assert.equal(ok, true, `errors: ${errors}`);
    assert.equal(normalized.kind, 'prefix');
  });

  it('defaults kind to "free" and still requires apply', () => {
    const mod = {
      description: 'classic',
      verify: { present: 'x', weak: true },
      apply: () => '',
    };
    const { ok, normalized } = validateManifest(mod, 'c.mjs');
    assert.equal(ok, true);
    assert.equal(normalized.kind, 'free');
  });

  it('exposes the kind vocabulary', () => {
    assert.deepEqual(KINDS, ['free', 'prefix', 'postfix', 'transpiler']);
  });
});

describe('patch-kinds: converted force_thinking matches original byte-for-byte', () => {
  // Synthetic minified fixture mirroring the real bundle shape.
  const fixture =
    'var pre=1;' +
    'function aN(){if(process.env.MAX_THINKING_TOKENS)return parseInt(process.env.MAX_THINKING_TOKENS,10)>0;let{settings:q}=Z();if(q.alwaysThinkingEnabled===!1)return!1;return!0}' +
    ';var post=2;';

  it('converted prefix-kind patch produces byte-identical output to the original apply()', async () => {
    const originalOut = originalForceThinkingApply(fixture);

    const mod = await import('../extensions/force_thinking.mjs');
    const patch = mod.default;
    assert.equal(patch.kind, 'prefix');
    const apply = compileKind(patch);
    const newOut = apply(fixture);

    assert.equal(newOut, originalOut);
    // Sanity: the injection landed.
    assert.ok(newOut.includes('CC_THINKING!=="disabled"'));
  });
});

describe('patch-kinds: locateTarget', () => {
  it('finds function by literal', () => {
    const code = `function a(){return 1}function b(){let x="SIG";return x}`;
    const loc = locateTarget(code, { function: { literal: 'SIG' } });
    assert.ok(loc);
    assert.equal(loc.name, 'b');
  });

  it('finds function by name', () => {
    const code = `function a(){return 1}function targetFn(){return 2}`;
    const loc = locateTarget(code, { function: 'targetFn' });
    assert.ok(loc);
    assert.equal(loc.name, 'targetFn');
  });

  it('returns null for missing target', () => {
    const code = `function a(){return 1}`;
    assert.equal(locateTarget(code, { function: 'nope' }), null);
  });
});

// Quick sanity check on rewriteReturns for an empty body.
describe('patch-kinds: rewriteReturns edge cases', () => {
  it('returns input unchanged when there are no return statements', () => {
    const fn = `function foo(){let x=1}`;
    assert.equal(rewriteReturns(fn, 'mark()'), fn);
  });
});
