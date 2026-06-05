import { EventEmitter } from 'node:events';
import { getAgent as getAgentDefault } from './agent.mjs';
import { defineTool as defineToolDefault } from './tool-registry.mjs';

/**
 * handoff.mjs — tool-call-driven agent handoffs (delegate / swap) + AgentRouter.
 *
 * State model: per-instance state (the handoff sequence counter, the one-shot
 * swap-degradation warning flag, and the SWAP STACK used to make swaps
 * reversible) lives in a SCOPE created by `createHandoffScope()`. `createAdk()`
 * wires a scoped `getAgent`/`defineTool` into `createHandoffApi()` so a handoff
 * resolves agents from — and injects tools into — its OWN ADK instance. The
 * top-level `defineHandoff`/`AgentRouter` exports bind to the DEFAULT instance.
 *
 * TRUST BOUNDARY: a `swap` handoff lets a MODEL-TRIGGERED tool call replace the
 * live system prompt with a registered agent's persona (defineAgent). That is a
 * privilege escalation surface — the model can flip "who it is" mid-session. We
 * mitigate with (a) an optional `allowSwapTargets` allowlist (a programmer error
 * if the target is not listed) and (b) a reversible swap stack so a swapped-in
 * persona can be popped back to the previous prompt. Audit every defineAgent
 * systemPrompt as security-sensitive.
 */

/**
 * @typedef {Object} HandoffScope
 * @property {number} seq                Monotonic handoff id counter.
 * @property {boolean} swapWarned        True once the degrade-to-delegate warning fired.
 * @property {Array<string|null>} swapStack  Previous system prompts, for restore().
 */

/**
 * Build a fresh handoff scope.
 * @returns {HandoffScope}
 */
export function createHandoffScope() {
  return { seq: 0, swapWarned: false, swapStack: [] };
}

function busEmit(topic, payload) {
  const bus = globalThis.__ccpBus;
  if (bus) try { bus.emit(topic, payload); } catch (_) {}
}

/**
 * Convert an ADK agent definition (defineAgent shape) into the Claude Code
 * agent-definition shape that __ccpAgentTool.invoke can merge into
 * options.agentDefinitions.activeAgents. Returns null if `def` is falsy.
 *
 * CC consumes `getSystemPrompt({ toolUseContext })` (a function), not a
 * `systemPrompt` string; `source` must not be "built-in"/"plugin" so the def is
 * treated as user-provided.
 */
function toCcAgentDef(def) {
  if (!def || !def.name) return null;
  const systemPrompt = typeof def.systemPrompt === 'string' ? def.systemPrompt : '';
  return {
    agentType: def.name,
    whenToUse: def.description || `The ${def.name} agent.`,
    tools: Array.isArray(def.tools) && def.tools.length ? def.tools : ['*'],
    source: 'user',
    baseDir: 'ccpatch-adk',
    getSystemPrompt: () => systemPrompt,
    ...(def.model ? { model: def.model } : {}),
  };
}

/**
 * Restore the most recently swapped-out system prompt (LIFO). Pops the swap
 * stack and re-applies the previous prompt via __ccpSetSystemPrompt. No-op when
 * the stack is empty or the primitive is unavailable.
 * @param {HandoffScope} scope
 * @returns {boolean} true if a prompt was restored.
 */
export function restoreSystemPromptIn(scope) {
  if (!scope.swapStack.length) return false;
  const prev = scope.swapStack.pop();
  const setSP = globalThis.__ccpSetSystemPrompt;
  if (typeof setSP !== 'function') return false;
  try { setSP(prev); } catch (_) { return false; }
  busEmit('handoff.restore', { restored: true, depth: scope.swapStack.length });
  return true;
}

/**
 * Read the current live system prompt, if the host exposes a getter. ccpatch's
 * expose_system_prompt stashes the active override on __ccpSystemPromptOverride;
 * we capture whatever is there (may be undefined) so restore() can put it back.
 */
