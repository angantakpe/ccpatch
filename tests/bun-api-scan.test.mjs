// tests/bun-api-scan.test.mjs — unit tests for the build-time Bun API
// coverage scanner (scripts/scan-bun-api.mjs).
//
// Covers, against small synthetic fixtures (no real bundle needed):
//   - the bundle regex scan (counts, dedupe, sort, string-literal over-report
//     is documented behavior)
//   - the shim payload key parser (nested braces, strings with braces,
//     comments, the real committed payload)
//   - all three drift classes: (a) used-but-unshimmed, (b) used-but-degraded,
//     (c) new vs the previous version's baseline
//   - baseline selection (newest strictly-older version wins)
//   - lockstep between refmaps/bun-api-coverage.json and the committed
//     polyfill payload, and schema of the committed usage baseline(s)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PROJECT_ROOT,
  scanBundle,
  parseShimKeys,
  readShimKeys,
  loadCoverage,
  classifyUsage,
  findPreviousBaseline,
  loadBaseline,
  writeBaseline,
  baselinePathFor,
  renderReport,
  runBunApiScan,
} from '../scripts/scan-bun-api.mjs';

const COVERAGE_PATH = path.join(PROJECT_ROOT, 'refmaps', 'bun-api-coverage.json');
const PAYLOAD_PATH = path.join(PROJECT_ROOT, 'runner', 'shims', 'bun-polyfill-v1.js.txt');

// ── Synthetic fixtures ───────────────────────────────────────────────────────

// A tiny "bundle" exercising every match shape the scanner cares about:
// repeated member access, access via globalThis.Bun, a string-literal mention
// (counted — the scanner over-reports by design), and near-misses that must
// NOT match (suffixed identifier, different global).
const FIXTURE_BUNDLE = [
  'function a(x){return Bun.spawn([x,"--version"],{})}',
  'async function b(){await Bun.spawn(["ls"]);return Bun.hash("k").toString(36)}',
  'function c(){if(typeof globalThis.Bun<"u")return globalThis.Bun.which("rg")}',
  'function d(){throw new Error("Bun.Terminal unavailable (running under Node?)")}',
  'var notBun = { NotBun: 1 }; NotBun.spawn; fakeBun.gc; BunX.listen;',
  'function e(){return new Bun.Terminal({cols:80})}',
  'function f(){return Bun.deepEquals({a:1},{a:1})}',
].join('\n');

// A synthetic polyfill payload with the traps the parser must survive: leading
// prose, comments containing braces and fake keys, string values containing
// braces/colons, nested object + function values, getters/spreads skipped.
const FIXTURE_PAYLOAD = `
// preamble — not the object: fake = { decoy: 1 }
if (typeof globalThis.Bun === 'undefined') {
  (function () {
    var helper = { notAKey: true };
    globalThis.Bun = {
      // comment with braces { nope: 1 } and a colon nope:
      version: '0.0.0-{shim}', // trailing comment, deceptive: yes
      spawn: function (args) { return { exited: Promise.resolve(0) }; },
      semver: { order: function (a, b) { return 0; }, satisfies: () => false },
      /* block comment fakeKey: 1 */
      Terminal: function () { throw new Error('nope: {brace}'); },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      stdin: process.stdin,
      "ignored-string-key-form": 1,
      hash: function (s) { return BigInt(1); },
    };
  })();
}
`;

const FIXTURE_COVERAGE = {
  apis: {
    version: { status: 'degraded', caveat: 'stub version string' },
    spawn: { status: 'degraded', caveat: 'sync, 5s cap, blocks event loop' },
    semver: { status: 'full', caveat: '' },
    Terminal: { status: 'throws', caveat: 'PTY host unavailable; throws by design' },
    sleep: { status: 'full', caveat: '' },
    stdin: { status: 'degraded', caveat: 'Node stream, not a BunFile' },
    hash: { status: 'degraded', caveat: 'FNV-1a, not Wyhash' },
  },
};

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-bun-api-scan-'));
}

