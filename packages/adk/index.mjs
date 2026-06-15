/**
 * index.mjs — the ccpatch ADK public surface.
 *
 * Two ways to consume the ADK:
 *
 *   1. TOP-LEVEL named exports (defineAgent, defineTool, defineHandoff,
 *      AgentRouter, createMemory, useAgentBus, capabilities) — these bind to a
 *      single process-global DEFAULT instance. Backward compatible: existing
 *      imports keep working unchanged.
 *
 *   2. createAdk() — returns an object exposing the SAME API but backed by an
 *      isolated scope, for per-test / per-session isolation.
 *
 * ISOLATION CONTRACT (read this before relying on createAdk() for isolation).
 * The boundary is NOT uniform, because some of the resources the ADK sits on are
 * irreducibly process-global. Each createAdk() method is one of:
 *
 *   INSTANCE-LOCAL — two instances never share this state:
 *     • defineAgent / getAgent / listAgents   (per-instance agent registry)
 *     • defineTool / listTools / toolStatuses  (per-instance tool scope; the
 *       LIVE __ccpRawTools array is still the one shared sink, but each instance
 *       owns its OWN queue/lifecycle/dispose bookkeeping)
 *     • defineHandoff / restoreSystemPrompt / swapDepth / tryAcquireSwap
 *       (per-instance swap-stack FOOTPRINT + exclusive-lock ownership)
 *     • AgentRouter                            (bound to this instance's agents)
 *     • dispose()                              (tears down only this instance)
 *
 *   PROCESS-GLOBAL — shared by EVERY instance and the DEFAULT exports alike,
 *   because the underlying primitive is a single global slot. Scoping these would
 *   be theatre, so they are deliberately NOT scoped, and say so on the instance:
 *     • currentPersona()  reads the ONE live persona slot (__ccpGetSystemPrompt).
 *       swapDepth() is per-instance, but the persona it reflects is global — an
 *       out-of-order restore across instances fails safely (see handoff.mjs).
 *     • capabilities()    probes process globals; identical for all instances.
 *     • useAgentBus()     returns the ONE __ccpBus.
 *     • createMemory()    is keyed by FILE PATH, not by instance. Two instances
 *       (or two processes) opening the same path share that store on purpose
 *       (cross-process last-write merge). Pass distinct `path:` for separation.
 *
 * The ADK sits on top of ccpatch-exposed globals, reached ONLY through the
 * host port (host.mjs) — no module touches `globalThis.__ccp*` directly. Use
 * capabilities() to preflight which primitives are actually live.
 */

import {
  createAgentScope, createAgentRegistry,
  defineAgent, getAgent, listAgents,
  disposeAgentScope,
} from './agent.mjs';
import {
  createToolScope, createToolRegistry,
  disposeToolScope,
} from './tool-registry.mjs';
import {
  createHandoffScope, createDefineHandoff, restoreSystemPromptIn,
  swapDepthIn, currentPersona, _defaultHandoffScope,
  tryAcquireSwap as tryAcquireSwapIn, disposeHandoffScope,
  AgentRouter,
} from './handoff.mjs';
import { createMemory } from './memory.mjs';
import { ADK_CONTRACT_REQUIREMENTS, checkContract } from './contracts.mjs';
import { host } from './host.mjs';

export { defineAgent, getAgent, listAgents } from './agent.mjs';
export { ADK_CONTRACT_REQUIREMENTS, checkContract } from './contracts.mjs';
export { defineTool, listTools, toolStatuses } from './tool-registry.mjs';
export { createMemory } from './memory.mjs';
export { AgentRouter, defineHandoff, restoreSystemPrompt } from './handoff.mjs';

// Introspection — top-level mirrors bound to the DEFAULT instance.
// `listTools`/`toolStatuses` re-export the DEFAULT-scoped variants straight from
// tool-registry (above). `swapDepth`/`currentPersona` bind here: the swap depth is
// per-handoff-scope (DEFAULT = _defaultHandoffScope) while the live persona is a
// single global slot (currentPersona reads it directly).
export { currentPersona } from './handoff.mjs';

