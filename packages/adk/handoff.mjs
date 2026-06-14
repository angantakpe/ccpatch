import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { getAgent as getAgentDefault } from './agent.mjs';
import { defineTool as defineToolDefault } from './tool-registry.mjs';
import { checkContract } from './contracts.mjs';

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
 * SINGLE shared stack owned by the module-level `SwapCoordinator`, whose entries
 * record the owning scope id and the prompt that was displaced.
 * restoreSystemPromptIn(scope) pops ONLY when the shared stack's TOP entry is
 * owned by THAT scope (honest global LIFO); an out-of-order restore (top owned by
 * another instance) refuses to corrupt the slot — it emits
 * `handoff.restore.skipped`, warns once, and returns false. This keeps the
 * single-slot reality honest while preserving each instance's reversibility under
 * well-nested (LIFO) usage.
 *
 * The writer side is nonce-gated: expose_system_prompt now exposes
 * __ccpGetSystemPromptNonce() and __ccpSetSystemPrompt(nonce, value). We acquire
 * the nonce lazily at the call site via setLiveSystemPrompt() and fall back to
 * the legacy single-arg form when no nonce getter exists (so existing stubs keep
 * working).
 *
 * TRUST BOUNDARY (exclusive swap lock): because there is exactly ONE
 * global persona slot shared by every createAdk() instance (above), per-instance
 * isolation of the swap surface is a CONVENIENT FICTION. The LIFO-ownership path
 * keeps well-nested cross-instance swaps honest, but it still silently REFUSES an
 * out-of-order restore. tryAcquireSwap(scope) makes the single-ownership reality
 * EXPLICIT and opt-in: while one scope holds the exclusive lock, another scope's
 * tryAcquireSwap returns null, so a caller that wants guaranteed sole control of
 * the live persona slot can detect contention up front instead of discovering it
 * at restore time. The token-driven API and the legacy LIFO path coexist on the
 * SwapCoordinator's single shared stack — the lock is advisory over that shared
 * stack, not a separate slot.
 */

/**
 * @typedef {Object} HandoffScope
 * @property {string} id                 Stable unique scope id (SwapCoordinator stack owner key).
 * @property {number} seq                Monotonic handoff id counter.
 * @property {boolean} swapWarned        True once the degrade-to-delegate warning fired.
 * @property {boolean} [_restoreToolRegistered] Internal: transfer_back auto-registered.
 * @property {import('./tool-registry.mjs').ToolHandle} [_restoreToolHandle] Internal: handle for dispose.
 */

/**
 * SwapCoordinator — the FIRST-CLASS owner of the single shared persona slot.
 *
 * The host exposes exactly ONE live persona slot (__ccpSystemPromptOverride).
 * Per-instance swap "isolation" is therefore a fiction over that one slot; rather
 * than scatter the machinery that keeps the fiction honest (the global stack, the
 * exclusive-lock owner, the LIFO-refusal/owner-tagging logic, the warn-once flag)
 * across module globals, we consolidate it into THIS one named coordinator that
 * instances BORROW. Every exported entry point (swapDepthIn, restoreSystemPromptIn,
 * tryAcquireSwap, disposeHandoffScope, and the defineHandoff swap path) delegates
 * here; none of them mutate the stack or lock directly.
 *
 * `stack` entries are `{ owner: <scopeId>, prev: <capturedPrompt> }`: `owner` is
 * the scope id that pushed it, `prev` is the prompt that was live just before the
 * swap (restored on pop). Per-instance LIFO discipline is enforced by checking
 * ownership of the TOP entry on restore — see restore().
 */
