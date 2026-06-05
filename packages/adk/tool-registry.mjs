/**
 * tool-registry.mjs — live tool injection into ccpatch's __ccpRawTools.
 *
 * State model: the inject queue, drain flag and poll handle live in a per-instance
 * SCOPE created by `createToolScope()`. `createAdk()` shares one scope across the
 * agent/tool/handoff modules; the top-level `defineTool` export is bound to a
 * lazily-created DEFAULT scope so existing callers/tests keep working.
 *
 * __ccpRawTools is an array reference stashed by expose_tool_dispatch. Mutating it
 * in-place makes an injected tool visible to the live formatter without re-patching
 * the tool pipeline. If that patch is NOT enabled the array never appears; we bound
 * the poll (see POLL_LIMIT) instead of spinning forever.
 */

/** Poll cadence and ceiling: 100 attempts × 50ms ≈ 5s before we give up. */
const POLL_INTERVAL_MS = 50;
const POLL_LIMIT = 100;

/**
 * @typedef {Object} ToolDef
 * @property {string} name
 * @property {string} description
 * @property {object} inputSchema   JSON-schema subset (see validateInput).
 * @property {(input:any)=>any} execute  Returns string | tool_result blocks.
 */

/**
 * The object returned by defineTool: the original def, plus lifecycle handles.
 * @typedef {ToolDef & {
 *   ready: Promise<boolean>,   // resolves true once injected live; false on poll timeout
 *   dispose: () => boolean      // unregister: remove from __ccpRawTools / cancel queue entry
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
  };
}

// ── A tiny dependency-free JSON-schema validator ──────────────────────────────
// Covers ONLY the subset the ADK actually uses: type 'object' with `required`
// and `properties` whose entries declare type string/number/boolean/object/array.
// Philosophy: fail-CLOSED on a clear violation of a shape we understand,
// fail-OPEN (accept) on any schema shape we cannot interpret.

const PRIMITIVE_CHECK = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && !Number.isNaN(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
};

/**
 * Validate `input` against a (subset) JSON `schema`.
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
  for (const [key, spec] of Object.entries(props)) {
    if (!(key in input) || input[key] === undefined) continue; // absent optional → ok
    const t = spec && spec.type;
    const check = PRIMITIVE_CHECK[t];
    if (!check) continue; // type we don't model → fail open for this prop
    if (!check(input[key])) {
      return `property "${key}" must be of type ${t}`;
    }
  }
  return null;
}

/** Build a tool_result error block (no execute() call happened). */
function errorResult(text) {
  return [{ type: 'text', text }];
}

/**
 * Attempt to inject `toolDef` into a live __ccpRawTools. Returns true on success.
 * @param {ToolDef} toolDef
 * @returns {boolean}
 */
function tryInject(toolDef) {
  const getRaw = globalThis.__ccpRawTools;
  if (!Array.isArray(getRaw)) return false;

  const toolObj = {
    name: toolDef.name,
    description: toolDef.description,
    inputSchema: toolDef.inputSchema,
    // Matches the call(input, toolUseContext, toolUseId, extra, progressCb) shape.
    // Input is validated at this boundary BEFORE user execute() runs.
    call: async (input) => {
      const verr = validateInput(toolDef.inputSchema, input);
      if (verr) {
        return errorResult(`Invalid input for tool "${toolDef.name}": ${verr}`);
      }
      const result = await toolDef.execute(input);
      return typeof result === 'string' ? [{ type: 'text', text: result }] : result;
    },
  };

  const existing = getRaw.findIndex((t) => t && t.name === toolDef.name);
  if (existing >= 0) getRaw[existing] = toolObj;
  else getRaw.push(toolObj);
  return true;
}

/** Resolve the pending .ready promise (if any) for `name`. */
function settleReady(scope, name, value) {
  const p = scope.pending.get(name);
  if (p) {
    scope.pending.delete(name);
    p.resolve(value);
  }
}

/** Flush every queued tool into __ccpRawTools. Idempotent per drain cycle. */
function drainQueue(scope) {
  if (scope.drained) return;
  scope.drained = true;
  for (const def of scope.queue) {
    if (tryInject(def)) settleReady(scope, def.name, true);
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
 * Wait for __ccpRawTools then drain. Two paths, both bounded:
 *   - if __ccpBus exists, subscribe to a readiness signal and drain on it;
 *   - always run a bounded 50ms poll (≈5s) as the fallback.
 * After POLL_LIMIT attempts with no array we stop, warn ONCE, and reject every
 * pending .ready with false (the tool was never injected).
 */
function scheduleDrain(scope) {
  // Bus readiness fast-path (best effort; poll remains the source of truth).
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
      } catch (_) { scope.busUnsub = null; }
    }
  }

  if (scope.pollHandle !== null) return;
  scope.pollAttempts = 0;
  scope.pollHandle = setInterval(() => {
    if (Array.isArray(globalThis.__ccpRawTools)) {
      drainQueue(scope);
      stopWatchers(scope);
      return;
    }
    if (++scope.pollAttempts >= POLL_LIMIT) {
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
      // Surface the silent failure to every waiting .ready consumer.
      for (const def of scope.queue) settleReady(scope, def.name, false);
      scope.queue.length = 0;
    }
  }, POLL_INTERVAL_MS);
}

/**
 * Remove a tool from the live __ccpRawTools by name. Returns true if removed.
 * @param {string} name
 * @returns {boolean}
 */
function removeFromRaw(name) {
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
export function defineToolIn(scope, { name, description, inputSchema, execute } = {}) {
  if (typeof name !== 'string' || !name) {
    throw new Error('defineTool: `name` must be a non-empty string'); // PROGRAMMER error
  }
  if (typeof execute !== 'function') {
    throw new Error(`defineTool("${name}"): \`execute\` must be a function`); // PROGRAMMER error
  }

  const def = { name, description, inputSchema, execute };

  // .ready resolves true once the tool is live in __ccpRawTools, false if the
  // bounded poll times out (silent-failure fix: a queued-but-never-injected tool
  // must be observable, not masquerade as successful).
  let resolveReady;
  const ready = new Promise((res) => { resolveReady = res; });

  if (tryInject(def)) {
    resolveReady(true);
  } else {
    scope.pending.set(name, { resolve: resolveReady });
    scope.queue.push(def);
    scheduleDrain(scope);
  }

  // dispose(): unregister from the live array AND cancel any pending queue entry.
  const dispose = () => {
    const qi = scope.queue.findIndex((d) => d.name === name);
    if (qi >= 0) scope.queue.splice(qi, 1);
    settleReady(scope, name, false); // a disposed-before-injected tool never goes live
    const removed = removeFromRaw(name);
    // If nothing is left waiting, tear the poller down so it doesn't outlive use.
    if (scope.queue.length === 0) stopWatchers(scope);
    return removed;
  };

  return Object.assign(def, { ready, dispose });
}

// ── DEFAULT instance: top-level exports for backward compatibility ────────────

const _defaultScope = createToolScope();

/**
 * Bind the tool-registry API to a given scope.
 * @param {ToolScope} scope
 * @returns {{ defineTool: (spec: ToolDef) => ToolHandle }}
 */
export function createToolRegistry(scope) {
  return { defineTool: (spec) => defineToolIn(scope, spec) };
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

/** The DEFAULT tool scope — shared with the DEFAULT agent/handoff instances. */
export const _defaultToolScope = _defaultScope;
