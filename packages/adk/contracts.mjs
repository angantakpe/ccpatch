/**
 * contracts.mjs — the ADK's single source of truth for the __ccp* typed
 * contracts it consumes, and the minimum version/shape it requires of each.
 *
 * WHY: the ADK consumes globals (__ccpRawTools / __ccpRegisterTool,
 * __ccpAgentTool, __ccpSetSystemPrompt, __ccpSubmitInput, __ccpBus) that are
 * produced by separate ccpatch patches. Each producer registers a typed
 * contract via __ccpProvide(name, { version, shape, value }) — see
 * core/contracts.mjs. Before this module existed, every ADK call site
 * hardcoded its own minVersion/shape inline (capabilities() in index.mjs,
 * gatedPathTrusted() in tool-registry.mjs, assertSystemPromptContract() in
 * handoff.mjs), so the pins could drift apart from each other — and from the
 * producers — without detection. All ADK contract consumption now routes
 * through checkContract(), which validates via
 * __ccpRequire(name, { minVersion, shape }) against the single pin table
 * below.
 *
 * FAIL-OPEN BY DESIGN (mirrors core/contracts.mjs "opt-in per boundary"):
 * a host with NO registry helpers, or NO registered entry for a contract, is
 * reported 'unchecked' — bare-global test stubs keep working unchanged. Only
 * a REGISTERED contract can prove drift, and proven drift is refused loudly
 * with a reason naming the contract, the producer's advertised version, and
 * the ADK's required minimum.
 */

import { host } from './host.mjs';

/**
 * @typedef {Object} ContractRequirement
 * @property {string} capability    The capabilities() boolean this contract gates.
 * @property {string} consumer      Consumer id passed to __ccpRequire (error attribution).
 * @property {number} minVersion    Minimum producer contract version the ADK supports.
 * @property {readonly string[]} shape  Dotted value paths the producer MUST satisfy.
 * @property {string} producerPatch The ccpatch patch expected to produce this contract.
 */

/**
 * The pin table. One entry per __ccp* contract the ADK consumes.
 *
 * Version pins (producer evidence, in-repo):
 *  - toolDispatch v2 — expose_tool_dispatch registers v2; v2 added the
 *    nonce-gated registerTool/unregisterTool pair the ADK injects through.
 *    A v1 host has no gated registrar → the ADK must not trust the gated path.
 *  - agentTool v1 — expose_agent_tool registers v1 with shape
 *    ['_capture','invoke']; the ADK only needs 'invoke' for delegate handoffs.
 *  - systemPrompt v2 — expose_system_prompt registers v2; v2 added the
 *    getNonce gate. A v1 host writes personas without the nonce gate, which
 *    handoff refuses (see SECURITY notes in README).
 *  - submitInput v1 — expose_submit_input registers v1 (no shape claims;
 *    the value IS the callable adapter).
 *  - bus v1 — event_bus registers v1 with shape ['on','emit','topics']; the
 *    ADK requires 'emit' (useAgentBus / event emission).
 *
 * @type {Readonly<Record<string, Readonly<ContractRequirement>>>}
 */
export const ADK_CONTRACT_REQUIREMENTS = Object.freeze({
  toolDispatch: Object.freeze({
    capability: 'tools',
    consumer: 'adk:tools',
    minVersion: 2,
    shape: Object.freeze(['registerTool']),
    producerPatch: 'expose_tool_dispatch',
  }),
  agentTool: Object.freeze({
    capability: 'delegate',
    consumer: 'adk:handoff',
    minVersion: 1,
    shape: Object.freeze(['invoke']),
    producerPatch: 'expose_agent_tool',
  }),
  systemPrompt: Object.freeze({
    capability: 'swap',
    consumer: 'adk:handoff',
    minVersion: 2,
    shape: Object.freeze(['getNonce']),
    producerPatch: 'expose_system_prompt',
  }),
  submitInput: Object.freeze({
    capability: 'router',
    consumer: 'adk:router',
    minVersion: 1,
    shape: Object.freeze([]),
    producerPatch: 'expose_submit_input',
  }),
  bus: Object.freeze({
    capability: 'bus',
    consumer: 'adk:bus',
    minVersion: 1,
    shape: Object.freeze(['emit']),
    producerPatch: 'event_bus',
  }),
});

