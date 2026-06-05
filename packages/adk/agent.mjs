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
 * @property {boolean} [frozen]       If true, the persona is immutable — a later
 *                                    defineAgent for this name with a DIFFERENT
 *                                    systemPrompt THROWS (a byte-identical redefine
 *                                    is a no-op). Defaults to false.
 */

/**
 * @typedef {Object} AgentScope
 * @property {Map<string, AgentDef>} registry  Name → definition.
 * @property {Set<string>} [warnedRedefines]   Names already warned on (once-per-name).
 */

/**
 * Emit an advisory warning + bus event when an allowlisted persona is silently
 * redefined with a DIFFERENT systemPrompt. Trust-boundary sensitive (see the file
 * header): a swap handoff can flip the live persona to a registered prompt, so a
 * silent redefine is a TOCTOU surface. We warn at most once per name per scope,
 * and louder (with the previous/next prompt previews) when the debug switch is on
 * — the same convention the rest of ccpatch uses (CLAUDE_DEBUG / __ccpDebug).
 * @param {AgentScope} scope
 * @param {string} name
 * @param {string|undefined} prevPrompt
 * @param {string|undefined} nextPrompt
 */
function warnAgentRedefined(scope, name, prevPrompt, nextPrompt) {
  const warned = scope.warnedRedefines || (scope.warnedRedefines = new Set());
  if (!warned.has(name)) {
    warned.add(name);
    const debug = process.env.CLAUDE_DEBUG || globalThis.__ccpDebug;
    try {
      if (debug) {
        console.warn(
          `[adk:agent] persona "${name}" redefined with a DIFFERENT systemPrompt (trust-boundary: this prompt is a swap-handoff target)\n  was: ${JSON.stringify(prevPrompt)}\n  now: ${JSON.stringify(nextPrompt)}`,
        );
      } else {
        console.warn(
          `[adk:agent] persona "${name}" redefined with a DIFFERENT systemPrompt (trust-boundary risk; set CLAUDE_DEBUG=1 for prompt previews, or { frozen: true } to forbid)`,
        );
      }
    } catch (_) {}
  }
  // Bus emit is independent of the once-per-name console dedupe so downstream
  // auditors observe EVERY redefine; guard it like the other modules.
  try { globalThis.__ccpBus?.emit('agent.redefined', { name }); } catch (_) {}
}

/**
 * Build a fresh agent-registry scope. Used by createAdk() for isolation.
 * @returns {AgentScope}
 */
export function createAgentScope() {
  return { registry: new Map(), warnedRedefines: new Set() };
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
export function defineAgentIn(scope, { name, description, systemPrompt, tools = [], handoff = null, model, frozen = false } = {}) {
  if (typeof name !== 'string' || !name) {
    // PROGRAMMER error: a nameless agent can never be addressed.
    throw new Error('defineAgent: `name` must be a non-empty string');
  }
  // TRUST BOUNDARY: re-registering an EXISTING name is security-sensitive — a swap
  // handoff can later flip the live persona to this prompt. A byte-identical
  // redefine is always a harmless no-op; a CHANGED redefine either throws (when the
  // stored def was frozen) or warns + emits `agent.redefined` (non-frozen, kept
  // permissive for backward compatibility).
  const prev = scope.registry.get(name);
  if (prev) {
    const changed = prev.systemPrompt !== systemPrompt;
    if (changed) {
      if (prev.frozen) {
        // PROGRAMMER error: a frozen persona must not be silently re-pointed.
        throw new Error(
          `defineAgent: agent "${name}" is frozen — refusing to redefine it with a different systemPrompt`,
        );
      }
      warnAgentRedefined(scope, name, prev.systemPrompt, systemPrompt);
    } else if (!frozen || prev.frozen) {
      // Identical systemPrompt redefine: a no-op. Preserve the existing def so a
      // frozen flag (and identity) survives an idempotent re-declaration. The one
      // exception is an identical redefine that NEWLY requests `frozen` — that is
      // a safe privilege tightening, so we fall through and re-store with frozen.
      return prev;
    }
  }
  const def = { name, description, systemPrompt, tools, handoff, ...(model ? { model } : {}), ...(frozen ? { frozen: true } : {}) };
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

/**
 * Tear down an agent-registry scope: clear the registry Map (and the
 * once-per-name redefine-warning ledger so a fresh re-use of the scope warns
 * again). Idempotent — safe to call on an already-empty or never-populated scope.
 * Part of the instance-dispose feature (#15).
 * @param {AgentScope} scope
 * @returns {void}
 */
export function disposeAgentScope(scope) {
  if (!scope) return;
  scope.registry?.clear();
  scope.warnedRedefines?.clear();
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