/**
 * Swap-stack depth owned by the DEFAULT ADK instance (entries this instance
 * pushed onto the single process-global swap stack). 0 when nothing is swapped in.
 * @returns {number}
 */
export function swapDepth() {
  return swapDepthIn(_defaultHandoffScope);
}

/**
 * Acquire the exclusive swap lock for the DEFAULT ADK instance. Returns a token
 * to drive an in-place persona swap (`swap`/`restore`/`release`/`owned`), or null
 * when a DIFFERENT scope already holds the lock. Bound to _defaultHandoffScope —
 * the scoped variant lives on createAdk().tryAcquireSwap.
 * @returns {{ swap(persona:string):void, restore():boolean, release():void, readonly owned:boolean }|null}
 */
export function tryAcquireSwap() {
  return tryAcquireSwapIn(_defaultHandoffScope);
}

/**
 * @typedef {Object} CapabilityDetail
 * @property {boolean} live   Mirrors the top-level boolean for this capability.
 * @property {string} patch   The patch name that provides this capability.
 * @property {string} [contract] The typed __ccp* contract name this capability
 *   is pinned to (a key of ADK_CONTRACT_REQUIREMENTS — see contracts.mjs).
 * @property {string} [reason] Set when the contract handshake DOWNGRADED `live`
 *   to false (e.g. "contract systemPrompt v1 < required v2"). Names WHICH
 *   contract failed and the producer-vs-required version/shape mismatch.
 */

/**
 * @typedef {Object} CapabilityDetailMap
 * @property {CapabilityDetail} tools
 * @property {CapabilityDetail} delegate
 * @property {CapabilityDetail} swap
 * @property {CapabilityDetail} router
 * @property {CapabilityDetail} bus
 */

/**
 * @typedef {Object} Capabilities
 * @property {boolean} tools     __ccpRawTools is a live array (expose_tool_dispatch).
 * @property {boolean} delegate  __ccpAgentTool.invoke is callable (expose_agent_tool).
 * @property {boolean} swap      __ccpSetSystemPrompt is callable (expose_system_prompt).
 * @property {boolean} router    __ccpSubmitInput is callable (drives AgentRouter).
 * @property {boolean} bus       __ccpBus is present (event_bus / fetch_interceptor).
 *   NOTE (fail-open probe): with NO registered `bus` contract this is a presence
 *   check only — a host that sets `__ccpBus = {}` (no `emit`) still reports
 *   `bus: true`. A registered contract (shape ['emit']) downgrades it on drift;
 *   absent one, the direct probe stays authoritative by design. useAgentBus()
 *   runs the same check, so the two never disagree.
 * @property {CapabilityDetailMap} detail  Per-capability remediation detail:
 *   `{ live, patch, reason? }`. `live` mirrors the boolean; `patch` names the
 *   providing patch; `reason` is present only when the contract handshake
 *   downgraded the capability.
 */

/** The patch that provides each capability — surfaced in caps.detail[cap].patch. */
const CAPABILITY_PATCH = {
  tools: 'expose_tool_dispatch',
  delegate: 'expose_agent_tool',
  swap: 'expose_system_prompt',
  router: 'expose_submit_input',
  bus: 'event_bus / fetch_interceptor',
};