function captureCurrentPrompt() {
  const g = globalThis.__ccpGetSystemPrompt;
  if (typeof g === 'function') { try { return g(); } catch (_) { /* fall through */ } }
  // Best-effort: the override slot used by expose_system_prompt.
  return globalThis.__ccpSystemPromptOverride ?? null;
}

/**
 * @typedef {Object} HandoffOptions
 * @property {string} target          Agent to hand off to (required).
 * @property {'delegate'|'swap'} [mode='delegate']
 * @property {string} [description]   Tool description shown to the model.
 * @property {string} [toolName]      Override the injected tool name (default transfer_to_<target>).
 * @property {object} [inputSchema]   Override the tool input schema.
 * @property {string} [promptKey='task']  Property carrying the prompt to hand over.
 * @property {string[]} [allowSwapTargets] Allowlist; swap only proceeds if target ∈ it.
 */

/**
 * Build a scoped `defineHandoff` bound to a specific agent lookup + tool sink.
 * @param {{ scope: HandoffScope, getAgent: (n:string)=>any, defineTool: Function }} deps
 * @returns {(opts: HandoffOptions) => import('./tool-registry.mjs').ToolHandle}
 */
export function createDefineHandoff({ scope, getAgent, defineTool }) {
  return function defineHandoff({
    target,
    mode = 'delegate',
    description,
    toolName,
    inputSchema,
    promptKey = 'task',
    allowSwapTargets,
  } = {}) {
    // PROGRAMMER errors — bad/missing args throw at definition time.
    if (typeof target !== 'string' || !target) {
      throw new Error('defineHandoff: `target` must be a non-empty string');
    }
    if (mode !== 'delegate' && mode !== 'swap') {
      throw new Error(`defineHandoff: unknown mode "${mode}" (expected 'delegate' | 'swap')`);
    }
    if (allowSwapTargets !== undefined && !Array.isArray(allowSwapTargets)) {
      throw new Error('defineHandoff: `allowSwapTargets` must be an array of agent names');
    }
    // TRUST BOUNDARY: an allowlist supplied for a swap is enforced up front so a
    // disallowed persona flip is a programmer error, not a silent runtime no-op.
    if (mode === 'swap' && Array.isArray(allowSwapTargets) && !allowSwapTargets.includes(target)) {
      throw new Error(
        `defineHandoff: swap target "${target}" is not in allowSwapTargets [${allowSwapTargets.join(', ')}]`,
      );
    }

    const name = toolName || `transfer_to_${target}`;
    const schema = inputSchema || {
      type: 'object',
      properties: {
        [promptKey]: { type: 'string', description: `What to hand to the ${target} agent.` },
      },
      required: [promptKey],
    };

    return defineTool({
      name,
      description: description || `Hand off the current work to the "${target}" agent.`,
      inputSchema: schema,
      execute: async (input) => {
        const id = `ho-${++scope.seq}`;
        const from = globalThis.__ccp_path || 'root';
        const prompt = (input && typeof input[promptKey] === 'string') ? input[promptKey] : '';
        const startMs = Date.now();

        // Resolve effective mode: 'swap' degrades to 'delegate' when the
        // system-prompt-override primitive is missing. (RUNTIME condition →
        // bus event + graceful fallback, NOT a throw.)
        let effectiveMode = mode;
        if (mode === 'swap' && typeof globalThis.__ccpSetSystemPrompt !== 'function') {
          effectiveMode = 'delegate';
          busEmit('handoff.degraded', {
            id, target, requested: 'swap', used: 'delegate',
            reason: '__ccpSetSystemPrompt not available',
          });
          if (!scope.swapWarned) {
            scope.swapWarned = true;
            try {
              console.warn(`[adk:handoff] swap mode unavailable (no __ccpSetSystemPrompt) — using delegate for "${target}"`);
            } catch (_) {}
          }
        }

        busEmit('handoff.start', { id, from, target, mode: effectiveMode });

        try {
          let resultText;

          if (effectiveMode === 'swap') {
            const def = getAgent(target);
            if (!def || typeof def.systemPrompt !== 'string') {
              throw new Error(`swap handoff: agent "${target}" has no systemPrompt (define it via defineAgent)`);
            }
            // REVERSIBLE SWAP: capture the prompt we're replacing onto the stack
            // BEFORE overwriting, so restore() can pop back to it. A transfer_back
            // tool is auto-registered (once) to give the model a revert affordance.
            scope.swapStack.push(captureCurrentPrompt());
            globalThis.__ccpSetSystemPrompt(def.systemPrompt);
            ensureRestoreTool({ scope, defineTool });
            resultText = `Handed off to "${target}" — persona swapped in place. (call transfer_back to revert)`;
          } else {
            const agentTool = globalThis.__ccpAgentTool;
            if (!agentTool || typeof agentTool.invoke !== 'function') {
              throw new Error('delegate handoff: __ccpAgentTool.invoke not available (enable expose_agent_tool)');
            }
            // If `target` is an ADK-registered agent, bridge its definition into
            // the dispatch ctx so the non-native subagent_type resolves. Native
            // CC subagent types (no ADK registration) pass agentDef: undefined and
            // resolve against the live activeAgents list as before.
            const adkDef = toCcAgentDef(getAgent(target));
            const res = await agentTool.invoke({
              subagent_type: target,
              prompt,
              description: `handoff to ${target}`,
              background: false,
              ...(adkDef ? { agentDef: adkDef } : {}),
            });
            resultText = (res && typeof res.text === 'string') ? res.text : String(res ?? '');
          }

          busEmit('handoff.end', { id, target, mode: effectiveMode, ok: true, ms: Date.now() - startMs });
          return resultText;
        } catch (err) {
          // RUNTIME error → readable tool_result + not-ok end event (no throw).
          busEmit('handoff.end', { id, target, mode: effectiveMode, ok: false, ms: Date.now() - startMs });
          const msg = err && err.message ? err.message : String(err);
          return `Handoff to "${target}" failed: ${msg}`;
        }
      },
    });
  };
}