/** Materialize fixture payload/coverage/baselines into a tmp dir layout. */
function mkFixtureRepo({ baselines = {} } = {}) {
  const root = mkTmpDir();
  const refmaps = path.join(root, 'refmaps');
  fs.mkdirSync(refmaps, { recursive: true });
  const payloadPath = path.join(root, 'bun-polyfill-fixture.js.txt');
  fs.writeFileSync(payloadPath, FIXTURE_PAYLOAD, 'utf8');
  const coveragePath = path.join(refmaps, 'bun-api-coverage.json');
  fs.writeFileSync(coveragePath, JSON.stringify(FIXTURE_COVERAGE, null, 2), 'utf8');
  for (const [version, apis] of Object.entries(baselines)) {
    fs.writeFileSync(
      baselinePathFor(version, refmaps),
      JSON.stringify({ ccVersion: version, scanner: 'regex-v1', apis }, null, 2),
      'utf8'
    );
  }
  return { root, refmaps, payloadPath, coveragePath };
}

// ── scanBundle ───────────────────────────────────────────────────────────────

describe('scanBundle (regex usage scan)', () => {
  it('dedupes to sorted names with occurrence counts', () => {
    const { apis, totalSites } = scanBundle(FIXTURE_BUNDLE);
    assert.deepEqual(apis, {
      Terminal: 2, // 1 real `new Bun.Terminal`, 1 string-literal mention (documented over-report)
      deepEquals: 1,
      hash: 1,
      spawn: 2,
      which: 1, // via globalThis.Bun.which
    });
    assert.equal(totalSites, 7);
    assert.deepEqual(Object.keys(apis), [...Object.keys(apis)].sort());
  });

  it('does not match suffixed/foreign identifiers (NotBun, fakeBun, BunX)', () => {
    const { apis } = scanBundle('NotBun.spawn(); fakeBun.gc(); BunX.listen();');
    assert.deepEqual(apis, {});
  });

  it('counts string-literal mentions (over-report is the documented trade)', () => {
    const { apis } = scanBundle('var s = "uses Bun.stdin in a message";');
    assert.deepEqual(apis, { stdin: 1 });
  });
});

// ── parseShimKeys ────────────────────────────────────────────────────────────

describe('parseShimKeys (polyfill payload key parser)', () => {
  it('extracts top-level keys only, surviving comments/strings/nesting', () => {
    assert.deepEqual(parseShimKeys(FIXTURE_PAYLOAD), [
      'Terminal', 'hash', 'semver', 'sleep', 'spawn', 'stdin', 'version',
    ]);
  });

  it('throws loudly when no Bun object literal is present', () => {
    assert.throws(() => parseShimKeys('var x = 1;'), /no `Bun = \{` object literal/);
  });

  it('parses the real committed payload and finds the known shim keys', () => {
    const keys = readShimKeys(PAYLOAD_PATH);
    for (const expected of ['spawn', 'Terminal', 'stdin', 'stringWidth', 'hash', 'YAML', 'listen', 'deepEquals']) {
      assert.ok(keys.includes(expected), `expected real payload to shim ${expected}`);
    }
    // Sanity floor: the real shim object is substantial.
    assert.ok(keys.length >= 20, `expected >=20 shim keys, got ${keys.length}`);
  });
});

// ── classifyUsage: the three drift classes ───────────────────────────────────

