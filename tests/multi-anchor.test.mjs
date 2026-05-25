import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveAnchor, resolveAnchorMatching, anchors } from '../runner/anchors.mjs';

describe('resolveAnchor — multi-tier anchors[]', () => {
  const id = '__test_multi_anchor__';
  const tiers = [
    { priority: 'primary',     pattern: /VERY_SPECIFIC_PATTERN_v1\(/ },
    { priority: 'fallback',    pattern: /SPECIFIC_PATTERN_[A-Z]+\(/ },
    { priority: 'last-resort', pattern: /PATTERN_\w+/ },
  ];

  function withEntry(entry, fn) {
    anchors[id] = entry;
    try { return fn(); } finally { delete anchors[id]; }
  }

  it('without code: returns the first tier (no probing)', () => {
    withEntry({ anchors: tiers }, () => {
      const r = resolveAnchor(id);
      assert.equal(r.source, 'registry-tier');
      assert.equal(r.priority, 'primary');
      assert.equal(r.pattern, tiers[0].pattern);
    });
  });

  it('with code: returns the first tier whose pattern matches', () => {
    withEntry({ anchors: tiers }, () => {
      // primary misses, fallback misses, last-resort matches
      const code = 'foo PATTERN_xyz bar';
      const r = resolveAnchorMatching(id, null, code);
      assert.equal(r.priority, 'last-resort');
    });
  });

  it('with code: primary wins when it matches', () => {
    withEntry({ anchors: tiers }, () => {
      const code = 'before VERY_SPECIFIC_PATTERN_v1(x) after';
      const r = resolveAnchorMatching(id, null, code);
      assert.equal(r.priority, 'primary');
    });
  });

  it('with code: falls through to default regex when no tier matches', () => {
    withEntry({ anchors: tiers, default: /FALLBACK_DEFAULT_\w+/ }, () => {
      const r = resolveAnchorMatching(id, null, 'unrelated content with FALLBACK_DEFAULT_xyz');
      assert.equal(r.source, 'registry-default');
    });
  });

  it('version-specific entry still wins over tier list', () => {
    const versioned = /VERSIONED_PATTERN/;
    withEntry({ anchors: tiers, '9.9.9': versioned }, () => {
      const r = resolveAnchor(id, '9.9.9');
      assert.equal(r.source, 'registry-version');
      assert.equal(r.pattern, versioned);
    });
  });

  it('existing single-default entries still resolve to registry-default', () => {
    withEntry({ default: /ORIGINAL_\w+/ }, () => {
      const r = resolveAnchor(id);
      assert.equal(r.source, 'registry-default');
    });
  });

  it('resets lastIndex on global tier regexes so reuse is safe', () => {
    const gTiers = [
      { priority: 'primary', pattern: /TICK_/g },
    ];
    withEntry({ anchors: gTiers }, () => {
      const code = 'TICK_ TICK_ TICK_';
      const r = resolveAnchorMatching(id, null, code);
      assert.equal(r.priority, 'primary');
      assert.equal(gTiers[0].pattern.lastIndex, 0);
    });
  });
});
