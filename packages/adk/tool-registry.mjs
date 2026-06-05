/**
 * tool-registry.mjs — live tool injection into ccpatch's __ccpRawTools.
 *
 * State model: the inject queue, drain flag and poll handle live in a per-instance
 * SCOPE created by `createToolScope()`. `createAdk()` shares one scope across the
 * agent/tool/handoff modules; the top-level `defineTool` export is bound to a
 * lazily-created DEFAULT scope so existing callers/tests keep working.
 *
 * __ccpRawTools is an array reference stashed by expose_tool_dispatch. Injection
 * goes through the NONCE-GATED helpers that patch also exposes
 * (__ccpRegisterTool / __ccpUnregisterTool), so only code holding the dispatch
 * nonce can add/remove tools. When those helpers are ABSENT (e.g. a unit test
 * that stubs a bare `globalThis.__ccpRawTools = []`) we fall back to mutating the
 * array directly — this keeps the bare-array test path working while production
 * (real patch always provides the registrar) stays gated. If neither the helpers
 * nor the array appear, we bound the poll (see POLL_LIMIT) instead of spinning
 * forever.
 */

/**
 * Poll cadence and ceiling. Two cadences, both bounded to ≈5s:
 *   - NO bus: aggressive 50ms primary poll × 100 attempts ≈ 5s.
 *   - LIVE bus subscription to 'tools.ready': the bus is the primary signal, so
 *     the poll becomes a slower safety-net — 250ms × 20 attempts ≈ 5s — to cut
 *     redundant wakeups while keeping the same overall timeout window.
 */
const POLL_INTERVAL_MS = 50;
const POLL_LIMIT = 100;
const POLL_INTERVAL_MS_BUS = 250;
const POLL_LIMIT_BUS = 20;

/** Hard ceiling on serialized input size accepted by a tool's call() boundary. */
const MAX_INPUT_BYTES = 256 * 1024;

/**
 * Lazily-acquired dispatch nonce. The expose_tool_dispatch patch may load AFTER
 * this module, so we (re-)read it at injection time rather than only at load.
 * @returns {string|undefined}
 */
function getDispatchNonce() {
  return globalThis.__ccpGetDispatchNonce?.();
}

/**
 * @typedef {Object} ToolDef
 * @property {string} name
 * @property {string} description
 * @property {object} inputSchema   JSON-schema subset (see validateInput).
 * @property {(input:any)=>any} execute  Returns string | tool_result blocks.
 * @property {(name:string)=>void} [onInjectFail]  Optional callback invoked once
 *   when the bounded poll times out and this tool was never injected (same moment
 *   `.ready` resolves false). Lets authors surface the silent-failure case.
 * @property {boolean} [throwOnInjectFail]  When true, a timed-out injection also
 *   rejects the handle's separate `.injected` promise (default: it resolves to
 *   the same false `.ready` does). `.ready` ALWAYS resolves false (never rejects)
 *   for backward compatibility.
 */

/**
 * The object returned by defineTool: the original def, plus lifecycle handles.
 * @typedef {ToolDef & {
 *   ready: Promise<boolean>,    // resolves true once injected live; false on poll timeout (never rejects)
 *   injected: Promise<boolean>, // like ready, but REJECTS on timeout when throwOnInjectFail is set
 *   dispose: () => boolean       // unregister: remove from __ccpRawTools / cancel queue entry
 * }} ToolHandle
 */

/**
 * @typedef {Object} ToolScope
 * @property {ToolDef[]} queue            Tools awaiting __ccpRawTools.
 * @property {boolean} drained            True once the queue has been flushed.
 * @property {*} pollHandle               setInterval handle (or null).
 * @property {number} pollAttempts        Poll tick counter (bounded by POLL_LIMIT).
 * @property {boolean} pollWarned         True once the "patch not enabled" warning fired.
 * @property {Function|null} busUnsub     Unsubscribe fn for the bus readiness signal.
 * @property {Map<string,{resolve:Function}>} pending  name → {resolve} for .ready promises.
 * @property {Set<string>} live           Names currently injected/queued in this scope
 *                                        (introspection source for listToolsIn).
 */

