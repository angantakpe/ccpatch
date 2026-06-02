import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isBrittle,
  findOffenders,
  findMinifiedShapeAnchor,
  stableTokens,
  scanMinifiedShapeAnchors,
  ALLOWED_REGEX_ANCHORS,
} from '../scripts/lint-anchors.mjs';
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

describe('lint-anchors — stableTokens', () => {
  it('finds a quoted string literal in the pattern source', () => {
    const { quoted, words } = stableTokens('\\w+\\("tengu_kairos_x",!0\\)');
    assert.equal(quoted, true);
    // The quoted flag string is also surfaced as a stable word (it is literal
    // text, not inside a char-class) — either signal exempts the pattern.
    assert.ok(words.includes('tengu_kairos_x'));
  });

  it('finds stable property/identifier words but ignores name-slot classes', () => {
    // The [A-Za-z_$] / [\w$] class contents must NOT count as stable words.
    const { quoted, words } = stableTokens('\\{apiKey:[A-Za-z_$][\\w$]*,maxRetries:[A-Za-z_$][\\w$]*\\}');
    assert.equal(quoted, false);
    assert.ok(words.includes('apiKey'));
    assert.ok(words.includes('maxRetries'));
    assert.ok(!words.includes('Za'), 'char-class contents must be stripped');
  });

  it('drops structural JS keywords (function/return/async/new)', () => {
    const { words } = stableTokens('return new ([A-Za-z_$][\\w$]*)\\(\\)\\}async function');
    assert.deepEqual(words, []);
  });
});

describe('lint-anchors — minified-shape anchor detection', () => {
  it('flags a structural-only regex (name slots, no stable literal)', () => {
    const reason = findMinifiedShapeAnchor('function ([A-Za-z_$][\\w$]*)\\(\\)\\{return\\[([A-Za-z_$][\\w$]*)\\]');
    assert.equal(typeof reason, 'string');
  });

  it('flags a bare boolean-flag shape with no stable token', () => {
    assert.equal(typeof findMinifiedShapeAnchor('\\w+\\(\\)\\{return!0\\}'), 'string');
  });

  it('passes a regex that anchors on a quoted feature-flag literal', () => {
    assert.equal(findMinifiedShapeAnchor('function (\\w+)\\(\\)\\{return \\w+\\("tengu_kairos_loop_dynamic",!1\\)\\}'), null);
  });

  it('passes a regex that anchors on a stable identifier word (isHidden)', () => {
    assert.equal(findMinifiedShapeAnchor('isHidden\\(\\)\\{return!0\\}'), null);
  });

  it('passes a regex anchored on a stable property-name skeleton', () => {
    assert.equal(
      findMinifiedShapeAnchor('async function ([A-Za-z_$][\\w$]*)\\(\\{apiKey:[A-Za-z_$][\\w$]*,maxRetries:[A-Za-z_$][\\w$]*\\}\\)'),
      null,
    );
  });

  it('ignores a regex with no minified-shape tokens at all', () => {
    assert.equal(findMinifiedShapeAnchor('"--ignore-files"'), null);
    assert.equal(findMinifiedShapeAnchor('#!/usr/bin/env node'), null);
  });

  it('returns null for non-string / empty input', () => {
    assert.equal(findMinifiedShapeAnchor(null), null);
    assert.equal(findMinifiedShapeAnchor(''), null);
  });
});

describe('lint-anchors — scanMinifiedShapeAnchors (file scan + allowlist)', () => {
  /** Write a throwaway patch tree under a fresh tmp dir; return the root. */
  function fixtureRoot(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-anchor-lint-'));
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body, 'utf8');
    }
    return root;
  }

  it('fails on a synthetic regex-only patch (minified shape, no literal)', () => {
    const root = fixtureRoot({
      'extensions/synthetic_bad.mjs':
        'export default { verify: { present: "x" }, apply: (code) =>' +
        ' code.replace(/function ([A-Za-z_$][\\w$]*)\\(\\)\\{return\\[([A-Za-z_$][\\w$]*)\\]/, "x") };\n',
    });
    const offenders = scanMinifiedShapeAnchors(root);
    assert.equal(offenders.length, 1);
    assert.equal(offenders[0].file, 'extensions/synthetic_bad.mjs');
  });

  it('passes a literal-anchored patch (regex pins a stable flag string)', () => {
    const root = fixtureRoot({
      'extensions/synthetic_good.mjs':
        'export default { verify: { present: "x" }, apply: (code) =>' +
        ' code.replace(/function (\\w+)\\(\\)\\{return \\w+\\("tengu_kairos_x",!0\\)\\}/, "x") };\n',
    });
    assert.deepEqual(scanMinifiedShapeAnchors(root), []);
  });

  it('honors the allowlist: an allowlisted source is not reported', () => {
    // Reuse a real allowlisted file+pattern: drop the exact same regex into a
    // file named like its allowlist key, under a tmp root, and confirm it is
    // cleared.
    const file = 'extensions/expose_api_client.mjs';
    const [allowedPattern] = [...ALLOWED_REGEX_ANCHORS[file]];
    const root = fixtureRoot({
      [file]:
        'export default { verify: { present: "x" }, apply: (code) =>' +
        ` code.replace(new RegExp(${JSON.stringify(allowedPattern)}), "x") };\n`,
    });
    assert.deepEqual(scanMinifiedShapeAnchors(root), []);
  });

  it('the same allowlisted pattern in a DIFFERENT file is still flagged', () => {
    const [allowedPattern] = [...ALLOWED_REGEX_ANCHORS['extensions/expose_api_client.mjs']];
    const root = fixtureRoot({
      'extensions/some_other_patch.mjs':
        'export default { verify: { present: "x" }, apply: (code) =>' +
        ` code.replace(new RegExp(${JSON.stringify(allowedPattern)}), "x") };\n`,
    });
    const offenders = scanMinifiedShapeAnchors(root);
    assert.equal(offenders.length, 1, 'allowlist is keyed per-file, not global');
  });

  it('the real patch tree is clean (every inline anchor is literal or allowlisted)', () => {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    assert.deepEqual(scanMinifiedShapeAnchors(root), []);
  });
});
