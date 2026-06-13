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

import { checkContract } from './contracts.mjs';

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
 * Louder-on-debug warning. Quiet by default (silent-failure modes stay quiet so
 * normal runs aren't noisy); escalates to console.warn only when the project
 * debug switch is on — process.env.CLAUDE_DEBUG or globalThis.__ccpDebug truthy
 * (matches the core/contracts.mjs convention). Best-effort; never throws.
 * @param {string} msg
 */
function debug(msg) {
  if (!(process.env.CLAUDE_DEBUG || globalThis.__ccpDebug)) return;
  try { console.warn(msg); } catch (_) {}
}

/**
 * Load-bearing drift guard for the gated injection path (call-site half). When
 * the typed contract registry is present AND advertises a 'toolDispatch'
 * contract, we positively re-validate it via checkContract('toolDispatch')
 * (contracts.mjs — the ADK's centralized pin table; v>=2, shape
 * ['registerTool'], routed through __ccpRequire when the helper is live)
 * BEFORE routing an injection through the (possibly drifted) __ccpRegisterTool
 * global. Proven drift → tryInject() fails closed.
 *
 * Memoization is ASYMMETRIC ON PURPOSE (mirrors handoff.mjs's
 * assertSystemPromptContract): we latch `_driftChecked = true` ONLY once a
 * REGISTERED contract has positively validated — after that the gated path is
 * proven safe and re-consulting a fixed contract is pure overhead. The fail-OPEN
 * branches (no require/inspect helper, or no 'toolDispatch' contract registered
 * yet) are NOT latched, so a contract registry that populates AFTER the first
 * injection is still honored on a later one — previously a fail-open first call
 * latched the gated path trusted forever and a late-registered drifted contract
 * went undetected. Proven drift returns false WITHOUT latching, so a recovered
 * host re-checks. Fail-open keeps the bare-array / fake-registrar test stubs
 * working — they never register a contract.
 *
 * @returns {boolean} true if the gated path is SAFE to use; false if drift proven.
 */
let _driftChecked = false; // latched true ONLY after a registered contract validates.
function gatedPathTrusted() {
  if (_driftChecked) return true;

  // Centralized pin: contracts.mjs requires 'toolDispatch' v>=2 with shape
  // ['registerTool'] through __ccpRequire when the helper is live, falling back
  // to the registry's advertised metadata otherwise.
  const res = checkContract('toolDispatch');

  // Nothing to prove → fail open, NOT latched (a late contract registry must
  // still be honored on a later injection). Preserves bare-array / stub paths.
  if (res.status === 'unchecked') return true;

  if (res.status === 'drift') {
    // Proven drift: the registered contract does NOT satisfy the ADK's pin.
    // Refuse, but do NOT latch — a recovered host re-checks on the next inject.
    debug(`[adk:tools] refusing injection — toolDispatch contract drift: ${res.reason}`);
    return false;
  }

  // Positively validated a registered contract. Memoize ONLY when the actual
  // value paths were probed through __ccpRequire — an advertised-metadata-only
  // 'ok' (no __ccpRequire on the host) stays unlatched so a later-appearing
  // require helper is still consulted.
  if (res.via === 'require') _driftChecked = true;
  return true;
}

/**
 * TEST SEAM ONLY. The drift guard above memoizes once a registered contract
 * validates; tests that exercise distinct contract-registry configurations
 * within one process need to clear that latch between cases. Not part of the
 * public ADK surface — do not surface in index.mjs / index.d.ts.
 * @returns {void}
 */
export function __resetDriftGuardForTests() {
  _driftChecked = false;
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
 * @property {(input:any)=>(string|null)} [validate]  Optional PLUGGABLE validator.
 *   Runs in the call() boundary AFTER the built-in validateInput
 *   (which short-circuits first on failure). Return a non-empty string to reject
 *   the input with that message, or null/undefined to accept. A thrown error is
 *   surfaced as a validation error. This is the dependency-free hook for plugging
 *   in ajv/zod/etc. to cover the deep checks validateInput does NOT perform.
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
 * @property {*} pollHandle               Shared-scheduler registration sentinel
 *                                        (SHARED_POLL symbol) while waiting, else null.
 * @property {number} pollAttempts        Poll attempt counter (bounded by the scope's pollLimit).
 * @property {number} [pollBaseTicks]     Base-tick counter used to derive the scope's cadence.
 * @property {number} [pollInterval]      Effective poll cadence for this scope (50ms or 250ms).
 * @property {number} [pollLimit]         Give-up attempt ceiling for this scope (100 or 20).
 * @property {boolean} pollWarned         True once the "patch not enabled" warning fired.
 * @property {Function|null} busUnsub     Unsubscribe fn for the bus readiness signal.
 * @property {Map<string,{resolve:Function}>} pending  name → {resolve} for .ready promises.
 * @property {Map<string,'queued'|'live'|'failed'>} live  name → lifecycle status
 *   for every tool this scope knows about. listToolsIn() reports ONLY names whose
 *   status is 'live'; toolStatusesIn() reports the full {name,status} set. (Kept
 *   the field name `live` for backward-compat with internal callers; it is now a
 *   Map of statuses rather than a Set of names.)
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
    live: new Map(), // name → 'queued' | 'live' | 'failed'
  };
}

/**
 * Names of tools currently LIVE in `scope` (status 'live' only — queued and
 * failed tools are intentionally excluded). Introspection hook
 * surfaced by createToolRegistry().listTools and the top-level listTools() export
 * so the finalizer can wire adk.listTools().
 * @param {ToolScope} scope
 * @returns {string[]}
 */
export function listToolsIn(scope) {
  const out = [];
  for (const [name, status] of scope.live) {
    if (status === 'live') out.push(name);
  }
  return out;
}

/**
 * Full lifecycle view of `scope`: every tool the scope knows about
 * with its current status — 'queued' (awaiting injection), 'live' (injected) or
 * 'failed' (poll timed out / never injected). Unlike listToolsIn() this does NOT
 * drop queued/failed entries, so callers can SEE the silent-failure cases.
 * @param {ToolScope} scope
 * @returns {Array<{name:string,status:'queued'|'live'|'failed'}>}
 */
export function toolStatusesIn(scope) {
  return [...scope.live].map(([name, status]) => ({ name, status }));
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
// WHAT IS NOT validated — READ THIS, do NOT treat validateInput as a real
// JSON-Schema validator. It is a SHALLOW, BEST-EFFORT, FAIL-OPEN guard. It does
// NOT, and will NOT, check ANY of the following:
//   - NESTED object/array shapes: there is NO recursion into `items` or into a
//     property's sub-`properties`. A property typed `object`/`array` is checked
//     ONLY for being an object/array — its CONTENTS are completely unchecked.
//   - numeric bounds: `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`/
//     `multipleOf` are ignored.
//   - `pattern`, `format`, `const`, `oneOf`/`anyOf`/`allOf`/`not`, `$ref`.
//   - `additionalProperties` as a SCHEMA (only the literal `false` is honored).
//   - any keyword not in the "WHAT IS validated" list above → silently ignored.
// If you need ANY of the above (deep shapes, numeric ranges, regex, etc.), pass a
// pluggable `validate(input)=>string|null` to defineTool — see the `validate`
// hook below; it runs at the call() boundary AFTER this built-in and is where you wire
// ajv/zod/etc. (zero deps shipped here — the caller brings their own).
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

/**
 * Collect the schema keywords PRESENT in `schema` that validateInput silently
 * IGNORES (see its comment block). Used to warn an author at defineTool() time
 * when they wrote a schema that LOOKS validating but isn't — so the shallow /
 * fail-open built-in stops being a silent foot-gun. Suppressed when the author
 * passes a `validate` hook (the documented escape hatch for deep checks). Scans
 * the root + immediate properties (one level deep); not a full recursive walk.
 * @param {any} schema
 * @returns {string[]} sorted unique keyword labels (empty when all-enforced).
 */
function unenforcedSchemaKeywords(schema) {
  if (!schema || typeof schema !== 'object') return [];
  // A non-object root means validateInput fails open ENTIRELY (validates nothing).
  if (schema.type !== 'object') return ['non-object root type (nothing is validated)'];

  const IGNORED = [
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
    'pattern', 'format', 'const', 'oneOf', 'anyOf', 'allOf', 'not', '$ref',
  ];
  const found = new Set();
  const scan = (node, where) => {
    if (!node || typeof node !== 'object') return;
    for (const k of IGNORED) if (k in node) found.add(`${where}${k}`);
  };
  scan(schema, ''); // root-level combinators / $ref
  // additionalProperties as a SCHEMA (object) — only the literal `false` is honored.
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    found.add('additionalProperties-as-schema (only `false` is honored)');
  }
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  for (const [key, spec] of Object.entries(props)) {
    if (!spec || typeof spec !== 'object') continue;
    scan(spec, `properties.${key}.`);
    // Nested shapes are NOT recursed into — their contents go unchecked.
    if (spec.type === 'object' && spec.properties) found.add(`properties.${key}.properties (nested object not recursed)`);
    if (spec.type === 'array' && spec.items) found.add(`properties.${key}.items (array items not recursed)`);
  }
  return [...found].sort();
}

/** Build a tool_result error block (no execute() call happened). */
function errorResult(text) {
  return [{ type: 'text', text }];
}

/**
 * Cheaply measure the input against the MAX_INPUT_BYTES ceiling without
 * serializing scalars. null/undefined/booleans/numbers are tiny by
 * construction, so we short-circuit to 0; strings use Buffer.byteLength (UTF-8,
 * no allocation of a JSON copy); only objects/arrays fall back to JSON.stringify.
 *
 * UNMEASURABLE objects (cycle / throwing toJSON / a value JSON.stringify maps to
 * `undefined`) return the sentinel Infinity rather than a misleading 0. A 0 here
 * was a real BYPASS: a cyclic/unserializable payload slipped past the
 * MAX_INPUT_BYTES ceiling entirely (0 <= ceiling) and reached execute(). By
 * returning Infinity we force the call() boundary to REJECT such input as
 * un-measurable — fail closed, never silently treat it as empty.
 * @param {any} input
 * @returns {number} approximate UTF-8 byte length, or Infinity if unmeasurable.
 */
function inputByteSize(input) {
  if (input === null || input === undefined) return 0;
  const t = typeof input;
  if (t === 'string') return Buffer.byteLength(input, 'utf8');
  if (t !== 'object') return 0; // number / boolean / bigint / symbol → tiny
  try {
    const json = JSON.stringify(input);
    // JSON.stringify returns undefined for values it cannot represent (e.g. a
    // lone function/symbol) — treat that as unmeasurable too, not 0 bytes.
    if (typeof json !== 'string') return Infinity;
    return Buffer.byteLength(json, 'utf8');
  } catch (_) {
    // Cycle / throwing toJSON → unmeasurable. Sentinel forces a rejection above.
    return Infinity;
  }
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
      const size = inputByteSize(input);
      if (!Number.isFinite(size)) {
        // Unmeasurable object input (cycle / throwing toJSON / unserializable).
        // Reject rather than letting it slip past the ceiling and reach execute().
        return errorResult(
          `Invalid input for tool "${toolDef.name}": input could not be measured/serialized (cyclic or unserializable payload)`,
        );
      }
      if (size > MAX_INPUT_BYTES) {
        return errorResult(
          `Invalid input for tool "${toolDef.name}": input exceeds ${MAX_INPUT_BYTES} byte ceiling (${size})`,
        );
      }
      const verr = validateInput(toolDef.inputSchema, input);
      if (verr) {
        return errorResult(`Invalid input for tool "${toolDef.name}": ${verr}`);
      }
      // Optional pluggable validator (code half) — runs AFTER the built-in
      // validateInput (built-in failure short-circuits above). This is
      // the dependency-free hook that lets a caller plug in ajv/zod/etc. for the
      // deep checks validateInput intentionally does NOT perform. Contract:
      // (input) => string|null — a string is treated as a validation error
      // message, null/undefined means valid. A THROW is also surfaced as an error.
      if (typeof toolDef.validate === 'function') {
        let custom;
        try { custom = toolDef.validate(input); }
        catch (err) { custom = err?.message ?? String(err); }
        if (typeof custom === 'string' && custom) {
          return errorResult(`Invalid input for tool "${toolDef.name}": ${custom}`);
        }
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
    // Drift guard (call-site half): before trusting the gated global, consult the
    // typed contract registry. If the 'toolDispatch' contract is registered and
    // its shape no longer matches (proven drift), refuse rather than call the
    // drifted global. Memoized — runs at most once per process.
    if (!gatedPathTrusted()) return false;
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
  // Never injected → mark 'failed' (observable) rather than dropping it from the
  // status map. listToolsIn() already excludes non-'live' statuses, so it stays
  // out of the live list while toolStatusesIn() can still report it.
  scope.live.set(def.name, 'failed');
  // Louder ONLY on the debug switch (the once-only hard-timeout console.warn in
  // scheduleDrain stays as-is for the no-array case).
  debug(`[adk:tools] tool "${def.name}" was never injected (poll timed out) — status=failed`);
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
      scope.live.set(def.name, 'live');
      settleReady(scope, def.name, true);
    } else {
      // Drain ran but injection still refused (e.g. proven drift / removed array)
      // — surface as a failed inject so it never masquerades as live.
      failInject(scope, def);
    }
  }
  scope.queue.length = 0;
}

