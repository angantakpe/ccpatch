import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { getAgent as getAgentDefault } from './agent.mjs';
import { defineTool as defineToolDefault } from './tool-registry.mjs';

/**
 * handoff.mjs — tool-call-driven agent handoffs (delegate / swap) + AgentRouter.
 *
 * State model: per-instance state (the handoff sequence counter, the one-shot
 * swap-degradation warning flag, and a stable scope `id`) lives in a SCOPE
 * created by `createHandoffScope()`. `createAdk()` wires a scoped
 * `getAgent`/`defineTool` into `createHandoffApi()` so a handoff resolves agents
 * from — and injects tools into — its OWN ADK instance. The top-level
 * `defineHandoff`/`AgentRouter` exports bind to the DEFAULT instance.
 *
 * TRUST BOUNDARY (persona swap): a `swap` handoff lets a MODEL-TRIGGERED tool
 * call replace the live system prompt with a registered agent's persona
 * (defineAgent). That is a privilege escalation surface — the model can flip
 * "who it is" mid-session. We mitigate with (a) an optional `allowSwapTargets`
 * allowlist (a programmer error if the target is not listed), (b) a definition-
 * time persona PIN (sha256 of the resolved systemPrompt) that refuses the swap if
 * the target's persona was mutated after the handoff was defined (TOCTOU), and
 * (c) a reversible swap stack so a swapped-in persona can be popped back to the
 * previous prompt. Audit every defineAgent systemPrompt as security-sensitive.
 *
 * TRUST BOUNDARY (single global slot + LIFO ownership): the host exposes exactly
 * ONE live persona slot (expose_system_prompt's __ccpSystemPromptOverride). Two
 * createAdk() instances therefore CANNOT each own a private swap stack that
 * mirrors that one slot — interleaved swap/restore across instances would let one
 * instance's restore clobber another's live persona. We back ALL swaps with a
 * SINGLE module-global stack (`GLOBAL_SWAP_STACK`) whose entries record the
 * owning scope id and the prompt that was displaced. restoreSystemPromptIn(scope)
 * pops ONLY when the global stack's TOP entry is owned by THAT scope (honest
 * global LIFO); an out-of-order restore (top owned by another instance) refuses
 * to corrupt the slot — it emits `handoff.restore.skipped`, warns once, and
 * returns false. This keeps the single-slot reality honest while preserving each
 * instance's reversibility under well-nested (LIFO) usage.
 *
 * The writer side is nonce-gated: expose_system_prompt now exposes
 * __ccpGetSystemPromptNonce() and __ccpSetSystemPrompt(nonce, value). We acquire
 * the nonce lazily at the call site via setLiveSystemPrompt() and fall back to
 * the legacy single-arg form when no nonce getter exists (so existing stubs keep
 * working).
 */

/**
 * @typedef {Object} HandoffScope
 * @property {string} id                 Stable unique scope id (GLOBAL_SWAP_STACK owner key).
 * @property {number} seq                Monotonic handoff id counter.
 * @property {boolean} swapWarned        True once the degrade-to-delegate warning fired.
 */

/**
 * The SINGLE process-global swap stack shared across ALL handoff scopes. It
 * mirrors the host's single live persona slot. Each entry is
 * `{ owner: <scopeId>, prev: <capturedPrompt> }`: `owner` is the scope id that
 * pushed it, `prev` is the prompt that was live just before the swap (restored on
 * pop). Per-instance LIFO discipline is enforced by checking ownership of the TOP
 * entry on restore — see restoreSystemPromptIn().
 * @type {Array<{ owner: string, prev: (string|null) }>}
 */
const GLOBAL_SWAP_STACK = [];

/** Monotonic counter feeding stable, unique scope ids. */
let _scopeSeq = 0;

/** One-shot guard so the out-of-order restore warning fires at most once. */
let _restoreSkipWarned = false;

/**
 * Build a fresh handoff scope. Each scope gets a stable unique `id` so its swap
 * entries can be distinguished from other instances' entries on the single
 * GLOBAL_SWAP_STACK.
 * @returns {HandoffScope}
 */
export function createHandoffScope() {
  return { id: `hoscope-${++_scopeSeq}`, seq: 0, swapWarned: false };
}

function busEmit(topic, payload) {
  const bus = globalThis.__ccpBus;
  if (bus) try { bus.emit(topic, payload); } catch (_) {}
}

/**
 * Write the live persona overlay through the host primitive. The writer is now
 * NONCE-GATED (expose_system_prompt mirrors the dispatch-nonce pattern): when
 * __ccpGetSystemPromptNonce() exists we acquire the nonce lazily and call the
 * gated two-arg form `__ccpSetSystemPrompt(nonce, value)`. When no nonce getter
 * is present (legacy host, or a test stub that only replaces __ccpSetSystemPrompt)
 * we fall back to the single-arg form so existing callers keep working.
 * @param {string|null} value
 */
