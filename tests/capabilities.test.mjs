import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateManifest, classifyRisk, CAPABILITIES } from '../runner/manifest.mjs';
import {
  parseAllowCapabilities,
  findGateViolations,
  parsePatchCliArgs,
  runPatchCli,
  runCapabilities,
} from '../runner/cli.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Manifest validator: capabilities field
// ─────────────────────────────────────────────────────────────────────────────
describe('validateManifest — capabilities', () => {
  it('accepts the full set of known capabilities', () => {
    const mod = {
      description: 'ok',
      verify: { present: 'x' },
      apply: () => '',
      capabilities: [...CAPABILITIES],
    };
    const { ok, errors, normalized } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, true, `unexpected: ${errors.join('; ')}`);
    assert.deepEqual(normalized.capabilities, [...CAPABILITIES]);
    assert.equal(normalized.risk, 'high');
  });

  it('accepts an empty capabilities array', () => {
    const mod = {
      description: 'ok',
      verify: { present: 'x' },
      apply: () => '',
      capabilities: [],
    };
    const { ok, normalized } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, true);
    assert.deepEqual(normalized.capabilities, []);
    assert.equal(normalized.risk, 'low');
  });

  it('defaults to empty when capabilities omitted', () => {
    const mod = { description: 'ok', verify: { present: 'x' }, apply: () => '' };
    const { ok, normalized } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, true);
    assert.deepEqual(normalized.capabilities, []);
    assert.equal(normalized.risk, 'low');
  });

  it('rejects unknown capability values', () => {
    const mod = {
      description: 'ok',
      verify: { present: 'x' },
      apply: () => '',
      capabilities: ['network', 'rocket-launch'],
    };
    const { ok, errors } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, false);
    assert.ok(
      errors.some(e => e.includes('rocket-launch')),
      `errors: ${errors.join('; ')}`,
    );
  });

  it('rejects non-array capabilities', () => {
    const mod = {
      description: 'ok',
      verify: { present: 'x' },
      apply: () => '',
      capabilities: 'network',
    };
    const { ok, errors } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, false);
    assert.ok(errors.some(e => e.includes('capabilities must be an array')));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Risk classifier
// ─────────────────────────────────────────────────────────────────────────────
describe('classifyRisk', () => {
  it('returns low for empty and undefined', () => {
    assert.equal(classifyRisk([]), 'low');
    assert.equal(classifyRisk(undefined), 'low');
    assert.equal(classifyRisk(null), 'low');
  });

  it('returns medium for prompt/fs/env only', () => {
    assert.equal(classifyRisk(['prompt']), 'medium');
    assert.equal(classifyRisk(['fs']), 'medium');
    assert.equal(classifyRisk(['env']), 'medium');
    assert.equal(classifyRisk(['prompt', 'fs', 'env']), 'medium');
  });

  it('returns high when any of network/tools/exec/telemetry is present', () => {
    assert.equal(classifyRisk(['network']), 'high');
    assert.equal(classifyRisk(['tools']), 'high');
    assert.equal(classifyRisk(['exec']), 'high');
    assert.equal(classifyRisk(['telemetry']), 'high');
    assert.equal(classifyRisk(['prompt', 'network']), 'high');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// --allow-capabilities parsing
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAllowCapabilities', () => {
  it('parses "all" as wildcard', () => {
    const r = parseAllowCapabilities('all');
    assert.equal(r.all, true);
  });

  it('parses comma-separated list', () => {
    const r = parseAllowCapabilities('network,fs,exec');
    assert.equal(r.all, false);
    assert.ok(r.set.has('network'));
    assert.ok(r.set.has('fs'));
    assert.ok(r.set.has('exec'));
    assert.deepEqual(r.unknown, []);
  });

  it('captures unknown values', () => {
    const r = parseAllowCapabilities('network,banana');
    assert.deepEqual(r.unknown, ['banana']);
  });

  it('parses "none"/empty as empty set', () => {
    assert.equal(parseAllowCapabilities('none').set.size, 0);
    assert.equal(parseAllowCapabilities('').set.size, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLI arg parser picks up --allow-capabilities
// ─────────────────────────────────────────────────────────────────────────────
describe('parsePatchCliArgs — --allow-capabilities', () => {
  it('reads --allow-capabilities <value>', () => {
    const opts = parsePatchCliArgs(['in.js', 'out.js', '--allow-capabilities', 'network,fs']);
    assert.equal(opts.patchOptions.allowCapabilitiesRaw, 'network,fs');
  });

  it('reads --allow-capabilities=value', () => {
    const opts = parsePatchCliArgs(['in.js', 'out.js', '--allow-capabilities=all']);
    assert.equal(opts.patchOptions.allowCapabilitiesRaw, 'all');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gate logic
// ─────────────────────────────────────────────────────────────────────────────
const FAKE_PATCHES = {
  cosmetic:   { capabilities: [] },
  textmod:    { capabilities: ['prompt'] },
  netty:      { capabilities: ['network'] },
  beast:      { capabilities: ['network', 'fs', 'exec'] },
};

describe('findGateViolations', () => {
  it('low/medium-risk patches never violate', () => {
    const v = findGateViolations(FAKE_PATCHES, ['cosmetic', 'textmod'], null);
    assert.deepEqual(v, []);
  });

  it('high-risk patch with no allow list violates', () => {
    const v = findGateViolations(FAKE_PATCHES, ['netty'], null);
    assert.equal(v.length, 1);
    assert.equal(v[0].name, 'netty');
    assert.deepEqual(v[0].missing, ['network']);
  });

  it('high-risk patch with full allow list passes', () => {
    const allow = parseAllowCapabilities('network,fs,exec');
    const v = findGateViolations(FAKE_PATCHES, ['beast'], allow);
    assert.deepEqual(v, []);
  });

  it('partial allow list still violates missing caps', () => {
    const allow = parseAllowCapabilities('network');
    const v = findGateViolations(FAKE_PATCHES, ['beast'], allow);
    assert.equal(v.length, 1);
    assert.deepEqual(v[0].missing, ['fs', 'exec']);
  });

  it('--allow-capabilities=all permits everything', () => {
    const allow = parseAllowCapabilities('all');
    const v = findGateViolations(FAKE_PATCHES, ['beast', 'netty'], allow);
    assert.deepEqual(v, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Strict-mode end-to-end gate (uses the real CLI entry point with a
// purpose-built fake input file so we don't need a real Claude bundle).
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-caps-'));
  const inputPath = path.join(dir, 'in.js');
  // Minimal CJS-IIFE so required patches (overlay_loader, contracts, fix_bun_shim)
  // find their boot anchor and apply silently instead of printing [!] warnings.
  fs.writeFileSync(inputPath, '(function(exports, require, module, __filename, __dirname) {/* dummy */\n});\n');
  return { dir, inputPath, outputPath: path.join(dir, 'out.js') };
}

function captureLogger() {
  const out = [];
  const err = [];
  return {
    log: (...a) => out.push(a.join(' ')),
    warn: (...a) => out.push(a.join(' ')),
    error: (...a) => err.push(a.join(' ')),
    _out: out,
    _err: err,
  };
}

describe('strict-mode capability gate (CLI)', () => {
  it('exits non-zero when a high-risk patch is selected without --allow-capabilities', async () => {
    // Use a real patch that is known high-risk: webhook (network, env, telemetry).
    const { inputPath, outputPath } = makeFixture();
    const logger = captureLogger();
    const code = await runPatchCli(
      [inputPath, outputPath, '--patch', 'webhook', '--strict', '--version', '2.1.140'],
      logger,
    );
    assert.equal(code, 1);
    assert.ok(
      logger._err.some(line => line.includes('--allow-capabilities')),
      `expected error mentioning --allow-capabilities, got: ${logger._err.join('\n')}`,
    );
  });

  it('passes the gate when --allow-capabilities matches', async () => {
    const { inputPath, outputPath } = makeFixture();
    const logger = captureLogger();
    // Apply will then fail downstream (the input file is not a real bundle),
    // but we only care that the gate itself does not reject.
    let code;
    try {
      code = await runPatchCli(
        [
          inputPath, outputPath,
          '--patch', 'webhook',
          '--strict',
          '--version', '2.1.140',
          '--allow-capabilities=all',
        ],
        logger,
      );
    } catch (err) {
      // Downstream apply errors are fine for this test; the gate accepted us.
      assert.ok(
        !logger._err.some(line => line.includes('--allow-capabilities')),
        `gate should not have rejected; err lines: ${logger._err.join('\n')}`,
      );
      return;
    }
    // If it returns a code, make sure no gate-related rejection happened.
    assert.ok(
      !logger._err.some(line => line.includes('--allow-capabilities')),
      `gate should not have rejected; err lines: ${logger._err.join('\n')}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `ccpatch capabilities --json`
// ─────────────────────────────────────────────────────────────────────────────
describe('ccpatch capabilities --json', () => {
  it('emits JSON with patches[] and summary{}', async () => {
    const opts = parsePatchCliArgs(['capabilities', '--json']);
    assert.equal(opts.capabilities, true);
    assert.equal(opts.json, true);

    const { loadPatches } = await import('../runner/loader.mjs');
    const patches = await loadPatches();

    const logger = captureLogger();
    const code = await runCapabilities({ profile: null, json: true }, patches, logger);
    assert.equal(code, 0);

    // First (and only expected) line is the JSON blob.
    const joined = logger._out.join('\n');
    const data = JSON.parse(joined);
    assert.ok(Array.isArray(data.patches));
    assert.ok(data.patches.length > 0);
    assert.ok(typeof data.summary === 'object');
    // Known assignments from our audit:
    const byName = Object.fromEntries(data.patches.map(p => [p.name, p]));
    assert.deepEqual(byName.webhook.capabilities.sort(),
      ['env', 'network', 'telemetry'].sort());
    assert.equal(byName.webhook.risk, 'high');
    assert.equal(byName.react_singleton.risk, 'low');
    // Summary tally should count webhook in network/env/telemetry buckets.
    assert.ok(data.summary.network >= 1);
    assert.ok(data.summary.telemetry >= 1);
  });
});