const SwapCoordinator = {
  /**
   * The SINGLE process-global swap stack shared across ALL handoff scopes. It
   * mirrors the host's single live persona slot.
   * @type {Array<{ owner: string, prev: (string|null) }>}
   */
  stack: [],

  /**
   * The EXCLUSIVE swap-lock holder scope id, or null when the lock is free. The
   * single global persona slot can only be exclusively owned by one scope at a
   * time; tryAcquireSwap() sets this and refuses any other scope until release().
   * Advisory over the SHARED stack — the legacy LIFO path does NOT consult it.
   * @type {string|null}
   */
  lockOwner: null,

  /** One-shot guard so the out-of-order restore warning fires at most once. */
  restoreSkipWarned: false,

  /**
   * Number of stack entries owned by `scopeId` (that instance's current swap
   * depth).
   * @param {string} scopeId
   * @returns {number}
   */
  depthOf(scopeId) {
    return this.stack.reduce((n, e) => (e.owner === scopeId ? n + 1 : n), 0);
  },

  /** The top stack entry, or undefined when empty. */
  top() {
    return this.stack[this.stack.length - 1];
  },

  /** True when `scopeId` owns the TOP entry (i.e. may LIFO-restore). */
  ownsTop(scopeId) {
    const t = this.top();
    return !!t && t.owner === scopeId;
  },

  /**
   * Push a swap entry tagged with `scopeId`, capturing the currently-live prompt
   * as the `prev` to restore on pop, then write the new persona. Same shape/order
   * for both the legacy and token swap paths so restore()/depthOf() treat them
   * identically.
   * When `allow` (the target agent's `tools` allowlist) restricts the surface,
   * the live tool set is narrowed to it (restrictLiveTools) and the hidden tools
   * are recorded on the stack entry so restore() re-adds exactly them. The
   * restriction runs AFTER the depth check so a depth-cap refusal hides nothing;
   * `allow` is null/omitted for the manual token.swap path (no tool change).
   *
   * Throws when THIS scope already owns MAX_SWAP_DEPTH entries (a runaway,
   * never-reverted swap chain) — refuse the swap rather than grow the stack
   * unbounded. Counted per-scope (depthOf) so one instance's depth never refuses
   * another's swap. The currently-live prompt is captured BEFORE the new write so
   * a depth-cap refusal leaves the live persona untouched.
   * @param {string} scopeId
   * @param {string} persona
   * @param {string[]|null} [allow]  target agent's tool allowlist (null = no restriction).
   * @returns {Array<object>|null} tool objects hidden by this swap (for the bus event).
   */
  push(scopeId, persona, allow = null) {
    const depth = this.depthOf(scopeId);
    if (depth >= MAX_SWAP_DEPTH) {
      busEmit('handoff.swap.depthExceeded', { owner: scopeId, depth, max: MAX_SWAP_DEPTH });
      throw new Error(
        `swap refused — scope at MAX_SWAP_DEPTH (${MAX_SWAP_DEPTH}); revert with transfer_back / restoreSystemPrompt before swapping again`,
      );
    }
    const prev = captureCurrentPrompt();
    const removedTools = restrictLiveTools(allow); // null when unrestricted
    this.stack.push({ owner: scopeId, prev, removedTools });
    setLiveSystemPrompt(persona);
    return removedTools;
  },

  /**
   * Restore the most recently swapped-out prompt, honoring GLOBAL LIFO ownership.
   * Pops ONLY when the TOP entry is owned by `scopeId`. An out-of-order restore
   * (top owned by another instance) refuses to corrupt the slot — emits
   * `handoff.restore.skipped`, warns once, returns false. No-op when the stack is
   * empty or the writer primitive is unavailable.
   * @param {string} scopeId
   * @returns {boolean} true if a prompt was restored.
   */
  restore(scopeId) {
    if (!this.stack.length) return false;
    const top = this.top();
    if (!top || top.owner !== scopeId) {
      busEmit('handoff.restore.skipped', {
        owner: top ? top.owner : null,
        requestedBy: scopeId,
        depth: this.stack.length,
      });
      if (!this.restoreSkipWarned) {
        this.restoreSkipWarned = true;
        try {
          console.warn(
            `[adk:handoff] restore skipped — top of the global swap stack is owned by "${top ? top.owner : null}", not "${scopeId}" (out-of-order restore across ADK instances)`,
          );
        } catch (_) {}
      }
      return false;
    }
    const setSP = globalThis.__ccpSetSystemPrompt;
    if (typeof setSP !== 'function') return false;
    // Pop only after we know the writer exists and the top is ours.
    this.stack.pop();
    try { setLiveSystemPrompt(top.prev); } catch (_) { return false; }
    // Re-add any tools this swap hid (LIFO-correct: each entry restores exactly
    // what IT removed from the live surface at its swap time).
    restoreLiveTools(top.removedTools);
    busEmit('handoff.restore', { restored: true, depth: this.depthOf(scopeId) });
    return true;
  },

  /**
   * LIFO-pop/restore every entry `scopeId` still owns from the TOP down, stopping
   * at the first non-owned top (never clobbers another instance). Returns the
   * count restored.
   * @param {string} scopeId
   * @returns {number}
   */
  restoreOwned(scopeId) {
    let restored = 0;
    while (this.ownsTop(scopeId)) {
      if (!this.restore(scopeId)) break;
      restored++;
    }
    return restored;
  },

  /**
   * Try to take the exclusive lock for `scopeId`. Returns true when granted (lock
   * free, or already held by this same scope — idempotent ownership); false when a
   * DIFFERENT scope holds it.
   * @param {string} scopeId
   * @returns {boolean}
   */
  acquireLock(scopeId) {
    if (this.lockOwner !== null && this.lockOwner !== scopeId) return false;
    this.lockOwner = scopeId;
    return true;
  },

  /** Release the exclusive lock IFF `scopeId` currently holds it. */
  releaseLock(scopeId) {
    if (this.lockOwner === scopeId) this.lockOwner = null;
  },
};