/** Tear down poller registration + bus subscription once drained or given up. */
function stopWatchers(scope) {
  if (scope.pollHandle !== null) {
    // pollHandle is now a registration sentinel into the SHARED scheduler, not a
    // per-scope setInterval handle. Deregister + clear.
    deregisterScope(scope);
    scope.pollHandle = null;
  }
  if (typeof scope.busUnsub === 'function') {
    try { scope.busUnsub(); } catch (_) {}
    scope.busUnsub = null;
  }
}

// ── SHARED drain scheduler ────────────────────────────────────────────────────
// Previously every waiting scope armed its OWN setInterval, so N scopes meant N
// timers all polling __ccpRawTools. Now a SINGLE module-level timer ticks the set
// of registered-waiting scopes. Semantics are preserved EXACTLY per scope:
//   - cadence: a scope downshifts to the slower bus safety-net (250ms) once a bus
//     subscription lands, else the aggressive 50ms primary cadence. The shared
//     timer runs at the fast base tick; each scope only advances its own attempt
//     counter every (interval / base) ticks, so its effective cadence and ~5s
//     bounded timeout (interval × limit) are unchanged.
//   - the once-only "patch not enabled" warning fires per scope (scope.pollWarned).
//   - onInjectFail / throwOnInjectFail behaviour on give-up is unchanged.
const _waitingScopes = new Set();
let _schedulerHandle = null;

