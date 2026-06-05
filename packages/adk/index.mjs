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
} from './agent.mjs';
import {
  createToolScope, createToolRegistry,
} from './tool-registry.mjs';
import {
  createHandoffScope, createDefineHandoff, restoreSystemPromptIn,
  AgentRouter,
} from './handoff.mjs';
import { createMemory } from './memory.mjs';

export { defineAgent, getAgent, listAgents } from './agent.mjs';
export { defineTool } from './tool-registry.mjs';
export { createMemory } from './memory.mjs';
export { AgentRouter, defineHandoff, restoreSystemPrompt } from './handoff.mjs';

/**
 * @typedef {Object} Capabilities
 * @property {boolean} tools     __ccpRawTools is a live array (expose_tool_dispatch).
 * @property {boolean} delegate  __ccpAgentTool.invoke is callable (expose_agent_tool).
 * @property {boolean} swap      __ccpSetSystemPrompt is callable (expose_system_prompt).
 * @property {boolean} router    __ccpSubmitInput is callable (drives AgentRouter).
 * @property {boolean} bus       __ccpBus is present (event_bus / fetch_interceptor).
 */

/**
 * Probe the __ccp* globals and report which ADK capabilities are live. Pure /
 * side-effect-free — safe to call before wiring anything up.
 *
 * Where a typed contract is registered (core/contracts.mjs), we cross-check via
 * __ccpInspectContracts so a present-but-shape-drifted global is not reported as
 * usable. The direct global probe remains the source of truth (contracts are
 * opt-in per boundary); the contract check only DOWNGRADES a capability it can
 * positively prove broken.
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

  // Optional cross-check against the typed contract registry. Only ever flips a
  // capability true→false (never invents one) so the global probe stays primary.
  const inspect = globalThis.__ccpInspectContracts;
  if (typeof inspect === 'function') {
    try {
      const known = new Map(inspect().map((e) => [e.name, e]));
      // A registered contract whose advertised shape is empty/missing the path we
      // rely on signals drift; absence of an entry means "not contracted" → keep
      // the direct probe result.
      if (caps.delegate && known.has('agentTool')) {
        const e = known.get('agentTool');
        if (Array.isArray(e.shape) && e.shape.length && !e.shape.includes('invoke')) {
          caps.delegate = false;
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
 * @property {new (opts?:any)=>AgentRouter} AgentRouter  Router pre-bound to this instance's agents.
 * @property {typeof createMemory} createMemory
 * @property {() => Capabilities} capabilities
 * @property {() => ReturnType<typeof useAgentBus>} useAgentBus
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

  return {
    defineAgent: agentApi.defineAgent,
    getAgent: agentApi.getAgent,
    listAgents: agentApi.listAgents,
    defineTool: toolApi.defineTool,
    defineHandoff: defineHandoffScoped,
    restoreSystemPrompt: () => restoreSystemPromptIn(handoffScope),
    // Router bound to this instance's agent registry (falls back to it on start).
    AgentRouter: class extends AgentRouter {
      constructor(opts = {}) {
        super({ getAgent: agentApi.getAgent, ...opts });
      }
    },
    createMemory,
    capabilities,
    useAgentBus,
  };
}