describe('classifyUsage (drift classes a/b/c)', () => {
  const shimKeys = parseShimKeys(FIXTURE_PAYLOAD);
  const usage = scanBundle(FIXTURE_BUNDLE);

  it('(a) used-but-unshimmed APIs are isolated as errors', () => {
    const r = classifyUsage({ usage, shimKeys, coverage: FIXTURE_COVERAGE });
    assert.deepEqual(r.unshimmed, [
      { name: 'deepEquals', count: 1 },
      { name: 'which', count: 1 },
    ]);
  });

  it('(b) degraded/throwing shims carry their coverage caveat', () => {
    const r = classifyUsage({ usage, shimKeys, coverage: FIXTURE_COVERAGE });
    const byName = Object.fromEntries(r.degraded.map(e => [e.name, e]));
    assert.equal(byName.spawn.caveat, 'sync, 5s cap, blocks event loop');
    assert.equal(byName.spawn.status, 'degraded');
    assert.equal(byName.Terminal.status, 'throws');
    assert.ok(!('semver' in byName), 'full-status APIs are not flagged degraded');
  });

  it('(b) shimmed-but-unclassified APIs degrade loudly, never silently pass', () => {
    const cov = { apis: { ...FIXTURE_COVERAGE.apis } };
    delete cov.apis.hash;
    const r = classifyUsage({ usage, shimKeys, coverage: cov });
    const hash = r.degraded.find(e => e.name === 'hash');
    assert.ok(hash, 'unclassified shim key should be reported');
    assert.match(hash.caveat, /unclassified/);
  });

  it('(a) ground truth is the payload: stale coverage entries do not count as shimmed', () => {
    const usage2 = scanBundle('Bun.gc();');
    const cov = { apis: { gc: { status: 'full', caveat: '' } } }; // stale: not in payload
    const r = classifyUsage({ usage: usage2, shimKeys, coverage: cov });
    assert.deepEqual(r.unshimmed, [{ name: 'gc', count: 1 }]);
  });

  it('(c) new APIs vs the previous baseline are highlighted', () => {
    const baseline = { version: '2.1.160', apis: { spawn: 4, Terminal: 2, hash: 6, which: 2 } };
    const r = classifyUsage({ usage, shimKeys, coverage: FIXTURE_COVERAGE, baseline });
    assert.deepEqual(r.newApis, ['deepEquals']);
  });

  it('(c) without a baseline, newApis is null (reported as "no baseline")', () => {
    const r = classifyUsage({ usage, shimKeys, coverage: FIXTURE_COVERAGE, baseline: null });
    assert.equal(r.newApis, null);
  });
});

// ── Baseline selection / round-trip ──────────────────────────────────────────

describe('baseline selection and round-trip', () => {
  it('picks the newest baseline strictly older than the scanned version', () => {
    const { refmaps } = mkFixtureRepo({
      baselines: {
        '2.1.148': { spawn: 1 },
        '2.1.160': { spawn: 2 },
        '2.1.175': { spawn: 3 },
      },
    });
    assert.equal(findPreviousBaseline('2.1.175', refmaps).version, '2.1.160');
    assert.equal(findPreviousBaseline('2.1.999', refmaps).version, '2.1.175');
    assert.equal(findPreviousBaseline('2.1.100', refmaps), null);
    // No version given: newest overall.
    assert.equal(findPreviousBaseline(null, refmaps).version, '2.1.175');
  });

  it('writeBaseline → loadBaseline round-trips names and counts', () => {
    const refmaps = mkTmpDir();
    const usage = scanBundle(FIXTURE_BUNDLE);
    writeBaseline({ version: '9.9.9', usage, refmapsDir: refmaps });
    const loaded = loadBaseline('9.9.9', refmaps);
    assert.deepEqual(loaded.apis, usage.apis);
  });

  it('returns null for a missing refmaps dir instead of throwing', () => {
    assert.equal(findPreviousBaseline('2.1.175', path.join(os.tmpdir(), 'ccp-no-such-dir')), null);
  });
});

// ── runBunApiScan end-to-end on fixtures ─────────────────────────────────────