/** Monotonic counter feeding stable, unique scope ids. */
let _scopeSeq = 0;

/**
 * Cheap insurance on AgentRouter.start()'s submit. The trusted-code
 * model means a predicate's persona string is not adversarial, but an unbounded
 * or control-char-laden submit can still wedge the host's input pipeline. We cap
 * the submitted byte length and strip C0/C1 control characters (allowing only
 * newline `\n` and tab `\t`) before handing the string to __ccpSubmitInput.
 */
const MAX_SUBMIT_BYTES = 128 * 1024;

/**
 * Hard ceiling on PER-SCOPE swap depth. Swaps are MODEL-TRIGGERED tool calls
 * (transfer_to_<target>), so a model that repeatedly hands off without reverting
 * could grow the swap stack unbounded — leaking the displaced prompts it
 * captures. The runaway always accumulates within ONE scope (the instance whose
 * handoff tools the model is calling), so the cap is per-scope (counted via
 * SwapCoordinator.depthOf) rather than over the shared stack — this bounds each
 * instance without one instance's residue refusing another's swaps. Mirrors
 * AgentRouter.maxTransitions, which bounds the sibling code-driven path. Past the
 * cap, SwapCoordinator.push() throws; the execute() path turns that into a
 * readable tool_result error rather than a crash.
 */
const MAX_SWAP_DEPTH = 64;

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
 * Build a fresh handoff scope. Each scope gets a stable unique `id` so its swap
 * entries can be distinguished from other instances' entries on the single
 * SwapCoordinator stack.
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
 * Memoized result of the drift handshake. `undefined` = not yet POSITIVELY
 * validated; once a REGISTERED 'systemPrompt' contract has been validated it is
 * set to `true` and never re-evaluated (the contract registry is fixed once it
 * populates, so re-consulting a proven-good contract is pure overhead).
 *
 * The fail-OPEN decision (no require/inspect helper, or no contract registered
 * yet) is deliberately NOT latched: a contract registry that populates AFTER the
 * first swap must still be honored, so the guard keeps re-evaluating cheaply until
 * a contract is actually present. A PROVEN drift throws synchronously EVERY time
 * (and is never memoized true).
 * @type {boolean|undefined}
 */
let _driftChecked;

/**
 * TEST SEAM ONLY. assertSystemPromptContract() memoizes once a registered
 * contract validates; tests that exercise distinct contract-registry
 * configurations within one process need to clear that latch between cases (and
 * an earlier fail-open path must not leak into a later drift case). Mirrors
 * tool-registry.mjs's __resetDriftGuardForTests(). Not part of the public ADK
 * surface — do NOT surface in index.mjs / index.d.ts.
 * @returns {void}
 */
export function __resetSystemPromptDriftGuardForTests() {
  _driftChecked = undefined;
}

