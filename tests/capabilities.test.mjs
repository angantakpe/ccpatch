import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateManifest, classifyRisk, CAPABILITIES } from '../runner/manifest.mjs';
import {
  parseAllowCapabilities,
  findGateViolations,
  findUnackedAckRequired,
  ACK_REQUIRED_CAPS,
  parsePatchCliArgs,
  runPatchCli,
  runCapabilities,
  runAck,
  parseThreatModelTable,
} from '../runner/cli.mjs';
import { writeAck, readAcks } from '../runner/config.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Manifest validator: capabilities field
// ─────────────────────────────────────────────────────────────────────────────
describe('validateManifest — capabilities', () => {
  it('accepts the full set of known capabilities', () => {
    const mod = {
      description: 'ok',
      verify: { present: 'x', weak: true },
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
      verify: { present: 'x', weak: true },
      apply: () => '',
      capabilities: [],
    };
    const { ok, normalized } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, true);
    assert.deepEqual(normalized.capabilities, []);
    assert.equal(normalized.risk, 'low');
  });

  it('defaults to empty when capabilities omitted', () => {
    const mod = { description: 'ok', verify: { present: 'x', weak: true }, apply: () => '' };
    const { ok, normalized } = validateManifest(mod, 'p.mjs');
    assert.equal(ok, true);
    assert.deepEqual(normalized.capabilities, []);
    assert.equal(normalized.risk, 'low');
  });

  it('rejects unknown capability values', () => {
    const mod = {
      description: 'ok',
      verify: { present: 'x', weak: true },
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
      verify: { present: 'x', weak: true },
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
  // Minimal CJS-IIFE so required patches (overlay_loader, contracts, bun_shim)
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
      logger._err.some(line =>
        line.includes('--allow-capabilities') || line.includes('needs capability ack')
      ),
      `expected error mentioning capability ack, got: ${logger._err.join('\n')}`,
    );
  });

  it('passes the gate when --allow-capabilities matches', async () => {
    const { inputPath, outputPath } = makeFixture();
    const logger = captureLogger();
    // Apply will then fail downstream (the input file is not a real bundle),
    // but we only care that the gate itself does not reject.
    try {
      await runPatchCli(
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

// ─────────────────────────────────────────────────────────────────────────────
// Track B: default-strict ack gate for network/exec/env capabilities
// ─────────────────────────────────────────────────────────────────────────────
describe('findUnackedAckRequired', () => {
  const PATCHES = {
    cosmetic: { capabilities: [] },
    netty:    { capabilities: ['network'] },
    envy:     { capabilities: ['env'] },
    big:      { capabilities: ['network', 'env', 'exec'] },
    toolish:  { capabilities: ['tools'] }, // gate-required post-hardening (finding #1)
  };

  it('exports the ack-required capability list', () => {
    // ACK_REQUIRED_CAPS stays the network/exec/env triple — it drives the
    // `ccpatch ack` default-write set. The broader set the build gate enforces
    // (tools/telemetry too) lives in GATE_REQUIRED_CAPS; see
    // tests/capgate-required-caps.test.mjs.
    assert.deepEqual([...ACK_REQUIRED_CAPS].sort(), ['env', 'exec', 'network']);
  });

  it('zero-cap patches never violate', () => {
    assert.deepEqual(findUnackedAckRequired(PATCHES, ['cosmetic'], null, null), []);
  });

  it('tools-only patch IS now gate-required (finding #1 hardening)', () => {
    // Post-hardening: a `tools`-capable patch (the building block of the headless
    // RCE stack — expose_tool_dispatch / expose_agent_tool) must be explicitly
    // acked before the build proceeds, in every path. It previously only tripped
    // the strict-mode-only legacy gate.
    const v = findUnackedAckRequired(PATCHES, ['toolish'], null, null);
    assert.equal(v.length, 1);
    assert.equal(v[0].name, 'toolish');
    assert.deepEqual(v[0].missing, ['tools']);
  });

  it('unacked network patch violates', () => {
    const v = findUnackedAckRequired(PATCHES, ['netty'], null, null);
    assert.equal(v.length, 1);
    assert.deepEqual(v[0].missing, ['network']);
  });

  it('YAML ack covers the cap', () => {
    const v = findUnackedAckRequired(PATCHES, ['netty'], { netty: ['network'] }, null);
    assert.deepEqual(v, []);
  });

  it('--allow-capabilities covers the cap', () => {
    const allow = parseAllowCapabilities('network,env,exec');
    const v = findUnackedAckRequired(PATCHES, ['big'], null, allow);
    assert.deepEqual(v, []);
  });

  it('partial YAML ack still violates missing caps', () => {
    const v = findUnackedAckRequired(PATCHES, ['big'], { big: ['network'] }, null);
    assert.equal(v.length, 1);
    assert.deepEqual(v[0].missing, ['env', 'exec']);
  });
});

describe('Track B CLI ack gate', () => {
  function setupTempProject() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-ackcli-'));
    const inputPath = path.join(dir, 'in.js');
    fs.writeFileSync(inputPath, '(function(exports, require, module, __filename, __dirname) {/* dummy */\n});\n');
    return { dir, inputPath, outputPath: path.join(dir, 'out.js') };
  }

  function withCwd(dir, fn) {
    const prev = process.cwd();
    process.chdir(dir);
    return Promise.resolve(fn()).finally(() => process.chdir(prev));
  }

  it('unacked network patch fails build with new ack message', async () => {
    const { dir, inputPath, outputPath } = setupTempProject();
    // No ccpatch.yml → no acks. Pick the `webhook` patch (network+env+telemetry).
    const logger = captureLogger();
    const code = await withCwd(dir, () =>
      runPatchCli(
        [inputPath, outputPath, '--patch', 'webhook', '--version', '2.1.140'],
        logger,
      ),
    );
    assert.equal(code, 1);
    const errs = logger._err.join('\n');
    assert.ok(errs.includes('needs capability ack'), `expected ack error, got: ${errs}`);
    assert.ok(errs.includes('Add to ccpatch.yml'), `expected snippet hint, got: ${errs}`);
    assert.ok(errs.includes('--allow-unacked'), `expected --allow-unacked hint, got: ${errs}`);
  });

  it('YAML ack lets the patch pass the ack gate', async () => {
    const { dir, inputPath, outputPath } = setupTempProject();
    fs.writeFileSync(
      path.join(dir, 'ccpatch.yml'),
      // webhook declares network+env+telemetry; telemetry is gate-required
      // post-hardening (finding #1), so the ack must cover it too.
      'version: 1\nack:\n' +
      '  webhook: [network, env, telemetry]\n' +
      '  fetch_interceptor: [network]\n' +
      '  bun_shim: [env, network]\n' +
      '  tool_result_error_content: [network]\n',
    );
    const logger = captureLogger();
    try {
      await withCwd(dir, () =>
        runPatchCli(
          [inputPath, outputPath, '--patch', 'webhook', '--version', '2.1.140'],
          logger,
        ),
      );
    } catch {
      // downstream apply may fail; we only check the gate did not reject
    }
    const errs = logger._err.join('\n');
    assert.ok(!errs.includes('needs capability ack'),
      `gate should not have rejected; errs: ${errs}`);
  });

  it('--allow-capabilities also satisfies the ack gate', async () => {
    const { dir, inputPath, outputPath } = setupTempProject();
    const logger = captureLogger();
    try {
      await withCwd(dir, () =>
        runPatchCli(
          [
            inputPath, outputPath,
            '--patch', 'webhook',
            '--version', '2.1.140',
            '--allow-capabilities=all',
          ],
          logger,
        ),
      );
    } catch { /* downstream apply may fail */ }
    const errs = logger._err.join('\n');
    assert.ok(!errs.includes('needs capability ack'),
      `gate should not have rejected; errs: ${errs}`);
  });

  it('--allow-unacked warns but does not fail the gate', async () => {
    const { dir, inputPath, outputPath } = setupTempProject();
    const logger = captureLogger();
    try {
      await withCwd(dir, () =>
        runPatchCli(
          [
            inputPath, outputPath,
            '--patch', 'webhook',
            '--version', '2.1.140',
            '--allow-unacked',
          ],
          logger,
        ),
      );
    } catch { /* downstream apply may fail */ }
    const errs = logger._err.join('\n');
    const outs = logger._out.join('\n');
    assert.ok(!errs.includes('needs capability ack'),
      `gate should not have rejected; errs: ${errs}`);
    assert.ok(outs.includes('unacked capabilities') || outs.includes('[capabilities] WARN'),
      `expected warn line; outs: ${outs}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UX3: `ccpatch ack <patch>` — THREAT_MODEL parsing + ack-write helper
// ─────────────────────────────────────────────────────────────────────────────
describe('parseThreatModelTable', () => {
  const SRC = [
    '# threat model',
    '',
    '| Patch | Touches | Reads | Writes / Sends | Default |',
    '| --- | --- | --- | --- | --- |',
    '| `fetch_interceptor` | global fetch | every request | in-process only | on |',
    '| `bun_shim` | Bun polyfills | n/a | None | on |',
    '',
    'prose that is not a table',
  ].join('\n');

  it('captures the header row', () => {
    const t = parseThreatModelTable(SRC);
    assert.deepEqual(t.headers, ['Patch', 'Touches', 'Reads', 'Writes / Sends', 'Default']);
  });

  it('keys rows by de-backticked patch name', () => {
    const t = parseThreatModelTable(SRC);
    assert.ok(t.rows.fetch_interceptor);
    assert.equal(t.rows.fetch_interceptor[0], '`fetch_interceptor`');
    assert.equal(t.rows.fetch_interceptor[1], 'global fetch');
    assert.equal(t.rows.bun_shim[3], 'None');
  });

  it('returns empty for non-string / empty input', () => {
    assert.deepEqual(parseThreatModelTable(''), { headers: null, rows: {} });
    assert.deepEqual(parseThreatModelTable(null), { headers: null, rows: {} });
  });
});

describe('writeAck (config helper)', () => {
  function tmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-writeack-'));
    return { dir, ymlPath: path.join(dir, 'ccpatch.yml') };
  }

  it('creates ccpatch.yml when missing', () => {
    const { ymlPath } = tmp();
    const res = writeAck(ymlPath, 'fetch_interceptor', ['network']);
    assert.equal(res.created, true);
    assert.deepEqual(res.caps, ['network']);
    assert.deepEqual(readAcks(ymlPath), { fetch_interceptor: ['network'] });
  });

  it('appends a new entry to an existing ack block', () => {
    const { ymlPath } = tmp();
    fs.writeFileSync(ymlPath,
      'version: 1\nack:\n  bun_shim: [env, network]\n\npatches:\n  bun_shim: true\n');
    const res = writeAck(ymlPath, 'webhook', ['network', 'env']);
    assert.equal(res.created, false);
    const acks = readAcks(ymlPath);
    assert.deepEqual(acks.bun_shim, ['env', 'network']);
    assert.deepEqual(acks.webhook, ['network', 'env']);
    // patches block preserved.
    assert.ok(fs.readFileSync(ymlPath, 'utf8').includes('patches:'));
  });

  it('rewrites an existing entry, merging caps (union, order-stable)', () => {
    const { ymlPath } = tmp();
    fs.writeFileSync(ymlPath, 'version: 1\nack:\n  webhook: [network]\n');
    const res = writeAck(ymlPath, 'webhook', ['network', 'env']);
    assert.deepEqual(res.caps, ['network', 'env']);
    assert.deepEqual(readAcks(ymlPath), { webhook: ['network', 'env'] });
    // No duplicate entry was created.
    const occurrences = fs.readFileSync(ymlPath, 'utf8').match(/^\s+webhook:/gm) || [];
    assert.equal(occurrences.length, 1);
  });

  it('inserts an ack block before patches: when none exists', () => {
    const { ymlPath } = tmp();
    fs.writeFileSync(ymlPath, '# header comment\nversion: 1\n\npatches:\n  bun_shim: true\n');
    writeAck(ymlPath, 'bun_shim', ['env']);
    const src = fs.readFileSync(ymlPath, 'utf8');
    assert.ok(src.includes('# header comment'), 'comment preserved');
    assert.ok(src.indexOf('ack:') < src.indexOf('patches:'), 'ack block precedes patches');
    assert.deepEqual(readAcks(ymlPath), { bun_shim: ['env'] });
  });

  it('preserves the heavy comment block on update', () => {
    const { ymlPath } = tmp();
    const original =
      '# big comment\n# line 2\nversion: 1\nack:\n  # ack comment\n  fetch_interceptor: [network]\n\npatches:\n  x: true\n';
    fs.writeFileSync(ymlPath, original);
    writeAck(ymlPath, 'webhook', ['network']);
    const src = fs.readFileSync(ymlPath, 'utf8');
    assert.ok(src.includes('# big comment'));
    assert.ok(src.includes('# ack comment'));
    assert.deepEqual(readAcks(ymlPath), {
      fetch_interceptor: ['network'],
      webhook: ['network'],
    });
  });
});

describe('ccpatch ack <patch> (CLI)', () => {
  function tmpProject() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpatch-ackcmd-'));
    return { dir, ymlPath: path.join(dir, 'ccpatch.yml') };
  }
  function withCwd(dir, fn) {
    const prev = process.cwd();
    process.chdir(dir);
    return Promise.resolve(fn()).finally(() => process.chdir(prev));
  }

  it('parses the subcommand into a locked option shape', () => {
    assert.deepEqual(
      parsePatchCliArgs(['ack', 'webhook']),
      { ack: true, ackPatch: 'webhook', ackAllCaps: false, ackDryRun: false },
    );
    const dr = parsePatchCliArgs(['ack', 'webhook', '--dry-run', '--all-caps']);
    assert.equal(dr.ackDryRun, true);
    assert.equal(dr.ackAllCaps, true);
  });

  it('errors when no patch is given', () => {
    const opts = parsePatchCliArgs(['ack']);
    assert.ok(opts.error);
  });

  it('writes the ack entry and reports unknown patches', async () => {
    const { loadPatches } = await import('../runner/loader.mjs');
    const patches = await loadPatches();

    // Unknown patch → exit 1.
    const l1 = captureLogger();
    const c1 = await runAck({ options: { ackPatch: 'does_not_exist' }, patches, logger: l1 });
    assert.equal(c1, 1);
    assert.ok(l1._err.join('\n').includes('unknown patch'));

    // Real high-risk patch → writes ack + prints THREAT_MODEL row.
    const { dir, ymlPath } = tmpProject();
    const l2 = captureLogger();
    const c2 = await withCwd(dir, () =>
      runAck({ options: { ackPatch: 'webhook' }, patches, logger: l2 }));
    assert.equal(c2, 0);
    const outs = l2._out.join('\n');
    assert.ok(outs.includes('Capabilities:'), `expected caps line; got ${outs}`);
    assert.ok(outs.includes('THREAT_MODEL.md'), `expected threat-model section; got ${outs}`);
    const acks = readAcks(ymlPath);
    // webhook declares network, env, telemetry → only ack-required caps written.
    assert.deepEqual([...acks.webhook].sort(), ['env', 'network']);
  });

  it('--dry-run does not modify ccpatch.yml', async () => {
    const { loadPatches } = await import('../runner/loader.mjs');
    const patches = await loadPatches();
    const { dir, ymlPath } = tmpProject();
    const logger = captureLogger();
    const code = await withCwd(dir, () =>
      runAck({ options: { ackPatch: 'webhook', ackDryRun: true }, patches, logger }));
    assert.equal(code, 0);
    assert.ok(logger._out.join('\n').includes('[dry-run]'));
    assert.equal(fs.existsSync(ymlPath), false);
  });
});