/**
 * Auto-register the `transfer_back` restore tool (idempotent per scope). Gives
 * the model a concrete affordance to pop the swap stack and revert the persona.
 * @param {{ scope: HandoffScope, defineTool: Function }} deps
 */
function ensureRestoreTool({ scope, defineTool }) {
  if (scope._restoreToolRegistered) return;
  scope._restoreToolRegistered = true;
  defineTool({
    name: 'transfer_back',
    description: 'Revert the most recent swap handoff, restoring the previous persona/system prompt.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      const ok = restoreSystemPromptIn(scope);
      return ok ? 'Reverted to the previous persona.' : 'Nothing to revert (no active swap).';
    },
  });
}

/**
 * AgentRouter — the SECONDARY, predicate-driven handoff path.
 *
 * The PRIMARY protocol is tool-call-driven `defineHandoff` (delegate/swap); reach
 * for that first. AgentRouter exists for *code-decided* orchestration: register
 * agents that each expose a `handoff(context) -> nextName|null` predicate, call
 * `start(name)`, and after each agent is installed its predicate picks the next
 * one. The next persona is injected via `__ccpSubmitInput` as a *user* message
 * (lower authority than a swap), which is why this is not the default surface.
 *
 * Hardening over the original stub:
 *   - transitions are capped (`maxTransitions`, default 50) so a predicate that
 *     never converges (e.g. two agents ping-ponging) halts instead of looping
 *     unbounded — a `limit` event fires when the cap is hit;
 *   - predicate and persona-install errors surface as an `error` event (only
 *     when a listener is attached, so an unobserved error never crashes the
 *     EventEmitter) instead of being silently swallowed;
 *   - `stop()` halts the chain; `active` exposes the current agent.
 *
 * Events: `transition` {from,to} · `error` {phase,error} · `limit` {transitions}.
 */
