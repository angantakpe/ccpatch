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

import { contractVerdict, __resetContractVerdictsForTests } from './contracts.mjs';
import { host } from './host.mjs';

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
  return host.getDispatchNonce();
}

/**
 * Louder-on-debug warning. Quiet by default (silent-failure modes stay quiet so
 * normal runs aren't noisy); escalates to console.warn only when the project
 * debug switch is on — process.env.CLAUDE_DEBUG or globalThis.__ccpDebug truthy
 * (matches the core/contracts.mjs convention). Best-effort; never throws.
 * @param {string} msg
 */
function debug(msg) {
  if (!host.debug()) return;
  try { console.warn(msg); } catch (_) {}
}

/**
 * Load-bearing drift guard for the gated injection path (call-site half). When
 * the typed contract registry is present AND advertises a 'toolDispatch'
 * contract, the centralized verdict positively re-validates it (contracts.mjs —
 * the ADK's pin table; v>=2, shape ['registerTool'], routed through
 * __ccpRequire when the helper is live) BEFORE routing an injection through the
 * (possibly drifted) __ccpRegisterTool global. Proven drift → tryInject() fails
 * closed.
 *
 * The "latch only when proven via require, re-check otherwise" memoization rule
 * (previously duplicated here and in handoff.mjs's assertSystemPromptContract)
 * now lives once in `contractVerdict()`. This site keeps only its *reaction*:
 * 'refuse' → false; everything else ('trusted'/'proceed') → true. The fail-OPEN
 * 'proceed' branch (no require/inspect helper, or no 'toolDispatch' contract
 * registered yet) is the centralized non-latched path, so a registry that
 * populates AFTER the first injection is still honored on a later one; proven
 * drift is likewise non-latched so a recovered host re-checks. Fail-open keeps
 * the bare-array / fake-registrar test stubs working — they never register a
 * contract.
 *
 * @returns {boolean} true if the gated path is SAFE to use; false if drift proven.
 */
function gatedPathTrusted() {
  const v = contractVerdict('toolDispatch');
  if (v.decision === 'refuse') {
    // Proven drift: the registered contract does NOT satisfy the ADK's pin.
    debug(`[adk:tools] refusing injection — toolDispatch contract drift: ${v.reason}`);
    return false;
  }
  return true; // 'trusted' (require-proven) or 'proceed' (nothing to prove / advertised-only)
}

/**
 * TEST SEAM ONLY. Back-compat alias for the now-central
 * __resetContractVerdictsForTests; clears the toolDispatch latch specifically so
 * existing tests that import this name from the tool-registry keep working. Not
 * part of the public ADK surface — do not surface in index.mjs / index.d.ts.
 * @returns {void}
 */