/**
 * Make the drift guard load-bearing at handoff's write call site. The build-time
 * `verify { present }` and capabilities()'s advisory handshake catch a drifted
 * host, but the actual WRITE here is where a present-but-broken `systemPrompt`
 * contract would do real damage. Before a live write, consult
 * checkContract('systemPrompt') — the centralized pin in contracts.mjs (v>=2,
 * shape ['getNonce'], routed through __ccpRequire when the helper is live).
 * Proven drift refuses the write with a clear thrown Error (naming the contract
 * and the producer-vs-required versions) rather than calling the drifted
 * global. An unregistered contract / absent registry proceeds unchanged —
 * fail-open preserves test stubs that set bare globals with no contract
 * registry.
 *
 * Memoization is asymmetric ON PURPOSE: we ONLY latch `_driftChecked = true` once
 * a REGISTERED contract has positively validated. The fail-open branches (no
 * helper / not registered yet) are NOT latched, so a contract registry that
 * populates AFTER the first swap is still honored on a later write — the guard
 * re-evaluates cheaply until a contract is actually present. Proven drift throws
 * every time and is never memoized.
 */
function assertSystemPromptContract() {
  if (_driftChecked) return;
  // Centralized pin: contracts.mjs requires 'systemPrompt' v>=2 with shape
  // ['getNonce'] through __ccpRequire when the helper is live, falling back to
  // the registry's advertised metadata otherwise.
  const res = checkContract('systemPrompt');
  // Fail-open (NOT latched): no registry helpers, or no registered
  // 'systemPrompt' contract, means a bare-global host/test stub — proceed
  // unchanged, but re-check on the next write in case the registry populates late.
  if (res.status === 'unchecked') return;
  // Contract IS registered → the handshake is now load-bearing. Drift is
  // proven; refuse the write (and do NOT latch, so a recovered host re-checks).
  if (res.status === 'drift') {
    throw new Error(`[adk:handoff] refusing persona write — systemPrompt contract drift: ${res.reason}`);
  }
  // Positively validated a registered contract → safe to memoize from here on,
  // but ONLY when the actual value paths were probed through __ccpRequire; an
  // advertised-metadata-only 'ok' stays unlatched so a later-appearing require
  // helper is still consulted.
  if (res.via === 'require') _driftChecked = true;
}

/**
 * Write the live persona overlay through the host primitive. The writer is now
 * NONCE-GATED (expose_system_prompt mirrors the dispatch-nonce pattern): when
 * __ccpGetSystemPromptNonce() exists we acquire the nonce lazily and call the
 * gated two-arg form `__ccpSetSystemPrompt(nonce, value)`. When no nonce getter
 * is present (legacy host, or a test stub that only replaces __ccpSetSystemPrompt)
 * we fall back to the single-arg form so existing callers keep working.
 *
 * Before touching the raw global we run assertSystemPromptContract():
 * a registered-but-drifted 'systemPrompt' contract refuses the write by throwing.
 * @param {string|null} value
 */
function setLiveSystemPrompt(value) {
  assertSystemPromptContract();
  const getNonce = globalThis.__ccpGetSystemPromptNonce;
  const setSP = globalThis.__ccpSetSystemPrompt;
  if (typeof getNonce === 'function') {
    setSP(getNonce(), value); // gated path
  } else {
    setSP(value); // legacy single-arg path
  }
}

/**
 * Tools that a swap-mode tool restriction must NEVER hide, regardless of the
 * agent's allowlist — without `transfer_back` the model would be trapped in the
 * swapped-in persona with no affordance to revert.
 */
const SWAP_TOOL_KEEP = new Set(['transfer_back']);

/**
 * Enforce a swapped-in agent's `tools` allowlist on the LIVE tool surface. A
 * `swap` overlays the persona but, unlike `delegate`, does NOT make Claude Code
 * apply that agent's tool allowlist — so without this a read-only persona would
 * still see every live tool. We hide every `__ccpRawTools` entry whose name is
 * NOT in the allowlist (always keeping SWAP_TOOL_KEEP), returning the removed
 * objects so restore() can re-add EXACTLY them (loss-less, LIFO-correct under
 * nested swaps). Enforcement is a RESTRICTION, never a grant — a tool the persona
 * lists but that isn't live is not added.
 *
 * Returns null (no-op) when there is nothing to enforce: the allowlist is absent,
 * empty, or contains '*' (matches toCcAgentDef treating those as unrestricted),
 * or __ccpRawTools is not a live array.
 *
 * @param {string[]|undefined} allow  the agent's `tools` allowlist.
 * @returns {Array<object>|null} removed tool objects, or null if nothing removed.
 */
