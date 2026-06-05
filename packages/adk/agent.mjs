/**
 * agent.mjs — the ADK agent registry.
 *
 * State model: the registry (a Map keyed by agent name) lives in a per-instance
 * SCOPE object created by `createAgentRegistry(scope)`. `createAdk()` (index.mjs)
 * builds one scope and shares it across the agent/tool/handoff modules so two ADK
 * instances never see each other's agents. The TOP-LEVEL exports below are bound
 * to a lazily-created DEFAULT scope so existing `import { defineAgent } from
 * '...'` callers (and the existing tests) keep working unchanged.
 *
 * TRUST BOUNDARY: agent definitions carry a `systemPrompt`. In swap-mode handoffs
 * a model-triggered tool call can flip the live persona to one of these prompts
 * (see handoff.mjs). Treat every registered systemPrompt as security-sensitive —
 * registering an agent is granting it the right to become the active persona.
 */

/**
 * @typedef {Object} AgentDef
 * @property {string} name            Unique agent id (registry key).
 * @property {string} [description]   Human/`whenToUse` description.
 * @property {string} [systemPrompt]  Persona prompt (used by swap handoffs & router).
 * @property {string[]} [tools]       Allowed tool names (defaults to ['*'] downstream).
 * @property {Function|null} [handoff] Optional predicate `(ctx) => nextName|null` for AgentRouter.
 * @property {string} [model]         Optional model override.
 */

/** @typedef {{ registry: Map<string, AgentDef> }} AgentScope */

/**
 * Build a fresh agent-registry scope. Used by createAdk() for isolation.
 * @returns {AgentScope}
 */
export function createAgentScope() {
  return { registry: new Map() };
}

/**
 * Bind the agent-registry API to a given scope.
 * @param {AgentScope} scope
 * @returns {{ defineAgent: typeof defineAgent, getAgent: typeof getAgent, listAgents: typeof listAgents }}
 */
export function createAgentRegistry(scope) {
  return {
    defineAgent: (spec) => defineAgentIn(scope, spec),
    getAgent: (name) => getAgentIn(scope, name),
    listAgents: () => listAgentsIn(scope),
  };
}

/**
 * Register an agent definition into `scope`.
 * @param {AgentScope} scope
 * @param {AgentDef} spec
 * @returns {AgentDef} the stored definition (also returned for chaining).
 */
export function defineAgentIn(scope, { name, description, systemPrompt, tools = [], handoff = null, model } = {}) {
  if (typeof name !== 'string' || !name) {
    // PROGRAMMER error: a nameless agent can never be addressed.
    throw new Error('defineAgent: `name` must be a non-empty string');
  }
  const def = { name, description, systemPrompt, tools, handoff, ...(model ? { model } : {}) };
  scope.registry.set(name, def);
  return def;
}

/**
 * @param {AgentScope} scope
 * @param {string} name
 * @returns {AgentDef|null}
 */
export function getAgentIn(scope, name) {
  return scope.registry.get(name) ?? null;
}

/**
 * @param {AgentScope} scope
 * @returns {AgentDef[]}
 */
export function listAgentsIn(scope) {
  return [...scope.registry.values()];
}

// ── DEFAULT instance: top-level exports for backward compatibility ────────────

const _defaultScope = createAgentScope();

/**
 * Register an agent in the DEFAULT (process-global) ADK instance.
 * @param {AgentDef} spec
 * @returns {AgentDef}
 */
export function defineAgent(spec) {
  return defineAgentIn(_defaultScope, spec);
}

// NOTE: unlike the tool/handoff modules, the DEFAULT agent scope is not
// re-exported — nothing consumes it (index.mjs builds the default registry via
// the bound defineAgent/getAgent/listAgents below). Add an export here only if a
// consumer actually needs the raw scope.

/**
 * Look up an agent in the DEFAULT instance.
 * @param {string} name
 * @returns {AgentDef|null}
 */
export function getAgent(name) {
  return getAgentIn(_defaultScope, name);
}

/**
 * List agents registered in the DEFAULT instance.
 * @returns {AgentDef[]}
 */
export function listAgents() {
  return listAgentsIn(_defaultScope);
}