export function __resetDriftGuardForTests() {
  __resetContractVerdictsForTests('toolDispatch');
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
 * @property {Set<string>} owned  Names the ADK registered itself; the fallback
 *   (bare-array) path only upserts names in this set so it never clobbers a
 *   pre-existing non-ADK tool (e.g. a built-in Bash/Read).
 */

/**
 * Build a fresh tool-registry scope.
 * @returns {ToolScope}
 */
export function createToolScope() {
  return {
    queue: [],
    drained: false, // legacy field; no longer gates the drain (see drainQueue).
    pollHandle: null,
    pollAttempts: 0,
    pollWarned: false,
    busUnsub: null,
    pending: new Map(),
    live: new Map(), // name → 'queued' | 'live' | 'failed'
    // Names the ADK itself registered into __ccpRawTools via the FALLBACK
    // (bare-array) path. Used to REFUSE clobbering a pre-existing non-ADK entry of
    // the same name (e.g. the CLI's built-in Bash/Read/...): the fallback path
    // only upserts names the ADK owns. The gated path defers to the producer's
    // __ccpRegisterTool, but we still record ownership there for symmetry.
    owned: new Set(),
    // Latched true the first time an injection successfully routes through the
    // nonce-gated registrar. Once a scope has PROVEN the host runs the
    // authenticated dispatch model, the unauthenticated fallback (direct
    // __ccpRawTools mutation) must NOT silently take over if the registrar later
    // disappears mid-session — that is a privilege DOWNGRADE. See tryInject's
    // fallback arm. Recovery happens (non-latching) when the registrar returns.
    everGated: false,
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

/**
 * Per-tool dedupe for the one-time schema foot-gun warning. The "these keywords
 * are not enforced; supply a validate() hook" line is a one-time AUTHORING signal
 * on the untrusted-input boundary, so it fires UNCONDITIONALLY (NOT debug-gated —
 * production authoring still needs to learn its schema isn't being enforced), but
 * only ONCE per tool name so re-defining the same tool doesn't spam it.
 * Module-level so it dedupes across scopes (the message names the tool, not the
 * scope).
 * @type {Set<string>}
 */
const _schemaWarnedTools = new Set();

/**
 * TEST SEAM ONLY. Clears the per-tool schema-warning dedupe so a test can assert
 * the unconditional once-per-tool firing deterministically within one process.
 * Not part of the public ADK surface — do not surface in index.mjs / index.d.ts.
 * @returns {void}
 */
export function __resetSchemaWarnDedupeForTests() {
  _schemaWarnedTools.clear();
}

/** Build a tool_result error block (no execute() call happened). */
function errorResult(text) {
  return [{ type: 'text', text }];
}

/**
 * Canonical form of a tool name for COLLISION DETECTION ONLY (never for
 * registration — the dispatcher always sees the author's exact name). Catches
 * confusable shadowings of an existing/built-in name: surrounding whitespace,
 * case folding, and unicode confusables that NFKC + lower-case collapse (e.g.
 * fullwidth/ligature forms). Fail-OPEN: any throw (exotic input, no String
 * normalize) falls back to the raw string so a normalization hiccup can never
 * break injection — the caller then degrades to plain exact-equality.
 * @param {string} name
 * @returns {string} the normalized comparison key.
 */
function normalizeNameForCollision(name) {
  if (typeof name !== 'string') return name;
  try {
    let n = name.trim();
    if (typeof n.normalize === 'function') n = n.normalize('NFKC');
    return n.toLowerCase();
  } catch (_) {
    return name; // fail open → caller compares raw, exactly as before.
  }
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
 * @typedef {'ok'|'refused'|'absent'|'collision'} InjectOutcome
 *   - 'ok'        — the tool is now live in the registry.
 *   - 'refused'   — a TRANSIENT, recoverable refusal: proven toolDispatch drift.
 *     A drifted host may RECOVER, so the caller should keep polling within the
 *     bounded limit (and only fail when the attempts are exhausted), NOT latch.
 *   - 'absent'    — the registry array / gated registrar isn't present yet. Also
 *     TRANSIENT: a late-binding host may populate it within the poll window.
 *   - 'collision' — TERMINAL refusal: the fallback path found a same-named entry
 *     the ADK does NOT own (a built-in like Bash/Read). This will never resolve by
 *     polling, so the caller fails it immediately with a clear error rather than
 *     burning the whole poll window.
 *
 * Tri(quad)-state (was boolean) so the drain/poll loop can DISTINGUISH a
 * transient refusal (re-queue and keep polling within the bounded limit) from a
 * terminal give-up (failInject when attempts exhaust, or immediately on a
 * collision), instead of latching every refusal straight to 'failed'.
 */

/**
 * Attempt to inject `toolDef` into the live tool registry.
 * GATED PATH: if the patch's nonce-gated __ccpRegisterTool exists, route through
 * it with the (lazily re-read) dispatch nonce. FALLBACK: when that registrar is
 * absent (e.g. a unit test stubbing a bare `__ccpRawTools = []`), mutate the raw
 * array directly so the bare-array path keeps working — but REFUSE to overwrite a
 * name the ADK does not own (collision with a built-in like Bash/Read).
 *
 * MAY THROW: the gated registrar throws on an invalid/rotated nonce. Callers in
 * the shared scheduler MUST wrap this in try/catch (fail-open-at-runtime rule) —
 * an escaped throw would surface as a process-level uncaughtException.
 *
 * @param {ToolScope} scope  scope whose ownership set guards fallback upserts.
 * @param {ToolDef} toolDef
 * @returns {InjectOutcome}
 */
function tryInject(scope, toolDef) {
  const toolObj = buildToolObj(toolDef);

  // Gated path — the real patch always provides this registrar.
  if (host.hasRegisterTool()) {
    // Drift guard (call-site half): before trusting the gated global, consult the
    // typed contract registry. If the 'toolDispatch' contract is registered and
    // its shape no longer matches (proven drift), refuse rather than call the
    // drifted global. NOT latched on drift — a recovered host re-checks, so this
    // is a TRANSIENT 'refused' (the drain keeps polling), not a terminal failure.
    if (!gatedPathTrusted()) return 'refused';
    const nonce = getDispatchNonce();
    // May throw (invalid nonce) — the caller's try/catch turns that into a
    // failed-this-attempt, never an uncaught exception.
    const ok = host.callRegisterTool(nonce, toolObj) === true;
    if (ok) {
      scope.owned.add(toolDef.name);
      // Remember that this scope has a proven authenticated path. If the registrar
      // later vanishes, the fallback arm below refuses to silently downgrade.
      scope.everGated = true;
    }
    return ok ? 'ok' : 'refused';
  }

  // PRIVILEGE-DOWNGRADE GUARD. If this scope EVER injected through the nonce-gated
  // registrar but the registrar is now absent (removed mid-session) while
  // __ccpRawTools stays live, the unauthenticated fallback must NOT silently take
  // over — an attacker who can drop the registrar global could otherwise inject
  // ANY tool (no nonce, no contract) straight into the live dispatch array. Refuse
  // as a TRANSIENT drift (non-latching, like gatedPathTrusted): the bounded poll
  // keeps retrying, so if the registrar comes back the next tick injects through
  // the authenticated path. Fail-open is preserved for the never-gated bare-array
  // path (everGated stays false there).
  if (scope.everGated) {
    debug(`[adk:tools] refusing fallback injection of "${toolDef.name}" — gated registrar disappeared mid-session (privilege downgrade)`);
    return 'refused';
  }

  // Fallback — direct array mutation when no registrar is present.
  const getRaw = host.rawTools();
  if (!Array.isArray(getRaw)) return 'absent';

  // CONFUSABLE-SHADOW GUARD. The collision check compares NORMALIZED names (trim +
  // NFKC + case-fold) so a built-in like "Bash" can't be shadowed by "bash",
  // "Bash " or a unicode-confusable that the dispatcher would route distinctly.
  // We only refuse a normalized match against a name the ADK does NOT own — an
  // ADK-owned name is ours to re-upsert. Registration below still uses the
  // author's EXACT name (toolDef.name), never the normalized form.
  const incomingNorm = normalizeNameForCollision(toolDef.name);
  const existing = getRaw.findIndex((t) => t && t.name === toolDef.name);
  if (existing >= 0 && scope.owned.has(toolDef.name)) {
    // Exact re-upsert of a name the ADK already owns — overwrite in place.
    getRaw[existing] = toolObj;
    scope.owned.add(toolDef.name);
    return 'ok';
  }

  // Any existing entry (exact OR confusable-normalized) that the ADK does NOT own
  // is a pre-existing built-in/foreign tool. __ccpRawTools is the SAME array the
  // CLI dispatches built-ins (Bash/Read/...) from, so pushing a confusable variant
  // would let an author shadow a built-in name. Refuse terminally — surfaced via
  // the .ready/.injected path, exactly like the exact-name collision.
  const shadowed = getRaw.some((t) => {
    if (!t || scope.owned.has(t.name)) return false;
    return t.name === toolDef.name || normalizeNameForCollision(t.name) === incomingNorm;
  });
  if (shadowed) {
    debug(`[adk:tools] refusing to shadow pre-existing non-ADK tool (incoming "${toolDef.name}")`);
    return 'collision';
  }

  // No collision: a brand-new name we may inject.
  getRaw.push(toolObj);
  scope.owned.add(toolDef.name);
  return 'ok';
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
 * Settle a tool that will never inject: .ready resolves false, the onInjectFail
 * callback fires (best effort), and .injected either rejects (throwOnInjectFail)
 * or resolves false. Terminal — used both on bounded-poll exhaustion and on an
 * immediately-terminal refusal (e.g. a name collision).
 * @param {ToolScope} scope
 * @param {ToolDef} def
 * @param {string} [reason]  Human-readable cause; defaults to the poll-timeout
 *   message. Threaded into the debug line and the throwOnInjectFail rejection.
 */
function failInject(scope, def, reason) {
  const why = reason || 'was never injected (poll timed out)';
  const p = scope.pending.get(def.name);
  if (p) scope.pending.delete(def.name);
  // Never injected → mark 'failed' (observable) rather than dropping it from the
  // status map. listToolsIn() already excludes non-'live' statuses, so it stays
  // out of the live list while toolStatusesIn() can still report it.
  scope.live.set(def.name, 'failed');
  // Louder ONLY on the debug switch (the once-only hard-timeout console.warn in
  // scheduleDrain stays as-is for the no-array case).
  debug(`[adk:tools] tool "${def.name}" ${why} — status=failed`);
  if (typeof def.onInjectFail === 'function') {
    try { def.onInjectFail(def.name); } catch (_) {}
  }
  if (p) {
    p.resolve(false);
    if (def.throwOnInjectFail) {
      p.rejectInjected(new Error(`adk:tools: tool "${def.name}" ${why}`));
    } else {
      p.resolveInjected(false);
    }
  }
}

/** Error text surfaced when the fallback path refuses to clobber a non-ADK tool. */
const COLLISION_REASON = 'name collides with a pre-existing non-ADK tool — refusing to overwrite it';

/**
 * Flush the CURRENT queue into __ccpRawTools.
 *
 * NON-LATCHING (this is the core of the drift-recovery fix): the old version
 * early-returned on a sticky `scope.drained` boolean and sent any refused tool
 * STRAIGHT to a terminal 'failed' with no re-queue — which permanently failed a
 * tool within ~50ms and tore the poller down, so a host that later RECOVERED a
 * drifted contract could never inject it. Instead we splice the current queue and
 * branch per tool on tryInject's tri-state:
 *   - 'ok'        → live + settle .ready(true);
 *   - 'collision' → TERMINAL failInject now (polling can never resolve it);
 *   - 'refused'/'absent' → TRANSIENT: re-queue (keep polling) while bounded poll
 *     attempts remain; only fail when the ceiling is exhausted (pollOnce drives
 *     that). A permanently-drifted host therefore still settles to 'failed' at
 *     ~5s — it just isn't latched after the first ~50ms.
 *
 * Each inject is wrapped in try/catch: the gated registrar throws on an
 * invalid/rotated nonce, and that throw must NOT escape the shared setInterval as
 * an uncaughtException (fail-open-at-runtime rule). A throw is treated as a
 * transient failed-this-attempt (re-queued like 'refused').
 *
 * @param {ToolScope} scope
 */
function drainQueue(scope) {
  // Splice the current batch; refusals are re-queued onto scope.queue below so a
  // later tick (within the bounded poll) retries them — no sticky latch.
  const batch = scope.queue.splice(0, scope.queue.length);
  const exhausted = scope.pollAttempts >= (scope.pollLimit || POLL_LIMIT);
  for (const def of batch) {
    let outcome;
    try {
      outcome = tryInject(scope, def);
    } catch (err) {
      // Gated registrar threw (e.g. invalid/rotated nonce). Fail open: treat as a
      // transient failed-this-attempt rather than crashing the scheduler.
      debug(`[adk:tools] inject threw for "${def.name}": ${(err && err.message) || err}`);
      outcome = 'refused';
    }

    if (outcome === 'ok') {
      scope.live.set(def.name, 'live');
      settleReady(scope, def.name, true);
    } else if (outcome === 'collision') {
      // Terminal: a polling retry can never clear a non-ADK name collision.
      failInject(scope, def, COLLISION_REASON);
    } else if (exhausted) {
      // Transient refusal/absence, but the bounded poll is spent — settle failed
      // so a permanently-drifted host doesn't leave tools queued forever.
      failInject(scope, def, 'was never injected (poll timed out / contract drift)');
    } else {
      // Transient: keep it queued and let the bounded poll retry on a later tick.
      scope.queue.push(def);
    }
  }
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
 * counts an attempt every interval/base ticks) and per-scope give-up ceiling.
 *
 * Two reasons a tool can still be waiting after the array appears:
 *   - the array is genuinely absent (host not ready), OR
 *   - the array is present but the gated path is refusing (proven drift) — the
 *     drift guard does NOT latch, so a RECOVERED host can still inject on a later
 *     tick. drainQueue re-queues such transient refusals.
 * So we ALWAYS advance the bounded attempt counter on the scope's cadence (not
 * just when the array is absent), attempt a drain, and only tear the watchers
 * down once the queue is empty (drained) or the bounded ceiling is reached. This
 * keeps the ~5s timeout intact for a permanently-drifted host while letting a
 * recovered one settle.
 */
function pollOnce(scope) {
  // Count base ticks; only advance the attempt counter on the scope's cadence.
  scope.pollBaseTicks = (scope.pollBaseTicks || 0) + 1;
  const ticksPerAttempt = Math.max(1, Math.round((scope.pollInterval || POLL_INTERVAL_MS) / POLL_INTERVAL_MS));
  if (scope.pollBaseTicks < ticksPerAttempt) return;
  scope.pollBaseTicks = 0;

  const reachedCeiling = ++scope.pollAttempts >= (scope.pollLimit || POLL_LIMIT);

  // Attempt a drain whenever the array is present. drainQueue is non-latching: it
  // settles 'ok'/'collision' tools and re-queues transient refusals (drift /
  // absent). On the LAST attempt (reachedCeiling) it fails any still-refusing
  // tools terminally instead of re-queuing them (see drainQueue's `exhausted`).
  if (host.hasRawTools()) {
    // Wrapped: although drainQueue catches per-tool inject throws internally, keep
    // a belt-and-braces guard so nothing escapes the shared setInterval.
    try { drainQueue(scope); } catch (_) {}
    if (scope.queue.length === 0) {
      // Everything settled (live or terminally failed) — stop watching.
      stopWatchers(scope);
      return;
    }
    // Still-refusing tools remain queued; fall through to the ceiling check so a
    // permanently-drifted host still tears down at ~5s.
  }

  if (reachedCeiling) {
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
    // Surface the silent failure to every still-waiting consumer: .ready=false,
    // onInjectFail callback, and .injected rejection (throwOnInjectFail). Catch so
    // a failInject side effect can't escape the shared scheduler either.
    for (const def of scope.queue.splice(0, scope.queue.length)) {
      try { failInject(scope, def); } catch (_) {}
    }
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
    const bus = host.bus();
    if (bus && typeof bus.on === 'function') {
      const onReady = () => {
        if (host.hasRawTools()) {
          // Non-latching drain: settles 'ok'/'collision' tools and re-queues
          // transient refusals (drift). Only stop watching once the queue is
          // empty — otherwise the bounded poll keeps retrying drift recovery.
          try { drainQueue(scope); } catch (_) {}
          if (scope.queue.length === 0) stopWatchers(scope);
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
  if (host.hasUnregisterTool()) {
    // The gated unregistrar throws on an invalid/rotated nonce, exactly like the
    // registrar. dispose()/disposeToolScope() must NOT let that escape (some run
    // from finalizers / teardown where a throw would crash the caller), so treat a
    // throw as "not removed" — fail open, consistent with the inject paths.
    try {
      return host.callUnregisterTool(getDispatchNonce(), name) === true;
    } catch (err) {
      debug(`[adk:tools] unregister threw for "${name}": ${(err && err.message) || err}`);
      return false;
    }
  }
  const getRaw = host.rawTools();
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
  // supplied (the documented escape hatch), warn naming exactly the keywords that
  // will NOT be enforced, so the gap is observable at definition time instead of
  // silent at call time.
  //
  // This is a one-time AUTHORING signal on the untrusted-input boundary, so it
  // fires UNCONDITIONALLY (NOT debug-gated — a production author still needs to
  // learn their schema isn't being enforced) but only ONCE per tool name (dedupe)
  // so re-defining the same tool can't turn it into per-call noise. The detailed
  // keyword breakdown stays on the same line; finer per-keyword preview detail can
  // remain debug-gated below.
  if (typeof validate !== 'function' && !_schemaWarnedTools.has(name)) {
    const unenforced = unenforcedSchemaKeywords(inputSchema);
    if (unenforced.length) {
      _schemaWarnedTools.add(name);
      try {
        console.warn(
          `[adk:tools] tool "${name}": inputSchema contains keyword(s) the built-in validateInput does NOT enforce: ${unenforced.join(', ')}. ` +
          'Pass a validate(input)=>string|null hook (ajv/zod/etc.) to deep-check them.',
        );
      } catch (_) { /* warning must never break defineTool */ }
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

  // Synchronous first attempt. tryInject may THROW (gated registrar, invalid/
  // rotated nonce) — but that is a HOST runtime condition, not a programmer
  // error: the ADK acquires the nonce internally, and every OTHER injection path
  // (drainQueue / removeFromRaw) already treats a nonce throw as transient and
  // retries. Treat the first attempt the same way — queue and let the bounded
  // poll re-attempt — instead of letting it escape fatally and asymmetrically.
  let outcome;
  try {
    outcome = tryInject(scope, def);
  } catch (err) {
    debug(`[adk:tools] tool "${name}" first inject threw (${err?.message ?? err}) — queueing for bounded retry`);
    outcome = 'refused';
  }
  if (outcome === 'ok') {
    scope.live.set(name, 'live');
    resolveReady(true);
    resolveInjected(true);
  } else if (outcome === 'collision') {
    // Terminal: the name collides with a pre-existing non-ADK tool (e.g. a
    // built-in). Polling can never clear it — fail loudly NOW via .ready/.injected
    // so the author sees it instead of waiting out the whole poll window.
    scope.pending.set(name, { resolve: resolveReady, resolveInjected, rejectInjected });
    scope.live.set(name, 'queued'); // failInject flips this to 'failed'
    failInject(scope, def, COLLISION_REASON);
  } else {
    // 'refused' (transient drift) / 'absent' — queue and let the bounded poll
    // retry. A recovered host (or a late-binding array) injects on a later tick.
    scope.pending.set(name, { resolve: resolveReady, resolveInjected, rejectInjected });
    scope.queue.push(def);
    // Queued tools are tracked as 'queued' — NOT reported by listToolsIn() until
    // they actually go 'live'.
    scope.live.set(name, 'queued');
    // Silent-by-default queueing — escalate to a warning only when the debug
    // switch is on, so authors can see a tool that did not inject immediately.
    debug(`[adk:tools] tool "${name}" queued (registry not ready / contract drift) — awaiting injection`);
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
    scope.owned.delete(name); // relinquish ownership so a later re-define can re-upsert.
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
  scope.owned.clear();
  scope.drained = false;
  scope.pollHandle = null;
  scope.pollAttempts = 0;
  // Reset cadence + once-only warning bookkeeping so a REUSED scope starts clean.
  // Without this, a scope disposed after downshifting to the bus cadence keeps the
  // 250ms/20-attempt values, and pollWarned stays true — permanently suppressing
  // the "patch not enabled" warning on the next use. (scheduleDrain re-derives
  // pollInterval/pollLimit, but only when re-armed; reset them anyway for clarity.)
  scope.pollWarned = false;
  scope.pollBaseTicks = 0;
  scope.pollInterval = POLL_INTERVAL_MS;
  scope.pollLimit = POLL_LIMIT;
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