/**
 * @typedef {Object} ContractCheckResult
 * @property {'unchecked'|'ok'|'drift'} status
 *   - 'unchecked': nothing to prove — no registry helpers, or the contract is
 *     not registered. Fail-open: the caller should proceed on its direct
 *     global probe (and NOT memoize, so a late-populating registry is honored).
 *   - 'ok': a registered contract positively validated against the pin.
 *   - 'drift': a registered contract FAILED the pin — refuse loudly.
 * @property {'require'|'advertised'} [via]  How an 'ok' was proven: 'require'
 *   means __ccpRequire probed the actual value paths (strongest — safe to
 *   memoize); 'advertised' means only the registry metadata was available.
 * @property {string} [reason]  For 'drift': names the contract, the producer's
 *   version, and the ADK's required minimum/shape. Actionable as-is.
 * @property {{name:string,version:number,producer:string,shape:string[]}} [entry]
 *   The registry entry that was checked (when one was found).
 * @property {*} [value]  The contract value, when validated via __ccpRequire.
 */

/**
 * Validate one ADK contract dependency against the live registry.
 *
 * Order of checks:
 *   1. advertised metadata (entry.version < pinned minVersion, and a non-empty
 *      shape claim missing required keys) — ALL failures are gathered into one
 *      drift reason so the report names the complete mismatch,
 *   2. __ccpRequire(name, { consumer, minVersion, shape }) — actual
 *      value-path probing, when the helper exists.
 * Step 1 works from __ccpInspectContracts metadata alone, so drift is still
 * caught on hosts where __ccpRequire is missing/broken.
 *
 * NEVER throws. Advisory by construction — callers decide whether 'drift'
 * downgrades a capability (capabilities()), refuses an injection
 * (tool-registry), or throws at a write site (handoff).
 *
 * @param {string} name  A key of ADK_CONTRACT_REQUIREMENTS.
 * @returns {ContractCheckResult}
 */
export function checkContract(name) {
  const req = ADK_CONTRACT_REQUIREMENTS[name];
  if (!req) return { status: 'unchecked', reason: `unknown ADK contract "${name}"` };

  const inspect = host.inspectContracts();
  if (typeof inspect !== 'function') return { status: 'unchecked' };

  let entry;
  try {
    entry = inspect().find((e) => e && e.name === name);
  } catch (_) {
    // The inspector itself is broken — we cannot prove drift. Fail open.
    return { status: 'unchecked' };
  }
  if (!entry) return { status: 'unchecked' }; // opt-in boundary not registered

  // 1–2. Advertised metadata against the pin. ALL failures are gathered into
  // one reason (version gap AND every missing shape key) so the report names
  // the complete mismatch, not just the first symptom.
  const issues = [];
  if (typeof entry.version === 'number' && entry.version < req.minVersion) {
    issues.push(`v${entry.version} < required v${req.minVersion}`);
  }
  // Only a NON-EMPTY shape claim can prove a missing key (an empty advertised
  // shape means "no shape claims", not "no shape").
  if (Array.isArray(entry.shape) && entry.shape.length) {
    for (const key of req.shape) {
      if (!entry.shape.includes(key)) issues.push(`shape missing ${key}`);
    }
  }
  if (issues.length) {
    const patchHint = req.producerPatch ? ` — enable the "${req.producerPatch}" patch to provide it` : '';
    return {
      status: 'drift',
      entry,
      reason: `contract ${name} ${issues.join('; ')} (producer "${entry.producer}")${patchHint}`,
    };
  }

  // 3. Strongest check: __ccpRequire probes the actual value paths.
  const require_ = host.requireFn();
  if (typeof require_ === 'function') {
    try {
      const value = require_(name, {
        consumer: req.consumer,
        minVersion: req.minVersion,
        shape: req.shape,
      });
      return { status: 'ok', via: 'require', entry, value };
    } catch (err) {
      const patchHint = req.producerPatch ? ` — enable the "${req.producerPatch}" patch to provide it` : '';
      return { status: 'drift', entry, reason: `${(err && err.message) || String(err)}${patchHint}` };
    }
  }
  return { status: 'ok', via: 'advertised', entry };
}