function setLiveSystemPrompt(value) {
  const getNonce = globalThis.__ccpGetSystemPromptNonce;
  const setSP = globalThis.__ccpSetSystemPrompt;
  if (typeof getNonce === 'function') {
    setSP(getNonce(), value); // gated path
  } else {
    setSP(value); // legacy single-arg path
  }
}

/**
 * Stable sha256 hash of a persona prompt, used to PIN a swap target at
 * definition time and detect a later mutation at execute time (TOCTOU). Returns
 * null for a non-string so an unset persona never pins.
 * @param {unknown} prompt
 * @returns {string|null}
 */
function hashPrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  return createHash('sha256').update(prompt).digest('hex');
}

/**
 * Number of GLOBAL_SWAP_STACK entries owned by `scope` (this instance's current
 * swap depth). Introspection hook for the finalizer's adk.swapDepth().
 * @param {HandoffScope} scope
 * @returns {number}
 */
export function swapDepthIn(scope) {
  if (!scope || typeof scope.id !== 'string') return 0;
  return GLOBAL_SWAP_STACK.reduce((n, e) => (e.owner === scope.id ? n + 1 : n), 0);
}

/**
 * The live persona overlay currently applied, or null. Reads the ungated getter
 * the host exposes. Introspection hook for the finalizer's adk.currentPersona().
 * @returns {string|null}
 */
