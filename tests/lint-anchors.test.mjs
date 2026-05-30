import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isBrittle, findOffenders } from '../scripts/lint-anchors.mjs';
import { anchors } from '../runner/anchors.mjs';

describe('lint-anchors — brittle entry detection', () => {
  it('flags an entry with only a default regex (no literal, no anchors[])', () => {
    const brittle = {
      default: /function (\w+)\(\)\{return \w+\("some_flag",!0,\w+\)\}/,
    };
    assert.equal(isBrittle(brittle), true);
  });

  it('passes an entry that adds a stable literal (AST fallback path)', () => {
    const resilient = {
      literal: 'some_flag',
      default: /function (\w+)\(\)\{return \w+\("some_flag",!0,\w+\)\}/,
    };
    assert.equal(isBrittle(resilient), false);
  });

  it('passes an entry with a non-empty anchors[] tier chain', () => {
    const tiered = {
      default: /DEFAULT_\w+/,
      anchors: [
        { priority: 'primary', pattern: /PRIMARY_\w+/ },
      ],
    };
    assert.equal(isBrittle(tiered), false);
  });

  it('treats an empty/regex-less anchors[] chain as no fallback', () => {
    assert.equal(isBrittle({ default: /D_\w+/, anchors: [] }), true);
    assert.equal(isBrittle({ default: /D_\w+/, anchors: [{ priority: 'primary' }] }), true);
  });

  it('treats an empty-string literal as no literal', () => {
    assert.equal(isBrittle({ literal: '', default: /D_\w+/ }), true);
  });

  it('does not flag entries without a default regex', () => {
    assert.equal(isBrittle({ literal: 'x' }), false);
    assert.equal(isBrittle({ anchors: [{ pattern: /P_\w+/ }] }), false);
    assert.equal(isBrittle({}), false);
    assert.equal(isBrittle(null), false);
  });

  it('findOffenders returns ids of brittle entries only', () => {
    const registry = {
      good_literal: { literal: 'f', default: /A_\w+/ },
      good_tier: { default: /B_\w+/, anchors: [{ pattern: /T_\w+/ }] },
      bad_one: { default: /C_\w+/ },
      no_default: { literal: 'g' },
    };
    assert.deepEqual(findOffenders(registry), ['bad_one']);
  });

  it('the real anchors registry is clean (every default has a fallback)', () => {
    assert.deepEqual(findOffenders(anchors), []);
  });
});