/**
 * Per-contract memoization latch for `contractVerdict()`. A name is added here
 * ONLY after a registered contract has positively validated through __ccpRequire
 * (the strongest, value-path-probing check). Once latched, the gated path the
 * verdict guards is proven safe and re-consulting a fixed contract is pure
 * overhead. Every other outcome (nothing-to-prove, advertised-only ok, proven
 * drift) is intentionally NOT latched so a registry that populates — or a host
 * that recovers — after the first call is honored on a later one.
 *
 * @type {Set<string>}
 */
const _trusted = new Set();

/**
 * @typedef {Object} ContractVerdict
 * @property {'trusted'|'refuse'|'proceed'} decision
 *   The single decided action, with the "latch only when proven via require"
 *   memoization policy already applied:
 *   - 'trusted': SAFE to use the gated path. Either this call latched a
 *     require-proven contract, or a prior call already did. Callers proceed and
 *     should not re-probe (the latch makes that cheap to skip).
 *   - 'refuse': PROVEN drift — a registered contract failed the pin. Callers
 *     fail closed (return false / throw / downgrade). NOT latched: a recovered
 *     host re-checks next call.
 *   - 'proceed': nothing to prove (no registry helpers / contract unregistered)
 *     OR an advertised-metadata-only 'ok' (no __ccpRequire on the host). Callers
 *     proceed on their direct global probe. NOT latched, so a later-appearing
 *     require helper / contract is still consulted. Distinct from 'trusted' so
 *     consumers that care can tell "proven safe" from "unproven, fail-open".
 * @property {string} [reason]  For 'refuse': the actionable drift reason.
 * @property {ContractCheckResult} check  The underlying checkContract() result.
 */

/**
 * The single source of the "drift → action" + memoization policy that
 * `gatedPathTrusted()` (tool-registry) and `assertSystemPromptContract()`
 * (handoff) previously each re-implemented. Both latched `_driftChecked = true`
 * only on a `via:'require'` ok and re-checked otherwise — a correct but
 * non-obvious rule that lived in two places and could drift apart. It now lives
 * here once; consumers branch on `decision` and keep their own *reaction*
 * (tool-registry returns false on 'refuse'; handoff throws; both proceed on
 * 'trusted'/'proceed').
 *
 * NEVER throws — advisory by construction, like `checkContract`.
 *
 * @param {string} name  A key of ADK_CONTRACT_REQUIREMENTS.
 * @returns {ContractVerdict}
 */
export function contractVerdict(name) {
  if (_trusted.has(name)) {
    return { decision: 'trusted', check: { status: 'ok', via: 'require' } };
  }
  const check = checkContract(name);
  if (check.status === 'drift') {
    return { decision: 'refuse', reason: check.reason, check };
  }
  // 'ok' or 'unchecked'. Latch ONLY a require-proven ok — that is the only
  // outcome strong enough to stop re-probing. Advertised-only ok and unchecked
  // stay re-checkable.
  if (check.status === 'ok' && check.via === 'require') {
    _trusted.add(name);
    return { decision: 'trusted', check };
  }
  return { decision: 'proceed', check };
}

/**
 * TEST SEAM ONLY. `contractVerdict()` memoizes once a registered contract
 * validates via __ccpRequire; tests that exercise distinct registry
 * configurations within one process must clear those latches between cases.
 * Replaces the per-module `__resetDriftGuardForTests` /
 * `__resetSystemPromptDriftGuardForTests` seams now that the latch is central.
 * Not part of the public ADK surface.
 * @param {string} [name]  Clear one contract's latch; omit to clear all.
 * @returns {void}
 */
export function __resetContractVerdictsForTests(name) {
  if (typeof name === 'string') _trusted.delete(name);
  else _trusted.clear();
}