/**
 * Probe the __ccp* globals and report which ADK capabilities are live. Pure /
 * side-effect-free — safe to call before wiring anything up.
 *
 * VERSION/SHAPE HANDSHAKE: where a typed contract is registered
 * (core/contracts.mjs — capabilities() is the ADK's drift-refusal consumer), we
 * cross-check ALL contracted capabilities via the centralized pin table in
 * contracts.mjs (ADK_CONTRACT_REQUIREMENTS / checkContract — which routes
 * through __ccpRequire(name, { minVersion, shape }) when available) so a
 * present-but-shape/version-drifted global is not reported as usable. The direct
 * global probe remains the source of truth (contracts are opt-in per boundary):
 * a capability with NO registered contract keeps its probe result. The contract
 * check only ever DOWNGRADES a capability it can positively prove broken (never
 * invents one) and records why in `detail[cap].reason` — naming WHICH contract
 * failed and the producer-vs-required version mismatch. Pinned minimums live in
 * ONE place, packages/adk/contracts.mjs:
 *   - tools    → 'toolDispatch' v>=2, shape ['registerTool']
 *   - delegate → 'agentTool'    v>=1, shape ['invoke']
 *   - swap     → 'systemPrompt' v>=2, shape ['getNonce']
 *   - router   → 'submitInput'  v>=1
 *   - bus      → 'bus'          v>=1, shape ['emit']
 * It is fully defensive (wrapped in try/catch; advisory only, never throws).
 *
 * @returns {Capabilities}
 */
export function capabilities() {
  const caps = {
    tools: host.hasRawTools(),
    delegate: host.hasDelegate(),
    swap: host.hasSetSystemPrompt(),
    router: host.hasSubmitInput(),
    bus: host.hasBus(),
  };

  // Remediation detail. `live` mirrors each boolean; `patch` names
  // the providing patch so a caller seeing `false` knows what to enable.
  const detail = {};
  for (const cap of Object.keys(CAPABILITY_PATCH)) {
    detail[cap] = { live: caps[cap], patch: CAPABILITY_PATCH[cap] };
  }
  caps.detail = detail;

  // Version/shape handshake against the typed contract registry, driven by the
  // ONE pin table in contracts.mjs (checkContract routes through
  // __ccpRequire(name, { minVersion, shape }) when the helper is live). Only
  // ever flips a capability true→false (and records a reason naming the failed
  // contract + version mismatch); an unregistered contract leaves the direct
  // probe authoritative.
  for (const [name, req] of Object.entries(ADK_CONTRACT_REQUIREMENTS)) {
    const cap = req.capability;
    if (!detail[cap]) continue;
    detail[cap].contract = name; // which contract pins this capability
    if (!caps[cap]) continue;    // already dead by direct probe — nothing to downgrade
    try {
      const res = checkContract(name);
      if (res.status === 'drift') {
        caps[cap] = false;
        detail[cap].live = false;
        detail[cap].reason = res.reason;
      }
    } catch (_) { /* contract probe is advisory only */ }
  }

  return caps;
}

/**
 * useAgentBus — return the live __ccpBus or throw if the event bus patch is off.
 * A registered-but-drifted 'bus' contract (pin: contracts.mjs) is refused with
 * the drift reason rather than handing back a present-but-broken bus; an
 * unregistered contract keeps the bare-global fail-open path for test stubs.
 * @returns {{ emit: Function, on?: Function, off?: Function }}
 */
export function useAgentBus() {
  const bus = host.bus();
  if (!bus) throw new Error('useAgentBus: __ccpBus not available — ensure event_bus patch is applied');
  const res = checkContract('bus');
  if (res.status === 'drift') {
    throw new Error(`useAgentBus: refusing drifted bus contract — ${res.reason}`);
  }
  return bus;
}

/**
 * @typedef {Object} Adk
 * @property {string} id  Stable per-instance id (introspection / debug only).
 * @property {typeof defineAgent} defineAgent
 * @property {typeof getAgent} getAgent
 * @property {typeof listAgents} listAgents
 * @property {(spec:any)=>import('./tool-registry.mjs').ToolHandle} defineTool
 * @property {(opts:any)=>import('./tool-registry.mjs').ToolHandle} defineHandoff
 * @property {() => boolean} restoreSystemPrompt  Pop this instance's swap stack.
 * @property {() => string[]} listTools  Tools live/queued in this instance's scope.
 * @property {() => Array<{name:string,status:'queued'|'live'|'failed'}>} toolStatuses  Full lifecycle view of this instance's tools.
 * @property {() => number} swapDepth    Swap-stack entries owned by this instance.
 * @property {() => (string|null)} currentPersona  The live persona overlay (single global slot).
 * @property {() => ({ swap(persona:string):void, restore():boolean, release():void, readonly owned:boolean }|null)} tryAcquireSwap  Acquire this instance's exclusive swap lock (null if held elsewhere).
 * @property {new (opts?:any)=>AgentRouter} AgentRouter  Router pre-bound to this instance's agents.
 * @property {typeof createMemory} createMemory
 * @property {() => Capabilities} capabilities
 * @property {() => ReturnType<typeof useAgentBus>} useAgentBus
 * @property {() => void} dispose  Tear down this instance's tool/swap/agent scopes (idempotent).
 */

