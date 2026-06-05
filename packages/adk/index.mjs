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
 *      isolated scope. Two createAdk() instances never share agent/tool/handoff
 *      state, which enables per-test / per-session isolation.
 *
 * The ADK sits on top of ccpatch-exposed globals (__ccpRawTools, __ccpAgentTool,
 * __ccpSetSystemPrompt, __ccpSubmitInput, __ccp_path, __ccpBus). Use
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

export { defineAgent, getAgent, listAgents } from './agent.mjs';
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
 * @property {string} [reason] Set when the contract handshake DOWNGRADED `live`
 *   to false (e.g. "contract systemPrompt v1 < required v2").
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
 * cross-check ALL contracted capabilities via __ccpInspectContracts so a
 * present-but-shape/version-drifted global is not reported as usable. The direct
 * global probe remains the source of truth (contracts are opt-in per boundary):
 * a capability with NO registered contract keeps its probe result. The contract
 * check only ever DOWNGRADES a capability it can positively prove broken (never
 * invents one) and records why in `detail[cap].reason`. Required minimums:
 *   - swap  → contract 'systemPrompt' minVersion 2 AND shape includes 'getNonce'
 *   - tools → contract 'toolDispatch' shape includes 'registerTool'
 *   - delegate → contract 'agentTool' shape includes 'invoke'
 * It is fully defensive (wrapped in try/catch; advisory only, never throws).
 *
 * @returns {Capabilities}
 */
export function capabilities() {
  const caps = {
    tools: Array.isArray(globalThis.__ccpRawTools),
    delegate: typeof globalThis.__ccpAgentTool?.invoke === 'function',
    swap: typeof globalThis.__ccpSetSystemPrompt === 'function',
    router: typeof globalThis.__ccpSubmitInput === 'function',
    bus: !!globalThis.__ccpBus,
  };

  // Remediation detail. `live` mirrors each boolean; `patch` names
  // the providing patch so a caller seeing `false` knows what to enable.
  const detail = {};
  for (const cap of Object.keys(CAPABILITY_PATCH)) {
    detail[cap] = { live: caps[cap], patch: CAPABILITY_PATCH[cap] };
  }
  caps.detail = detail;

  // Version/shape handshake against the typed contract registry. Only
  // ever flips a capability true→false (and records a reason); a missing contract
  // entry leaves the direct probe authoritative.
  const inspect = globalThis.__ccpInspectContracts;
  if (typeof inspect === 'function') {
    try {
      const known = new Map(inspect().map((e) => [e.name, e]));

      // Downgrade `cap` to false + record `reason` (idempotent on the boolean).
      const downgrade = (cap, reason) => {
        caps[cap] = false;
        detail[cap].live = false;
        detail[cap].reason = reason;
      };

      // tools → 'toolDispatch' must advertise the nonce-gated registrar.
      if (caps.tools && known.has('toolDispatch')) {
        const e = known.get('toolDispatch');
        if (Array.isArray(e.shape) && e.shape.length && !e.shape.includes('registerTool')) {
          downgrade('tools', 'shape missing registerTool');
        }
      }

      // delegate → 'agentTool' must advertise invoke.
      if (caps.delegate && known.has('agentTool')) {
        const e = known.get('agentTool');
        if (Array.isArray(e.shape) && e.shape.length && !e.shape.includes('invoke')) {
          downgrade('delegate', 'shape missing invoke');
        }
      }

      // swap → 'systemPrompt' must be v>=2 AND advertise getNonce.
      if (caps.swap && known.has('systemPrompt')) {
        const e = known.get('systemPrompt');
        if (typeof e.version === 'number' && e.version < 2) {
          downgrade('swap', `contract systemPrompt v${e.version} < required v2`);
        } else if (Array.isArray(e.shape) && e.shape.length && !e.shape.includes('getNonce')) {
          downgrade('swap', 'shape missing getNonce');
        }
      }
    } catch (_) { /* contract probe is advisory only */ }
  }

  return caps;
}

/**
 * useAgentBus — return the live __ccpBus or throw if the event bus patch is off.
 * @returns {{ emit: Function, on?: Function, off?: Function }}
 */
export function useAgentBus() {
  const bus = globalThis.__ccpBus;
  if (!bus) throw new Error('useAgentBus: __ccpBus not available — ensure event_bus patch is applied');
  return bus;
}

/**
 * @typedef {Object} Adk
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

/**
 * Create an isolated ADK instance. All agent/tool/handoff state is scoped to the
 * returned object; two instances never share registries. The returned API mirrors
 * the top-level exports exactly.
 *
 * @returns {Adk}
 */
export function createAdk() {
  const agentScope = createAgentScope();
  const toolScope = createToolScope();
  const handoffScope = createHandoffScope();

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