export class AgentRouter extends EventEmitter {
  #agents = new Map();
  #active = null;
  #transitions = 0;
  #maxTransitions;
  #stopped = false;
  #getAgent;

  /**
   * @param {{ maxTransitions?: number, getAgent?: (n:string)=>any }} [opts]
   */
  constructor({ maxTransitions = 50, getAgent = getAgentDefault } = {}) {
    super();
    this.#maxTransitions = maxTransitions;
    this.#getAgent = getAgent;
  }

  get active() { return this.#active; }

  register(agentDef) {
    if (!agentDef || typeof agentDef.name !== 'string') {
      throw new Error('AgentRouter.register: agentDef.name must be a non-empty string');
    }
    this.#agents.set(agentDef.name, agentDef);
    return this;
  }

  /** Halt the chain; in-flight predicate results are ignored. */
  stop() {
    this.#stopped = true;
  }

  async start(agentName) {
    if (this.#stopped) return;
    const def = this.#agents.get(agentName) ?? this.#getAgent(agentName);
    if (!def) throw new Error(`AgentRouter: unknown agent "${agentName}"`);

    this.#active = agentName;

    const submit = globalThis.__ccpSubmitInput;
    if (typeof submit === 'function') {
      try {
        await submit(def.systemPrompt);
      } catch (err) {
        this.#emitError('install', err);
        return;
      }
    }

    this.#scheduleHandoff(def);
  }

  // Emit 'error' only when observed — EventEmitter throws on an unhandled
  // 'error', and a routing diagnostic must never take down the host process.
  #emitError(phase, error) {
    if (this.listenerCount('error') > 0) this.emit('error', { phase, error });
  }

  #scheduleHandoff(def) {
    if (this.#stopped || typeof def.handoff !== 'function') return;

    if (this.#transitions >= this.#maxTransitions) {
      this.emit('limit', { transitions: this.#transitions });
      return;
    }

    const context = { active: this.#active, agents: [...this.#agents.keys()] };

    // Promise.resolve().then(...) so a synchronous throw in the predicate is
    // captured by the chain's .catch rather than escaping unhandled.
    Promise.resolve()
      .then(() => def.handoff(context))
      .then(next => {
        if (this.#stopped) return;
        if (typeof next === 'string' && next !== this.#active) {
          this.#transitions++;
          this.emit('transition', { from: this.#active, to: next });
          return this.start(next);
        }
      })
      .catch(err => this.#emitError('handoff', err));
  }
}

// ── DEFAULT instance: top-level exports for backward compatibility ────────────

const _defaultScope = createHandoffScope();

/**
 * defineHandoff — register a tool-call-driven handoff to `target` in the DEFAULT
 * ADK instance. See {@link createDefineHandoff} / {@link HandoffOptions}.
 *
 * mode 'delegate' (default): spawn `target` as an isolated subagent via
 *   __ccpAgentTool.invoke and return its final text into the caller's tool_result.
 * mode 'swap': true in-place persona swap — gated on globalThis.__ccpSetSystemPrompt.
 *   When that primitive is absent, degrades to 'delegate' and emits handoff.degraded.
 *   Reversible via the auto-registered `transfer_back` tool / restoreSystemPrompt().
 *
 * @type {(opts: HandoffOptions) => import('./tool-registry.mjs').ToolHandle}
 */
export const defineHandoff = createDefineHandoff({
  scope: _defaultScope,
  getAgent: getAgentDefault,
  defineTool: defineToolDefault,
});

/**
 * Restore the previous system prompt in the DEFAULT instance (pop swap stack).
 * @returns {boolean}
 */
export function restoreSystemPrompt() {
  return restoreSystemPromptIn(_defaultScope);
}

/** The DEFAULT handoff scope. */
export const _defaultHandoffScope = _defaultScope;