/**
 * Build a fresh tool-registry scope.
 * @returns {ToolScope}
 */
export function createToolScope() {
  return {
    queue: [],
    drained: false,
    pollHandle: null,
    pollAttempts: 0,
    pollWarned: false,
    busUnsub: null,
    pending: new Map(),
    live: new Set(),
  };
}

/**
 * Names of tools currently live/queued in `scope`. Introspection hook surfaced
 * by createToolRegistry().listTools and the top-level listTools() export so the
 * finalizer can wire adk.listTools().
 * @param {ToolScope} scope
 * @returns {string[]}
 */
export function listToolsIn(scope) {
  return [...scope.live];
}

// ── A tiny dependency-free JSON-schema validator ──────────────────────────────
// Covers ONLY the subset the ADK actually uses. Philosophy: fail-CLOSED on a
// clear violation of a shape we understand, fail-OPEN (accept) on any schema
// shape we cannot interpret.
//
// WHAT IS validated (when the relevant keyword is present):
//   - top-level type 'object' (any other top-level type → fail open entirely)
//   - `required: string[]`                  → presence of each named property
//   - `properties[k].type` ∈ string/number/boolean/object/array → primitive type
//   - `additionalProperties: false`          → reject keys not in `properties`
//   - `properties[k].enum: any[]`            → value must be one of the enum members
//   - `properties[k].minLength/maxLength`    → string length bounds (strings only)
//
// WHAT IS NOT validated (authors must NOT over-trust this):
//   - nested object/array element schemas (no recursion into `items`/sub-`properties`)
//   - number `minimum`/`maximum`, `pattern`, `format`, `const`, `oneOf`/`anyOf`,
//     `additionalProperties` as a SCHEMA (only the literal `false` is honored)
//   - any keyword not listed above is silently ignored (fail open).
// A separate MAX_INPUT_BYTES ceiling (enforced in the call() wrapper, not here)
// guards against oversized input independent of schema.

const PRIMITIVE_CHECK = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && !Number.isNaN(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
};

/**
 * Validate `input` against a (subset) JSON `schema`. See the comment block above
 * for the EXACT set of keywords honored vs. ignored — do not over-trust this.
 * @param {object} schema
 * @param {any} input
 * @returns {string|null} an error message, or null if valid / not interpretable.
 */
export function validateInput(schema, input) {
  // Unknown / non-object schema → fail open.
  if (!schema || typeof schema !== 'object' || schema.type !== 'object') return null;

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return `expected an object input, got ${Array.isArray(input) ? 'array' : typeof input}`;
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (!(key in input) || input[key] === undefined) {
      return `missing required property "${key}"`;
    }
  }

  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};

  // additionalProperties:false → reject any input key not declared in properties.
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (input[key] === undefined) continue;
      if (!(key in props)) {
        return `unexpected property "${key}" (additionalProperties is false)`;
      }
    }
  }

  for (const [key, spec] of Object.entries(props)) {
    if (!(key in input) || input[key] === undefined) continue; // absent optional → ok
    const val = input[key];
    const t = spec && spec.type;
    const check = PRIMITIVE_CHECK[t];
    if (check && !check(val)) {
      return `property "${key}" must be of type ${t}`;
    }

    // enum → value must be one of the declared members (shallow equality).
    if (spec && Array.isArray(spec.enum) && !spec.enum.includes(val)) {
      return `property "${key}" must be one of: ${spec.enum.map((e) => JSON.stringify(e)).join(', ')}`;
    }

    // String length bounds (only meaningful for strings).
    if (typeof val === 'string') {
      if (typeof spec.minLength === 'number' && val.length < spec.minLength) {
        return `property "${key}" must be at least ${spec.minLength} characters`;
      }
      if (typeof spec.maxLength === 'number' && val.length > spec.maxLength) {
        return `property "${key}" must be at most ${spec.maxLength} characters`;
      }
    }
  }
  return null;
}

/** Build a tool_result error block (no execute() call happened). */
function errorResult(text) {
  return [{ type: 'text', text }];
}

/**
 * Build the live tool object handed to the formatter / dispatcher.
 * @param {ToolDef} toolDef
 */