describe('runBunApiScan (end-to-end on fixtures)', () => {
  it('produces all three report classes in the rendered lines', () => {
    const { refmaps, payloadPath, coveragePath } = mkFixtureRepo({
      baselines: { '2.1.160': { spawn: 4, Terminal: 2, hash: 6, which: 2, deepEquals: 1 } },
    });
    const scan = runBunApiScan({
      code: FIXTURE_BUNDLE,
      bundleLabel: 'fixture.cjs',
      version: '2.1.175',
      refmapsDir: refmaps,
      shimPayloadPath: payloadPath,
      coveragePath,
    });
    assert.deepEqual(scan.unshimmed.map(e => e.name), ['deepEquals', 'which']);
    const text = scan.lines.join('\n');
    assert.match(text, /UNSHIMMED \(2\)/);
    assert.match(text, /Bun\.deepEquals/);
    assert.match(text, /degraded\/throwing shims in use/);
    assert.match(text, /sync, 5s cap, blocks event loop/);
    // which is in the 2.1.160 baseline-fixture, deepEquals too → no new APIs.
    assert.deepEqual(scan.newApis, []);
    assert.match(text, /drift vs v2\.1\.160 baseline: none/);
  });

  it('flags a NEW Bun dependency against the previous version baseline', () => {
    const { refmaps, payloadPath, coveragePath } = mkFixtureRepo({
      baselines: { '2.1.160': { spawn: 4, Terminal: 2, hash: 6 } },
    });
    const scan = runBunApiScan({
      code: FIXTURE_BUNDLE,
      version: '2.1.175',
      refmapsDir: refmaps,
      shimPayloadPath: payloadPath,
      coveragePath,
    });
    assert.deepEqual(scan.newApis, ['deepEquals', 'which']);
    assert.match(scan.lines.join('\n'), /NEW vs v2\.1\.160 baseline \(2\)/);
  });

  it('renderReport says so when every API is shimmed and clean', () => {
    const usage = scanBundle('Bun.sleep(1);');
    const result = classifyUsage({
      usage,
      shimKeys: parseShimKeys(FIXTURE_PAYLOAD),
      coverage: FIXTURE_COVERAGE,
    });
    const text = renderReport({ usage, result, baseline: null, bundleLabel: 'x', version: null }).join('\n');
    assert.match(text, /unshimmed: none/);
    assert.match(text, /no earlier baseline/);
  });
});

// ── Committed artifacts stay coherent ────────────────────────────────────────

describe('committed coverage + baseline artifacts', () => {
  it('refmaps/bun-api-coverage.json is in lockstep with the polyfill payload', () => {
    const coverage = loadCoverage(COVERAGE_PATH);
    const covKeys = Object.keys(coverage.apis).sort();
    const shimKeys = readShimKeys(PAYLOAD_PATH);
    assert.deepEqual(
      covKeys,
      shimKeys,
      'coverage map and bun-polyfill payload keys diverged — update refmaps/bun-api-coverage.json'
    );
  });

  it('every coverage entry has a valid status, and non-full entries a caveat', () => {
    const coverage = loadCoverage(COVERAGE_PATH);
    for (const [name, entry] of Object.entries(coverage.apis)) {
      assert.ok(
        ['full', 'degraded', 'throws'].includes(entry.status),
        `${name}: invalid status ${entry.status}`
      );
      if (entry.status !== 'full') {
        assert.ok(
          typeof entry.caveat === 'string' && entry.caveat.length > 0,
          `${name}: ${entry.status} entries need a one-line caveat`
        );
      }
    }
  });

  it('committed usage baselines contain only API names and counts', () => {
    const refmaps = path.join(PROJECT_ROOT, 'refmaps');
    const files = fs.readdirSync(refmaps).filter(f => /^bun-api-usage\.v\d+\.\d+\.\d+\.json$/.test(f));
    assert.ok(files.length >= 1, 'expected at least one committed bun-api-usage baseline');
    for (const f of files) {
      const parsed = JSON.parse(fs.readFileSync(path.join(refmaps, f), 'utf8'));
      assert.equal(typeof parsed.ccVersion, 'string');
      assert.equal(typeof parsed.apis, 'object');
      for (const [name, count] of Object.entries(parsed.apis)) {
        assert.match(name, /^[A-Za-z_$][\w$]*$/, `${f}: ${name} is not a bare API name`);
        assert.ok(Number.isInteger(count) && count > 0, `${f}: ${name} count must be a positive int`);
      }
    }
  });
});
