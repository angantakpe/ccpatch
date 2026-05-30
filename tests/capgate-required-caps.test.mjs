import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import directly from the capabilities submodule (the source of truth) rather
// than the cli.mjs re-export barrel, so this test exercises the gate logic
// regardless of which symbols cli.mjs chooses to re-export.
import {
  parseAllowCapabilities,
  findUnackedAckRequired,
  ACK_REQUIRED_CAPS,
  GATE_REQUIRED_CAPS,
} from '../runner/cli/capabilities.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Framework review finding #1: the unconditional (non-strict) build gate must
// require an ack for `tools` and `telemetry` too — not just network/exec/env —
// so the headless RCE stack (expose_tool_dispatch / expose_agent_tool, both
// capabilities:["tools"]) and telemetry-exfil patches cannot proceed in the
// default `make patch-claude-code` path without explicit acknowledgement.
// ─────────────────────────────────────────────────────────────────────────────

const PATCHES = {
  cosmetic:  { capabilities: [] },
  toolish:   { capabilities: ['tools'] },
  telem:     { capabilities: ['telemetry'] },
  netty:     { capabilities: ['network'] },
  rcestack:  { capabilities: ['tools', 'network', 'telemetry'] },
};

describe('GATE_REQUIRED_CAPS (finding #1)', () => {
  it('is a superset of ACK_REQUIRED_CAPS that adds tools + telemetry', () => {
    // ACK_REQUIRED_CAPS stays the original triple (used by `ccpatch ack`
    // default-write); GATE_REQUIRED_CAPS is what the build gate enforces.
    assert.deepEqual([...ACK_REQUIRED_CAPS].sort(), ['env', 'exec', 'network']);
    assert.deepEqual(
      [...GATE_REQUIRED_CAPS].sort(),
      ['env', 'exec', 'network', 'telemetry', 'tools'],
    );
    for (const c of ACK_REQUIRED_CAPS) {
      assert.ok(GATE_REQUIRED_CAPS.includes(c), `${c} should be gate-required`);
    }
  });
});

describe('findUnackedAckRequired — tools/telemetry now gated', () => {
  it('flags an unacked tools-only patch', () => {
    const v = findUnackedAckRequired(PATCHES, ['toolish'], null, null);
    assert.equal(v.length, 1, 'tools-only patch must trip the gate when unacked');
    assert.equal(v[0].name, 'toolish');
    assert.deepEqual(v[0].missing, ['tools']);
  });

  it('flags an unacked telemetry-only patch', () => {
    const v = findUnackedAckRequired(PATCHES, ['telem'], null, null);
    assert.equal(v.length, 1, 'telemetry-only patch must trip the gate when unacked');
    assert.equal(v[0].name, 'telem');
    assert.deepEqual(v[0].missing, ['telemetry']);
  });

  it('passes a tools-only patch acked via ccpatch.yml', () => {
    const v = findUnackedAckRequired(PATCHES, ['toolish'], { toolish: ['tools'] }, null);
    assert.deepEqual(v, []);
  });

  it('passes a telemetry-only patch acked via ccpatch.yml', () => {
    const v = findUnackedAckRequired(PATCHES, ['telem'], { telem: ['telemetry'] }, null);
    assert.deepEqual(v, []);
  });

  it('passes a tools-only patch acked via --allow-capabilities', () => {
    const allow = parseAllowCapabilities('tools');
    const v = findUnackedAckRequired(PATCHES, ['toolish'], null, allow);
    assert.deepEqual(v, []);
  });

  it('passes any patch under --allow-capabilities=all', () => {
    const allow = parseAllowCapabilities('all');
    const v = findUnackedAckRequired(PATCHES, ['toolish', 'telem', 'rcestack'], null, allow);
    assert.deepEqual(v, []);
  });

  it('flags every gate-required cap on the full RCE-stack patch when unacked', () => {
    const v = findUnackedAckRequired(PATCHES, ['rcestack'], null, null);
    assert.equal(v.length, 1);
    assert.deepEqual([...v[0].missing].sort(), ['network', 'telemetry', 'tools']);
  });

  it('reports only the still-unacked caps on a partially-acked patch', () => {
    // ack tools+network but NOT telemetry → telemetry must still be flagged.
    const v = findUnackedAckRequired(
      PATCHES, ['rcestack'], { rcestack: ['tools', 'network'] }, null,
    );
    assert.equal(v.length, 1);
    assert.deepEqual(v[0].missing, ['telemetry']);
  });

  it('zero-cap patches never violate', () => {
    assert.deepEqual(findUnackedAckRequired(PATCHES, ['cosmetic'], null, null), []);
  });
});