function buildToolObj(toolDef) {
  return {
    name: toolDef.name,
    description: toolDef.description,
    inputSchema: toolDef.inputSchema,
    // Matches the call(input, toolUseContext, toolUseId, extra, progressCb) shape.
    // VALIDATION BOUNDARY — runs BEFORE user execute(). Two independent guards:
    //   1. a hard MAX_INPUT_BYTES ceiling on JSON.stringify(input) length, to
    //      reject huge-input injection regardless of schema;
    //   2. validateInput() against the (subset) inputSchema — see validateInput
    //      for the EXACT keywords honored (type/required/additionalProperties:false/
    //      enum/minLength/maxLength) vs. ignored. Do NOT assume deeper guarantees:
    //      nested schemas, numeric bounds, pattern, etc. are NOT enforced here.
    call: async (input) => {
      let size = 0;
      try { size = JSON.stringify(input === undefined ? null : input).length; } catch (_) { size = 0; }
      if (size > MAX_INPUT_BYTES) {
        return errorResult(
          `Invalid input for tool "${toolDef.name}": input exceeds ${MAX_INPUT_BYTES} byte ceiling (${size})`,
        );
      }
      const verr = validateInput(toolDef.inputSchema, input);
      if (verr) {
        return errorResult(`Invalid input for tool "${toolDef.name}": ${verr}`);
      }
      const result = await toolDef.execute(input);
      return typeof result === 'string' ? [{ type: 'text', text: result }] : result;
    },
  };
}

/**
 * Attempt to inject `toolDef` into the live tool registry. Returns true on success.
 * GATED PATH: if the patch's nonce-gated __ccpRegisterTool exists, route through
 * it with the (lazily re-read) dispatch nonce. FALLBACK: when that registrar is
 * absent (e.g. a unit test stubbing a bare `__ccpRawTools = []`), mutate the raw
 * array directly so the bare-array path keeps working.
 * @param {ToolDef} toolDef
 * @returns {boolean}
 */
function tryInject(toolDef) {
  const toolObj = buildToolObj(toolDef);

  // Gated path — the real patch always provides this registrar.
  if (typeof globalThis.__ccpRegisterTool === 'function') {
    const nonce = getDispatchNonce();
    return globalThis.__ccpRegisterTool(nonce, toolObj) === true;
  }

  // Fallback — direct array mutation when no registrar is present.
  const getRaw = globalThis.__ccpRawTools;
  if (!Array.isArray(getRaw)) return false;
  const existing = getRaw.findIndex((t) => t && t.name === toolDef.name);
  if (existing >= 0) getRaw[existing] = toolObj;
  else getRaw.push(toolObj);
  return true;
}

/**
 * Resolve the pending .ready promise (if any) for `name`. Also settles the
 * sibling .injected promise: resolve(value) on success; on a false outcome the
 * .injected rejection is handled by failInject(), so here we only resolve it
 * when value is truthy (avoid an unhandled rejection on the happy path).
 */
function settleReady(scope, name, value) {
  const p = scope.pending.get(name);
  if (p) {
    scope.pending.delete(name);
    p.resolve(value);
    if (value) p.resolveInjected(true);
  }
}

/**
 * Settle a tool that timed out before injection: .ready resolves false, the
 * onInjectFail callback fires (best effort), and .injected either rejects
 * (throwOnInjectFail) or resolves false.
 * @param {ToolScope} scope
 * @param {ToolDef} def
 */
function failInject(scope, def) {
  const p = scope.pending.get(def.name);
  if (p) scope.pending.delete(def.name);
  scope.live.delete(def.name); // never injected → drop from introspection set
  if (typeof def.onInjectFail === 'function') {
    try { def.onInjectFail(def.name); } catch (_) {}
  }
  if (p) {
    p.resolve(false);
    if (def.throwOnInjectFail) {
      p.rejectInjected(new Error(`adk:tools: tool "${def.name}" was never injected (poll timed out)`));
    } else {
      p.resolveInjected(false);
    }
  }
}