/** Register `scope` with the shared scheduler and ensure the single timer runs. */
function registerScope(scope) {
  _waitingScopes.add(scope);
  scope.pollHandle = SHARED_POLL; // sentinel: "registered in the shared scheduler"
  if (_schedulerHandle === null) {
    _schedulerHandle = setInterval(tickAll, POLL_INTERVAL_MS);
    // Don't keep the event loop alive solely for the drain poll.
    if (typeof _schedulerHandle?.unref === 'function') _schedulerHandle.unref();
  }
}

/** Deregister `scope`; stop the single timer once no scope is waiting. */
function deregisterScope(scope) {
  _waitingScopes.delete(scope);
  if (_waitingScopes.size === 0 && _schedulerHandle !== null) {
    clearInterval(_schedulerHandle);
    _schedulerHandle = null;
  }
}

/** Sentinel stored in scope.pollHandle while a scope is registered (truthy != null). */
const SHARED_POLL = Symbol('adk:tools:shared-poll');

/** One shared tick: advance/drain/give-up every registered-waiting scope. */
function tickAll() {
  // Iterate a snapshot — handlers mutate _waitingScopes (drain/give-up deregister).
  for (const scope of [..._waitingScopes]) pollOnce(scope);
}

/**
 * Advance a single scope by one base tick. Honors the scope's own interval (only
 * counts an attempt every interval/base ticks) and per-scope give-up limit.
 */