function restrictLiveTools(allow) {
  if (!Array.isArray(allow) || allow.length === 0 || allow.includes('*')) return null;
  const raw = globalThis.__ccpRawTools;
  if (!Array.isArray(raw)) return null;
  const permit = new Set(allow);
  for (const k of SWAP_TOOL_KEEP) permit.add(k);
  const removed = [];
  // Walk back-to-front so splices don't disturb not-yet-visited indices.
  for (let i = raw.length - 1; i >= 0; i--) {
    const t = raw[i];
    if (t && typeof t.name === 'string' && !permit.has(t.name)) {
      removed.push(t);
      raw.splice(i, 1);
    }
  }
  return removed.length ? removed : null;
}

/**
 * Re-add tool objects previously hidden by restrictLiveTools() (the restore
 * half). Idempotent per name — never double-adds a tool that re-appeared
 * meanwhile. No-op for a null/empty list or an absent live array.
 * @param {Array<object>|null|undefined} removed
 */
function restoreLiveTools(removed) {
  if (!Array.isArray(removed) || !removed.length) return;
  const raw = globalThis.__ccpRawTools;
  if (!Array.isArray(raw)) return;
  for (const t of removed) {
    if (t && typeof t.name === 'string' && !raw.some((x) => x && x.name === t.name)) {
      raw.push(t);
    }
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
 * Number of SwapCoordinator stack entries owned by `scope` (this instance's
 * current swap depth). Introspection hook for the finalizer's adk.swapDepth().
 * @param {HandoffScope} scope
 * @returns {number}
 */
export function swapDepthIn(scope) {
  if (!scope || typeof scope.id !== 'string') return 0;
  return SwapCoordinator.depthOf(scope.id);
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
 * ownership. Only pops when the shared stack's TOP entry is owned by THIS scope:
 * that is the single-slot-honest definition of "the last swap" across all
 * instances. If the top entry belongs to ANOTHER instance (an out-of-order
 * restore), we DO NOT corrupt it — popping would re-apply this scope's older
 * `prev` over a persona the other instance still owns. Instead we emit
 * `handoff.restore.skipped`, warn once, and return false. No-op when the stack is
 * empty or the writer primitive is unavailable. Delegates to SwapCoordinator.
 * @param {HandoffScope} scope
 * @returns {boolean} true if a prompt was restored.
 */
export function restoreSystemPromptIn(scope) {
  if (!scope || typeof scope.id !== 'string') return false;
  return SwapCoordinator.restore(scope.id);
}

/**
 * Acquire the EXCLUSIVE swap lock for `scope`, making the "single
 * global persona slot, shared by every createAdk() instance" reality explicit and
 * opt-in. Returns a swap TOKEN when no OTHER scope currently holds the lock; else
 * returns null (the caller can then detect contention up front instead of finding
 * out at out-of-order-restore time). Re-acquiring from the SAME scope that already
 * holds the lock returns a fresh token bound to it (idempotent ownership).
 *
 * The token operates on the same SHARED SwapCoordinator stack as the legacy LIFO
 * path — it is a coordination layer, not a private stack:
 *   - token.swap(persona): push `{ owner: scope.id, prev: <live> }` and set the
 *     live prompt. Throws if the token has been released, or if this scope
 *     already owns MAX_SWAP_DEPTH entries (a runaway, never-reverted chain).
 *   - token.restore(): LIFO-pop/restore the top entry IFF this scope owns it
 *     (delegates to restoreSystemPromptIn). Returns the boolean it returns.
 *   - token.release(): restore every remaining entry this scope still owns (LIFO),
 *     drop the lock, and emit handoff.swap.release. Idempotent.
 *   - token.owned (getter): true while this token still holds the lock.
 *
 * Emits handoff.swap.acquire on success and handoff.swap.release on release.
 *
 * @param {HandoffScope} scope
 * @returns {{ swap(persona:string):void, restore():boolean, release():void, readonly owned:boolean }|null}
 */
export function tryAcquireSwap(scope) {
  if (!scope || typeof scope.id !== 'string') return null;
  // Contended: a DIFFERENT scope holds the exclusive lock → refuse.
  if (!SwapCoordinator.acquireLock(scope.id)) return null;

  let released = false;
  busEmit('handoff.swap.acquire', { owner: scope.id });

  const token = {
    get owned() { return !released && SwapCoordinator.lockOwner === scope.id; },
    swap(persona) {
      if (released) throw new Error('tryAcquireSwap: token released — re-acquire before swapping');
      if (typeof persona !== 'string') {
        throw new Error('tryAcquireSwap: swap(persona) requires a string');
      }
      // Same shape/order as the legacy swap path so restoreSystemPromptIn() and
      // swapDepthIn() treat token-pushed entries identically.
      SwapCoordinator.push(scope.id, persona);
    },
    restore() {
      if (released) return false;
      return restoreSystemPromptIn(scope);
    },
    release() {
      if (released) return;
      released = true;
      // Restore any entries this scope still owns, honoring LIFO (only pops while
      // THIS scope owns the top — never clobbers another instance's persona).
      SwapCoordinator.restoreOwned(scope.id);
      SwapCoordinator.releaseLock(scope.id);
      busEmit('handoff.swap.release', { owner: scope.id });
    },
  };
  return token;
}

/**
 * Tear down `scope`'s swap footprint per the instance-dispose
 * contract. LIFO-pops and restores every shared-stack entry OWNED by this scope
 * (restoring each `prev`), releases the exclusive swap lock if this scope holds it,
 * and unregisters the auto-registered `transfer_back` tool if present. Idempotent.
 * Returns the number of swap entries restored. Delegates the stack/lock work to
 * SwapCoordinator.
 *
 * NOTE (single global slot): entries owned by OTHER scopes are left untouched —
 * we never clobber another instance's live persona. An owned entry that is NOT at
 * the LIFO top (because another instance swapped on top of it) cannot be safely
 * popped without corrupting the slot, so it is left in place; SwapCoordinator
 * stops at the first non-owned top. This mirrors the honest-LIFO refusal policy.
 *
 * @param {HandoffScope} scope
 * @returns {number} count of entries restored.
 */
export function disposeHandoffScope(scope) {
  if (!scope || typeof scope.id !== 'string') return 0;
  // Pop/restore only while THIS scope owns the top (honest LIFO; never clobbers
  // another instance). Stops early if an out-of-order top blocks us. Then release
  // the exclusive lock if held by this scope.
  const restored = SwapCoordinator.restoreOwned(scope.id);
  SwapCoordinator.releaseLock(scope.id);
  // Unregister the auto-registered transfer_back tool if it was installed. Prefer
  // the stashed ToolHandle.unregister() (sink-agnostic); fall back to splicing the
  // live __ccpRawTools array by name for the bare-array test path.
  if (scope._restoreToolRegistered) {
    const handle = scope._restoreToolHandle;
    if (handle && typeof handle.unregister === 'function') {
      try { handle.unregister(); } catch (_) {}
    } else {
      const raw = globalThis.__ccpRawTools;
      if (Array.isArray(raw)) {
        const i = raw.findIndex((t) => t && t.name === 'transfer_back');
        if (i !== -1) raw.splice(i, 1);
      }
    }
    scope._restoreToolRegistered = false;
    scope._restoreToolHandle = null;
  }
  return restored;
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
 * @property {boolean} [allowDeferredPin=false] Swap-mode TOCTOU escape hatch. By
 *   default a `swap` handoff whose target is NOT registered at definition time
 *   THROWS — there is no persona to pin, so the define→first-execute window would
 *   be guarded only by the name allowlist (see the residual-trust note below).
 *   Set true to opt back into the legacy pin-on-first-resolve behavior (the first
 *   execute captures the pin) when you genuinely intend to define the handoff
 *   before its target agent.
 */

/**
 * Build a scoped `defineHandoff` bound to a specific agent lookup + tool sink.
 *
 * Swap-mode TOCTOU pin: `allowSwapTargets` only allowlists the target
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
    allowDeferredPin = false,
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

    // Persona PIN at DEFINITION time. If the swap target is already
    // registered, hash its systemPrompt now and close over it; execute-time will
    // refuse the swap if the live persona's hash has drifted. `pinnedHash` stays
    // null for delegate mode or an unregistered target (nothing to pin yet).
    //
    // Pin-on-first-resolve narrows the deferred-case TOCTOU window. When the
    // target was UNREGISTERED at definition time, `pinDeferred` is set and nothing
    // can be pinned yet. Rather than trusting whatever persona is registered on
    // EVERY subsequent execute (guarded only by the name allowlist), the FIRST
    // execute that resolves a live persona CAPTURES its sha256 into `pinnedHash`
    // (mutated in the closure below) and treats it as the pin for all later
    // executes — so a swapped-in persona that later drifts is refused with
    // handoff.pin.mismatch exactly like the define-time-pinned case.
    //
    // DEFAULT: the deferred path is REFUSED (see the throw below) so the
    // define→first-execute window cannot exist unless the caller explicitly opts
    // in with { allowDeferredPin: true }. RESIDUAL TRUST ASSUMPTION when they DO
    // opt in: the pin is captured at the FIRST execute, NOT at defineHandoff(), so
    // whatever persona is registered under `target` in the window between
    // defineHandoff() and that first execute is trusted IMPLICITLY — if an attacker
    // re-defines the target before it is first invoked, pin-on-first-resolve will
    // faithfully pin (and thereafter defend) the ALREADY-SUBSTITUTED persona. The
    // name allowlist is the only guard across that initial window. Callers that need
    // a hard guarantee should leave allowDeferredPin off and define the target
    // BEFORE the handoff so the define-time pin above applies.
    let pinnedHash = null;
    let pinDeferred = false;
    if (mode === 'swap') {
      const defAtDefine = getAgent(target);
      if (defAtDefine && typeof defAtDefine.systemPrompt === 'string') {
        pinnedHash = hashPrompt(defAtDefine.systemPrompt);
      } else if (allowDeferredPin) {
        // Opt-in legacy path: can't pin what doesn't exist yet — note it for the
        // execute path, which captures the pin on first resolve. The caller has
        // explicitly accepted the define→first-execute window (allowDeferredPin).
        pinDeferred = true;
      } else {
        // DEFAULT: refuse to define a swap handoff against an unregistered target.
        // There is no persona to pin, so the define→first-execute window would be
        // guarded only by the name allowlist — a real TOCTOU surface. Fail loud at
        // definition time (a programmer error) instead of silently deferring;
        // define the target agent first, or pass { allowDeferredPin: true } to
        // accept the window deliberately.
        throw new Error(
          `defineHandoff: swap target "${target}" is not registered — define the agent before the ` +
          `handoff so its persona can be pinned at definition time, or pass { allowDeferredPin: true } ` +
          `to opt into pin-on-first-resolve (accepting the define→first-execute TOCTOU window).`,
        );
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
            // TOCTOU pin check. If we pinned the persona at definition
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
              // Pin-on-first-resolve. Target was unregistered at definition time,
              // so this is the FIRST time a live persona has resolved. Capture its
              // hash into the closure NOW and treat it as the pin for all subsequent
              // executes. `handoff.pin.deferred` fires only for this very first
              // resolve (subsequent executes take the pinned branch above);
              // `handoff.pin.captured` records the capture itself. NOTE: this pins
              // whatever was registered as of this first execute — see the residual
              // TOCTOU note at definition time (the define→first-execute window is
              // guarded only by the name allowlist).
              busEmit('handoff.pin.deferred', { id, target });
              pinnedHash = hashPrompt(def.systemPrompt);
              busEmit('handoff.pin.captured', { id, target, pinned: pinnedHash });
            }
            // REVERSIBLE SWAP: a transfer_back tool is auto-registered (once)
            // FIRST so the revert affordance survives the tool restriction below,
            // then we capture the prompt we're replacing onto the SINGLE shared
            // stack (tagged with this scope's id) BEFORE overwriting, so a
            // LIFO-ordered restore() can pop back to it. push() also narrows the
            // live tool surface to the agent's `tools` allowlist (unlike delegate,
            // a swap does not get CC's native allowlist enforcement) and records
            // the hidden tools on the stack entry so restore() re-adds them.
            ensureRestoreTool({ scope, defineTool });
            const removed = SwapCoordinator.push(scope.id, def.systemPrompt, def.tools);
            if (removed && removed.length) {
              busEmit('handoff.tools.restricted', {
                id, target,
                removed: removed.map((t) => t && t.name).filter(Boolean),
                allow: def.tools,
              });
            }
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
  // Stash the handle so disposeHandoffScope() can unregister via the sink's own
  // primitive (the ToolHandle.unregister() returned by defineTool), independent of
  // which sink/registry actually backs this scope.
  scope._restoreToolHandle = defineTool({
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