/** Flush every queued tool into __ccpRawTools. Idempotent per drain cycle. */
function drainQueue(scope) {
  if (scope.drained) return;
  scope.drained = true;
  for (const def of scope.queue) {
    if (tryInject(def)) {
      scope.live.add(def.name);
      settleReady(scope, def.name, true);
    }
  }
  scope.queue.length = 0;
}

/** Tear down poller + bus subscription once we've drained or given up. */
function stopWatchers(scope) {
  if (scope.pollHandle !== null) {
    clearInterval(scope.pollHandle);
    scope.pollHandle = null;
  }
  if (typeof scope.busUnsub === 'function') {
    try { scope.busUnsub(); } catch (_) {}
    scope.busUnsub = null;
  }
}

/**
 * Wait for __ccpRawTools then drain. Two paths, both bounded to ≈5s:
 *   - if __ccpBus exposes a 'tools.ready' signal, subscribe and drain on it; the
 *     bus is then the PRIMARY trigger, so the poll downshifts to a slower
 *     safety-net cadence (POLL_INTERVAL_MS_BUS=250ms × POLL_LIMIT_BUS=20 ≈ 5s) to
 *     avoid redundant wakeups;
 *   - with NO live bus, the poll is the primary signal and runs at the aggressive
 *     POLL_INTERVAL_MS=50ms × POLL_LIMIT=100 ≈ 5s.
 * After the limit with no array we stop, warn ONCE, resolve every pending .ready
 * with false, fire each tool's onInjectFail, and reject .injected for any tool
 * that opted into throwOnInjectFail (the tool was never injected).
 */
function scheduleDrain(scope) {
  // Bus readiness fast-path. When a live subscription lands, the poll becomes a
  // slower safety-net rather than the aggressive primary cadence.
  let busActive = false;
  if (scope.busUnsub === null) {
    const bus = globalThis.__ccpBus;
    if (bus && typeof bus.on === 'function') {
      const onReady = () => {
        if (Array.isArray(globalThis.__ccpRawTools)) {
          drainQueue(scope);
          stopWatchers(scope);
        }
      };
      try {
        bus.on('tools.ready', onReady);
        scope.busUnsub = () => { try { bus.off?.('tools.ready', onReady); } catch (_) {} };
        busActive = true;
      } catch (_) { scope.busUnsub = null; }
    }
  } else {
    busActive = true;
  }

  if (scope.pollHandle !== null) return;
  // Pick cadence from whether the bus is carrying the primary signal.
  const interval = busActive ? POLL_INTERVAL_MS_BUS : POLL_INTERVAL_MS;
  const limit = busActive ? POLL_LIMIT_BUS : POLL_LIMIT;
  scope.pollAttempts = 0;
  scope.pollHandle = setInterval(() => {
    if (Array.isArray(globalThis.__ccpRawTools)) {
      drainQueue(scope);
      stopWatchers(scope);
      return;
    }
    if (++scope.pollAttempts >= limit) {
      stopWatchers(scope);
      if (!scope.pollWarned) {
        scope.pollWarned = true;
        try {
          console.warn(
            '[adk:tools] __ccpRawTools never appeared after ~5s — the expose_tool_dispatch ' +
            'patch is not enabled, so ADK tools were never injected.',
          );
        } catch (_) {}
      }
      // Surface the silent failure to every waiting consumer: .ready=false,
      // onInjectFail callback, and .injected rejection (throwOnInjectFail).
      for (const def of scope.queue) failInject(scope, def);
      scope.queue.length = 0;
    }
  }, interval);
}

/**
 * Remove a tool from the live registry by name. Returns true if removed.
 * GATED PATH: prefer the patch's nonce-gated __ccpUnregisterTool; FALLBACK to a
 * direct splice when that helper is absent (bare-array test path).
 * @param {string} name
 * @returns {boolean}
 */
function removeFromRaw(name) {
  if (typeof globalThis.__ccpUnregisterTool === 'function') {
    return globalThis.__ccpUnregisterTool(getDispatchNonce(), name) === true;
  }
  const getRaw = globalThis.__ccpRawTools;
  if (!Array.isArray(getRaw)) return false;
  const i = getRaw.findIndex((t) => t && t.name === name);
  if (i < 0) return false;
  getRaw.splice(i, 1);
  return true;
}