function pollOnce(scope) {
  if (Array.isArray(globalThis.__ccpRawTools)) {
    drainQueue(scope);
    stopWatchers(scope);
    return;
  }
  // Count base ticks; only advance the attempt counter on the scope's cadence.
  scope.pollBaseTicks = (scope.pollBaseTicks || 0) + 1;
  const ticksPerAttempt = Math.max(1, Math.round(scope.pollInterval / POLL_INTERVAL_MS));
  if (scope.pollBaseTicks < ticksPerAttempt) return;
  scope.pollBaseTicks = 0;

  if (++scope.pollAttempts >= scope.pollLimit) {
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
}

/**
 * Register `scope` to wait for __ccpRawTools then drain. Two paths, both bounded
 * to ≈5s:
 *   - if __ccpBus exposes a 'tools.ready' signal, subscribe and drain on it; the
 *     bus is then the PRIMARY trigger, so the poll downshifts to a slower
 *     safety-net cadence (POLL_INTERVAL_MS_BUS=250ms × POLL_LIMIT_BUS=20 ≈ 5s) to
 *     avoid redundant wakeups;
 *   - with NO live bus, the poll is the primary signal and runs at the aggressive
 *     POLL_INTERVAL_MS=50ms × POLL_LIMIT=100 ≈ 5s.
 * The actual ticking is done by the SINGLE shared scheduler (see above); this fn
 * only wires the bus fast-path, fixes the scope's cadence/limit, and registers it.
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

  if (scope.pollHandle !== null) return; // already registered/waiting.
  // Pick cadence from whether the bus is carrying the primary signal.
  scope.pollInterval = busActive ? POLL_INTERVAL_MS_BUS : POLL_INTERVAL_MS;
  scope.pollLimit = busActive ? POLL_LIMIT_BUS : POLL_LIMIT;
  scope.pollAttempts = 0;
  scope.pollBaseTicks = 0;
  registerScope(scope);
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
export function defineToolIn(scope, { name, description, inputSchema, execute, onInjectFail, throwOnInjectFail, validate } = {}) {
  if (typeof name !== 'string' || !name) {
    throw new Error('defineTool: `name` must be a non-empty string'); // PROGRAMMER error
  }
  if (typeof execute !== 'function') {
    throw new Error(`defineTool("${name}"): \`execute\` must be a function`); // PROGRAMMER error
  }
  if (onInjectFail !== undefined && typeof onInjectFail !== 'function') {
    throw new Error(`defineTool("${name}"): \`onInjectFail\` must be a function`); // PROGRAMMER error
  }
  if (validate !== undefined && typeof validate !== 'function') {
    throw new Error(`defineTool("${name}"): \`validate\` must be a function`); // PROGRAMMER error
  }

  // SCHEMA FOOT-GUN SIGNAL: validateInput is a shallow, fail-open subset of JSON
  // Schema — keywords it cannot interpret (numeric bounds, pattern, nested
  // shapes, combinators, …) are silently accepted. An author who wrote such a
  // schema likely THINKS it validates. When no pluggable `validate` hook was
  // supplied (the documented escape hatch), warn (debug-gated) naming exactly the
  // keywords that will NOT be enforced, so the gap is observable at definition
  // time instead of silent at call time.
  if (typeof validate !== 'function') {
    const unenforced = unenforcedSchemaKeywords(inputSchema);
    if (unenforced.length) {
      debug(
        `[adk:tools] tool "${name}": inputSchema contains keyword(s) the built-in validateInput does NOT enforce: ${unenforced.join(', ')}. ` +
        'Pass a validate(input)=>string|null hook (ajv/zod/etc.) to deep-check them.',
      );
    }
  }

  const def = { name, description, inputSchema, execute, onInjectFail, throwOnInjectFail: !!throwOnInjectFail, validate };

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
    scope.live.set(name, 'live');
    resolveReady(true);
    resolveInjected(true);
  } else {
    scope.pending.set(name, { resolve: resolveReady, resolveInjected, rejectInjected });
    scope.queue.push(def);
    // Queued tools are tracked as 'queued' — NOT reported by listToolsIn() until
    // they actually go 'live'.
    scope.live.set(name, 'queued');
    // Silent-by-default queueing — escalate to a warning only when the debug
    // switch is on, so authors can see a tool that did not inject immediately.
    debug(`[adk:tools] tool "${name}" queued (registry not ready) — awaiting injection`);
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
 * @returns {{ defineTool: (spec: ToolDef) => ToolHandle, listTools: () => string[],
 *   toolStatuses: () => Array<{name:string,status:'queued'|'live'|'failed'}> }}
 */
export function createToolRegistry(scope) {
  return {
    defineTool: (spec) => defineToolIn(scope, spec),
    listTools: () => listToolsIn(scope),
    // Scope-bound full lifecycle view (queued/live/failed).
    toolStatuses: () => toolStatusesIn(scope),
  };
}

/**
 * Tear down a tool scope (cross-agent dispose contract). Idempotent:
 *   - deregister the scope from the shared drain scheduler + drop its bus sub;
 *   - unregister/dispose every LIVE tool from the registry (gated or fallback);
 *   - clear the queue and resolve any pending .ready to false (so awaiters never
 *     hang), settling .injected too;
 *   - clear the status map.
 * @param {ToolScope} scope
 */
export function disposeToolScope(scope) {
  if (!scope) return;
  // Stop pollers/watchers first so nothing re-drains mid-teardown.
  stopWatchers(scope);

  // Unregister every tool we believe is LIVE in the registry.
  for (const [name, status] of [...scope.live]) {
    if (status === 'live') {
      try { removeFromRaw(name); } catch (_) {}
    }
  }

  // Resolve every still-pending .ready false (queued-but-never-injected tools).
  for (const [, p] of [...scope.pending]) {
    try { p.resolve(false); p.resolveInjected(false); } catch (_) {}
  }
  scope.pending.clear();

  // Clear queue + status map; reset drain bookkeeping for reuse.
  scope.queue.length = 0;
  scope.live.clear();
  scope.drained = false;
  scope.pollHandle = null;
  scope.pollAttempts = 0;
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

/**
 * Full lifecycle view of the DEFAULT instance: every tool it knows about with its
 * current status — 'queued' / 'live' / 'failed'. Top-level mirror of
 * createToolRegistry().toolStatuses — the finalizer wires adk.toolStatuses() to
 * the scoped variant; this serves the DEFAULT (process-global) instance so the
 * queued/live/failed view can be surfaced publicly.
 * @returns {Array<{name:string,status:'queued'|'live'|'failed'}>}
 */
export function toolStatuses() {
  return toolStatusesIn(_defaultScope);
}

/** The DEFAULT tool scope — shared with the DEFAULT agent/handoff instances. */
export const _defaultToolScope = _defaultScope;