export function currentPersona() {
  return globalThis.__ccpGetSystemPrompt?.() ?? null;
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
 * Restore the most recently swapped-out system prompt, honoring GLOBAL LIFO
 * ownership. Only pops when the GLOBAL_SWAP_STACK's TOP entry is owned by THIS
 * scope: that is the single-slot-honest definition of "the last swap" across all
 * instances. If the top entry belongs to ANOTHER instance (an out-of-order
 * restore), we DO NOT corrupt it — popping would re-apply this scope's older
 * `prev` over a persona the other instance still owns. Instead we emit
 * `handoff.restore.skipped`, warn once, and return false. No-op when the stack is
 * empty or the writer primitive is unavailable.
 * @param {HandoffScope} scope
 * @returns {boolean} true if a prompt was restored.
 */
export function restoreSystemPromptIn(scope) {
  if (!GLOBAL_SWAP_STACK.length) return false;
  const top = GLOBAL_SWAP_STACK[GLOBAL_SWAP_STACK.length - 1];
  // Out-of-order restore: the live slot is owned by a different instance. Refuse
  // rather than clobber its persona.
  if (!top || top.owner !== scope.id) {
    busEmit('handoff.restore.skipped', {
      owner: top ? top.owner : null,
      requestedBy: scope.id,
      depth: GLOBAL_SWAP_STACK.length,
    });
    if (!_restoreSkipWarned) {
      _restoreSkipWarned = true;
      try {
        console.warn(
          `[adk:handoff] restore skipped — top of the global swap stack is owned by "${top ? top.owner : null}", not "${scope.id}" (out-of-order restore across ADK instances)`,
        );
      } catch (_) {}
    }
    return false;
  }
  const setSP = globalThis.__ccpSetSystemPrompt;
  if (typeof setSP !== 'function') return false;
  // Pop only after we know the writer exists and the top is ours.
  GLOBAL_SWAP_STACK.pop();
  try { setLiveSystemPrompt(top.prev); } catch (_) { return false; }
  busEmit('handoff.restore', { restored: true, depth: swapDepthIn(scope) });
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
 *
 * Swap-mode TOCTOU pin (FINDING 5): `allowSwapTargets` only allowlists the target
 * NAME, but the persona is re-resolved at EXECUTE time via getAgent(target) — a
 * later defineAgent() could swap a hostile systemPrompt under an allowlisted
 * name. To close that window, a `swap` handoff whose target is ALREADY registered
 * at definition time captures a PIN: the sha256 of the resolved systemPrompt,
 * stored in the closure. At execute time, if the live persona's hash differs from
 * the pin, the swap is REFUSED (emits `handoff.pin.mismatch`, warns once, returns
 * a readable tool_result error) rather than applying a persona that changed since
 * the handoff was defined. If the target was NOT registered at definition time
 * there is nothing to pin — we emit `handoff.pin.deferred` and fall back to the
 * unpinned (current) behavior.
 *
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

    // FINDING 5 — persona PIN at DEFINITION time. If the swap target is already
    // registered, hash its systemPrompt now and close over it; execute-time will
    // refuse the swap if the live persona's hash has drifted. `pinnedHash` stays
    // null for delegate mode or an unregistered target (nothing to pin yet).
    let pinnedHash = null;
    let pinDeferred = false;
    if (mode === 'swap') {
      const defAtDefine = getAgent(target);
      if (defAtDefine && typeof defAtDefine.systemPrompt === 'string') {
        pinnedHash = hashPrompt(defAtDefine.systemPrompt);
      } else {
        // Can't pin what doesn't exist yet — note it for the execute path.
        pinDeferred = true;
      }
    }

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
            // FINDING 5 — TOCTOU pin check. If we pinned the persona at definition
            // time, refuse the swap when the live systemPrompt's hash has drifted
            // (a defineAgent() re-defined the target under the allowlisted name).
            if (pinnedHash !== null) {
              const liveHash = hashPrompt(def.systemPrompt);
              if (liveHash !== pinnedHash) {
                busEmit('handoff.pin.mismatch', { id, target, pinned: pinnedHash, live: liveHash });
                if (!scope.swapWarned) {
                  scope.swapWarned = true;
                  try {
                    console.warn(`[adk:handoff] swap refused — persona for "${target}" changed since the handoff was defined (pin mismatch)`);
                  } catch (_) {}
                }
                busEmit('handoff.end', { id, target, mode: effectiveMode, ok: false, ms: Date.now() - startMs });
                return `Handoff to "${target}" refused: persona changed since handoff was defined; refusing swap.`;
              }
            } else if (pinDeferred) {
              // Target was unregistered at definition time — nothing was pinned.
              busEmit('handoff.pin.deferred', { id, target });
            }
            // REVERSIBLE SWAP: capture the prompt we're replacing onto the SINGLE
            // global stack (tagged with this scope's id) BEFORE overwriting, so a
            // LIFO-ordered restore() can pop back to it. A transfer_back tool is
            // auto-registered (once) to give the model a revert affordance.
            GLOBAL_SWAP_STACK.push({ owner: scope.id, prev: captureCurrentPrompt() });
            setLiveSystemPrompt(def.systemPrompt);
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
 * AgentRouter — the SECONDARY, LOWER-AUTHORITY, TRUSTED-CODE-ONLY handoff path.
 *
 * This is NOT the primary protocol. The primary protocol is tool-call-driven
 * `defineHandoff` (delegate/swap) — reach for that first. AgentRouter exists for
 * *code-decided* orchestration: register agents that each expose a
 * `handoff(context) -> nextName|null` predicate, call `start(name)`, and after
 * each agent is installed its predicate picks the next one.
 *
 * AUTHORITY MODEL (read before using): AgentRouter drives the CLI by injecting
 * the next persona through `__ccpSubmitInput` as a synthetic USER message. That
 * is strictly LOWER authority than a swap (which rewrites the system prompt) —
 * the model is free to ignore a user message. More importantly, the PREDICATES
 * and the set of REACHABLE AGENTS are not model-controlled and not sandboxed:
 * they are TRUSTED CODE. A predicate can submit arbitrary text into the live
 * session, so registering an agent / predicate here is granting it the right to
 * steer the session. Never wire untrusted input into a predicate or an agent's
 * systemPrompt reachable from one. The first time start() actually submits via
 * __ccpSubmitInput, a `router.active` bus event fires so operators can observe
 * that code (not the user) is now driving session control.
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
 * Events: `router.active` {agent} (bus, first real submit) · `transition`
 *   {from,to} · `error` {phase,error} · `limit` {transitions}.
 */
export class AgentRouter extends EventEmitter {
  #agents = new Map();
  #active = null;
  #transitions = 0;
  #maxTransitions;
  #stopped = false;
  #getAgent;
  #announced = false;

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
      // RUNTIME NOTE: the first time the router actually drives the session via
      // __ccpSubmitInput, announce `router.active` on the bus once so operators
      // can observe that CODE (not the user) is now steering session control.
      if (!this.#announced) {
        this.#announced = true;
        busEmit('router.active', { agent: agentName });
      }
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
 *   The persona is PINNED (sha256) at definition time when the target is already
 *   registered; a later persona change is refused at execute time (handoff.pin.mismatch).
 *   Swaps push onto a SINGLE process-global stack tagged by scope id; reversible via
 *   the auto-registered `transfer_back` tool / restoreSystemPrompt() under LIFO order.
 *
 * @type {(opts: HandoffOptions) => import('./tool-registry.mjs').ToolHandle}
 */
export const defineHandoff = createDefineHandoff({
  scope: _defaultScope,
  getAgent: getAgentDefault,
  defineTool: defineToolDefault,
});

/**
 * Restore the previous system prompt in the DEFAULT instance. Pops the SINGLE
 * global swap stack only when its top entry is owned by the default scope (LIFO
 * ownership — see restoreSystemPromptIn). Returns false on an out-of-order
 * restore (top owned by another instance) without clobbering the live persona.
 * @returns {boolean}
 */
export function restoreSystemPrompt() {
  return restoreSystemPromptIn(_defaultScope);
}

/** The DEFAULT handoff scope. */
export const _defaultHandoffScope = _defaultScope;