/**
 * Define + inject a tool into `scope`.
 * @param {ToolScope} scope
 * @param {ToolDef} spec
 * @returns {ToolHandle}
 */
export function defineToolIn(scope, { name, description, inputSchema, execute, onInjectFail, throwOnInjectFail } = {}) {
  if (typeof name !== 'string' || !name) {
    throw new Error('defineTool: `name` must be a non-empty string'); // PROGRAMMER error
  }
  if (typeof execute !== 'function') {
    throw new Error(`defineTool("${name}"): \`execute\` must be a function`); // PROGRAMMER error
  }
  if (onInjectFail !== undefined && typeof onInjectFail !== 'function') {
    throw new Error(`defineTool("${name}"): \`onInjectFail\` must be a function`); // PROGRAMMER error
  }

  const def = { name, description, inputSchema, execute, onInjectFail, throwOnInjectFail: !!throwOnInjectFail };

  // .ready resolves true once the tool is live, false if the bounded poll times
  // out (silent-failure fix: a queued-but-never-injected tool must be observable,
  // not masquerade as successful). .injected mirrors .ready EXCEPT it REJECTS on
  // timeout when throwOnInjectFail is set — an opt-in hard signal. The onInjectFail
  // callback (if provided) also fires on timeout.
  let resolveReady;
  const ready = new Promise((res) => { resolveReady = res; });
  let resolveInjected, rejectInjected;
  const injected = new Promise((res, rej) => { resolveInjected = res; rejectInjected = rej; });
  // Default-handle .injected so an unobserved rejection never crashes the process;
  // callers that care attach their own handler.
  injected.catch(() => {});

  if (tryInject(def)) {
    scope.live.add(name);
    resolveReady(true);
    resolveInjected(true);
  } else {
    scope.pending.set(name, { resolve: resolveReady, resolveInjected, rejectInjected });
    scope.queue.push(def);
    scope.live.add(name); // queued tools count as live for introspection until disposed/failed
    scheduleDrain(scope);
  }

  // dispose(): unregister from the live registry AND cancel any pending queue entry.
  const dispose = () => {
    const qi = scope.queue.findIndex((d) => d.name === name);
    if (qi >= 0) scope.queue.splice(qi, 1);
    const p = scope.pending.get(name);
    if (p) { // a disposed-before-injected tool never goes live
      scope.pending.delete(name);
      p.resolve(false);
      p.resolveInjected(false);
    }
    scope.live.delete(name);
    const removed = removeFromRaw(name);
    // If nothing is left waiting, tear the poller down so it doesn't outlive use.
    if (scope.queue.length === 0) stopWatchers(scope);
    return removed;
  };

  return Object.assign(def, { ready, injected, dispose });
}

// ── DEFAULT instance: top-level exports for backward compatibility ────────────

const _defaultScope = createToolScope();

/**
 * Bind the tool-registry API to a given scope.
 * @param {ToolScope} scope
 * @returns {{ defineTool: (spec: ToolDef) => ToolHandle, listTools: () => string[] }}
 */
export function createToolRegistry(scope) {
  return {
    defineTool: (spec) => defineToolIn(scope, spec),
    listTools: () => listToolsIn(scope),
  };
}

/**
 * Define + inject a tool in the DEFAULT (process-global) ADK instance.
 * @param {ToolDef} spec
 * @returns {ToolHandle} the def, augmented with `.ready` (Promise<boolean>) and
 *   `.dispose()` (removes the tool live / cancels its pending queue entry).
 */
export function defineTool(spec) {
  return defineToolIn(_defaultScope, spec);
}

/**
 * Names of tools currently live/queued in the DEFAULT instance. Top-level mirror
 * of createToolRegistry().listTools — the finalizer wires adk.listTools() to the
 * scoped variant; this serves the DEFAULT (process-global) instance.
 * @returns {string[]}
 */
export function listTools() {
  return listToolsIn(_defaultScope);
}

/** The DEFAULT tool scope — shared with the DEFAULT agent/handoff instances. */
export const _defaultToolScope = _defaultScope;
