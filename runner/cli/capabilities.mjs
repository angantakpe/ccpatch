// A1: Capability-gate helpers, split out of cli.mjs so cmd-build.mjs and
// cmd-module.mjs can share them without importing the dispatcher (which would
// create a circular import). cli.mjs re-exports every symbol here so legacy
// callers (and tests) that did `import { findGateViolations } from
// '../runner/cli.mjs'` keep resolving unchanged.

import { classifyRisk, CAPABILITIES } from '../manifest.mjs';

/**
 * Parse --allow-capabilities argument. Accepts `all`, empty (none), or a
 * comma-separated list of capability names. Returns:
 *   { all: boolean, set: Set<string>, unknown: string[] }
 */
export function parseAllowCapabilities(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (trimmed === '' || trimmed === 'none') return { all: false, set: new Set(), unknown: [] };
  if (trimmed === 'all') return { all: true, set: new Set(CAPABILITIES), unknown: [] };
  const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
  const set = new Set();
  const unknown = [];
  for (const p of parts) {
    if (CAPABILITIES.includes(p)) set.add(p);
    else unknown.push(p);
  }
  return { all: false, set, unknown };
}

/**
 * S1: detect the blunt `--allow-capabilities=all` opt-out. When true, BOTH the
 * default-strict ack gate (network/exec/env) and the legacy high-risk gate are
 * short-circuited with no per-patch acknowledgement. Callers use this to print
 * a prominent warning and to persist a `capabilitiesGateBypassed` audit marker
 * into the release manifest, so a bundle built with the gate waved through is
 * traceable after the fact. Returns a plain boolean for an `allow` object as
 * produced by parseAllowCapabilities() (null-safe).
 */
export function isCapabilityGateBypassed(allow) {
  return !!(allow && allow.all === true);
}

/**
 * Given the patches selected for apply and the allow list, return list of
 * { name, capabilities, risk, missing } describing high-risk patches whose
 * capabilities are NOT all permitted by the allow list.
 */
export function findGateViolations(patches, names, allow, acks) {
  const ackMap = acks || {};
  const violations = [];
  for (const name of names) {
    const p = patches[name];
    if (!p) continue;
    const caps = Array.isArray(p.capabilities) ? p.capabilities : [];
    const risk = classifyRisk(caps);
    if (risk !== 'high') continue;
    if (allow && allow.all) continue;
    const allowSet = allow ? allow.set : new Set();
    // A cap is acknowledged if the `ack:` block lists it (or `*`) for this
    // patch, OR --allow-capabilities covers it. Without this, a patch acked in
    // ccpatch.yml (e.g. fetch_interceptor: [network]) would still be reported
    // here as "[missing: network]" because this gate used to read only `allow`.
    const ackedRaw = ackMap[name];
    const ackedAll = Array.isArray(ackedRaw) && ackedRaw.includes('*');
    if (ackedAll) continue;
    const ackedSet = new Set(Array.isArray(ackedRaw) ? ackedRaw : []);
    const missing = caps.filter(c => !allowSet.has(c) && !ackedSet.has(c));
    if (missing.length > 0) {
      violations.push({ name, capabilities: caps, risk, missing });
    }
  }
  return violations;
}

/**
 * Capabilities that require explicit acknowledgement (Track B default-strict).
 * These are the high-impact capabilities a user MUST opt into per patch
 * before the build will proceed.
 */
export const ACK_REQUIRED_CAPS = Object.freeze(['network', 'exec', 'env']);

/**
 * Given the patches selected for apply, a YAML `ack:` map, and an optional
 * --allow-capabilities allow list, return the list of patches whose ack-required
 * capabilities (network/exec/env) are not all covered.
 *
 * A patch's caps are covered if for every cap in ACK_REQUIRED_CAPS the patch
 * declares, EITHER:
 *   - the YAML `ack:` entry for that patch lists the cap (or `*`/`true`), OR
 *   - the --allow-capabilities flag covers the cap (set or `all`).
 */
export function findUnackedAckRequired(patches, names, acks, allow) {
  const ackMap = acks || {};
  const violations = [];
  for (const name of names) {
    const p = patches[name];
    if (!p) continue;
    const caps = Array.isArray(p.capabilities) ? p.capabilities : [];
    const ackTargets = caps.filter(c => ACK_REQUIRED_CAPS.includes(c));
    if (ackTargets.length === 0) continue;
    const ackedRaw = ackMap[name];
    const ackedAll = Array.isArray(ackedRaw) && ackedRaw.includes('*');
    const ackedSet = new Set(Array.isArray(ackedRaw) ? ackedRaw : []);
    const allowAll = !!(allow && allow.all);
    const allowSet = allow ? allow.set : new Set();
    const missing = ackTargets.filter(c => {
      if (ackedAll) return false;
      if (ackedSet.has(c)) return false;
      if (allowAll) return false;
      if (allowSet.has(c)) return false;
      return true;
    });
    if (missing.length > 0) {
      violations.push({ name, capabilities: caps, missing });
    }
  }
  return violations;
}
