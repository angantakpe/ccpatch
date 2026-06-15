import { EventEmitter } from 'node:events';
import { getAgent as getAgentDefault } from './agent.mjs';
import { host } from './host.mjs';

/**
 * agent-router.mjs — the SECONDARY, code-decided handoff path (AgentRouter).
 *
 * Extracted from handoff.mjs (COD-9). AgentRouter is a sibling concern with NO
 * dependency on the swap internals (SwapCoordinator / the global persona slot):
 * it drives the session by submitting the next persona as a synthetic USER
 * message through __ccpSubmitInput, which is strictly LOWER authority than a
 * system-prompt swap. Keeping it in its own module shrinks handoff.mjs to the
 * swap + tool-call-driven handoff machinery and bounds the per-change blast
 * radius. The public surface is unchanged: `AgentRouter` is still re-exported
 * from handoff.mjs (and from index.mjs) for backward compatibility.
 */

/**
 * Cheap insurance on AgentRouter.start()'s submit. The trusted-code
 * model means a predicate's persona string is not adversarial, but an unbounded
 * or control-char-laden submit can still wedge the host's input pipeline. We cap
 * the submitted byte length and strip C0/C1 control characters (allowing only
 * newline `\n` and tab `\t`) before handing the string to __ccpSubmitInput.
 */
const MAX_SUBMIT_BYTES = 128 * 1024;

/** Fully-guarded bus emit (never throws; no-op when the bus is absent). */
function busEmit(topic, payload) {
  host.emit(topic, payload);
}

/**
 * Strip C0/C1 control characters from a submit string, preserving newline and
 * tab. Used by AgentRouter.start(). Returns '' for a non-string.
 * @param {unknown} s
 * @returns {string}
 */
function sanitizeSubmit(s) {
  if (typeof s !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
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

    const submit = host.submitInput();
    if (typeof submit === 'function') {
      // RUNTIME NOTE: the first time the router actually drives the session via
      // __ccpSubmitInput, announce `router.active` on the bus once so operators
      // can observe that CODE (not the user) is now steering session control.
      if (!this.#announced) {
        this.#announced = true;
        busEmit('router.active', { agent: agentName });
      }
      // Cheap insurance before submitting. Strip control chars
      // (keeping \n and \t) and enforce a MAX_SUBMIT_BYTES ceiling. Over the cap
      // we refuse THIS submit: fire router.submit.rejected, surface a router
      // 'error' event (only when observed, matching #emitError), and DO NOT
      // advance the chain — a runaway/oversized persona must not wedge the host
      // input pipeline. The trusted-code model makes this insurance, not a gate.
      const clean = sanitizeSubmit(def.systemPrompt);
      const bytes = Buffer.byteLength(clean, 'utf8');
      if (bytes > MAX_SUBMIT_BYTES) {
        busEmit('router.submit.rejected', { agent: agentName, bytes, max: MAX_SUBMIT_BYTES });
        this.#emitError('submit', new Error(
          `AgentRouter: refused submit for "${agentName}" — ${bytes} bytes exceeds MAX_SUBMIT_BYTES (${MAX_SUBMIT_BYTES})`,
        ));
        return;
      }
      try {
        await submit(clean);
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