/** Monotonic counter backing each createAdk() instance's `id`. */
let _adkSeq = 0;

/**
 * Create an ADK instance with INSTANCE-LOCAL agent/tool/handoff scopes. Two
 * instances never share those registries. Per the ISOLATION CONTRACT at the top
 * of this file, `capabilities`, `useAgentBus`, and `createMemory` are deliberately
 * NOT instance-scoped — they front process-global resources (the globals probe,
 * the single bus, and path-keyed on-disk stores) and are shared with every other
 * instance and the DEFAULT exports. The returned API otherwise mirrors the
 * top-level exports exactly.
 *
 * @returns {Adk}
 */
export function createAdk() {
  const agentScope = createAgentScope();
  const toolScope = createToolScope();
  const handoffScope = createHandoffScope();
  // Stable id for this instance — lets debug output / bus consumers tell two
  // instances apart. The swap scope already carries its own id (handoffScope.id);
  // we surface a parallel adk id for introspection.
  const id = `adk-${++_adkSeq}`;

  const agentApi = createAgentRegistry(agentScope);
  const toolApi = createToolRegistry(toolScope);

  // Handoff resolves agents from THIS instance's registry and injects into THIS
  // instance's tool scope — full isolation from the DEFAULT instance.
  const defineHandoffScoped = createDefineHandoff({
    scope: handoffScope,
    getAgent: agentApi.getAgent,
    defineTool: toolApi.defineTool,
  });

  let disposed = false;

  return {
    id,
    defineAgent: agentApi.defineAgent,
    getAgent: agentApi.getAgent,
    listAgents: agentApi.listAgents,
    defineTool: toolApi.defineTool,
    defineHandoff: defineHandoffScoped,
    restoreSystemPrompt: () => restoreSystemPromptIn(handoffScope),
    // Introspection: listTools/toolStatuses are this instance's tool scope;
    // swapDepth counts entries THIS instance owns on the single global swap stack;
    // currentPersona reads the one global persona slot (shared by all instances).
    listTools: toolApi.listTools,
    toolStatuses: toolApi.toolStatuses,
    swapDepth: () => swapDepthIn(handoffScope),
    currentPersona,
    // Exclusive swap lock bound to THIS instance's handoff scope.
    tryAcquireSwap: () => tryAcquireSwapIn(handoffScope),
    // Router bound to this instance's agent registry (falls back to it on start).
    AgentRouter: class extends AgentRouter {
      constructor(opts = {}) {
        super({ getAgent: agentApi.getAgent, ...opts });
      }
    },
    // PROCESS-GLOBAL (see the ISOLATION CONTRACT at the top of this file): these
    // three front single global resources, so the instance intentionally hands
    // back the SAME functions the DEFAULT exports use — they are not re-scoped.
    //   • capabilities — probes process globals (identical for every instance)
    //   • useAgentBus  — returns the one __ccpBus
    //   • createMemory — path-keyed store; pass distinct `path:` to separate
    createMemory,
    capabilities,
    useAgentBus,
    // Tear down every scope this instance owns: live tools + pending queue/pollers,
    // its swap-stack footprint (+ swap lock if held), and its agent registry.
    // Idempotent — safe to call twice.
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeHandoffScope(handoffScope);
      disposeToolScope(toolScope);
      disposeAgentScope(agentScope);
    },
  };
}
