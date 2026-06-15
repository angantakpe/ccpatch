/**
 * host.mjs — the ADK's single port onto the ccpatch-exposed host primitives.
 *
 * WHY: before this module, every ADK file reached into `globalThis.__ccp*`
 * directly (~40 sites across index/contracts/agent/memory/handoff/tool-registry),
 * each re-implementing its own `typeof x !== 'function'` / `Array.isArray` /
 * `?.()` guards. That scattered the coupling to the host bundle and meant a
 * change to how a primitive is probed had to be chased through five files.
 *
 * This module is the ONE place that knows the global names. Everything else
 * depends on `host`, not on `globalThis`.
 *
 * CONTRACT (load-bearing — do not break):
 *   - Every accessor reads `globalThis` LIVE on each call. It never snapshots a
 *     global at import time. This is what keeps two things working:
 *       (a) test stubs that assign `globalThis.__ccpRawTools = []` AFTER import,
 *       (b) late-binding hosts where a patch populates a global after the ADK
 *           module graph has already loaded.
 *   - Accessors are pure probes: side-effect-free, never throw. A missing global
 *     yields `null`/`undefined`/`false`, never an exception. (The guarded
 *     `emit()` helper is the one that swallows a throwing observer.)
 *   - This file imports NOTHING from the rest of the ADK, so any module
 *     (including the standalone `memory.mjs` subpath export) can depend on it
 *     without a cycle.
 *
 * The typed-contract handshake (versions/shapes) is NOT done here — that lives in
 * contracts.mjs, which consumes `host.inspectContracts()` / `host.requireFn()`.
 * This port only answers "is the primitive present and callable right now".
 */

// ── tools (expose_tool_dispatch) ──────────────────────────────────────────────

/** @returns {boolean} true when __ccpRawTools is a live array. */
export function hasRawTools() {
  return Array.isArray(globalThis.__ccpRawTools);
}

/** @returns {any[]|undefined} the live tool array (undefined when absent). */
export function rawTools() {
  return globalThis.__ccpRawTools;
}

/** @returns {boolean} true when the nonce-gated registrar is callable. */
export function hasRegisterTool() {
  return typeof globalThis.__ccpRegisterTool === 'function';
}

/** Call the gated registrar. Caller must check hasRegisterTool() first. */
export function callRegisterTool(nonce, toolObj) {
  return globalThis.__ccpRegisterTool(nonce, toolObj);
}

/** @returns {boolean} true when the nonce-gated unregistrar is callable. */
export function hasUnregisterTool() {
  return typeof globalThis.__ccpUnregisterTool === 'function';
}

/** Call the gated unregistrar. Caller must check hasUnregisterTool() first. */
export function callUnregisterTool(nonce, name) {
  return globalThis.__ccpUnregisterTool(nonce, name);
}

/** @returns {*} a fresh dispatch nonce, or undefined when the supplier is absent. */
export function getDispatchNonce() {
  return globalThis.__ccpGetDispatchNonce?.();
}

// ── system prompt / persona (expose_system_prompt) ────────────────────────────

/** @returns {boolean} true when the nonce-gated persona setter is callable. */
export function hasSetSystemPrompt() {
  return typeof globalThis.__ccpSetSystemPrompt === 'function';
}

/** @returns {Function|undefined} the raw persona setter (nonce-gated or legacy). */
export function setSystemPromptFn() {
  return globalThis.__ccpSetSystemPrompt;
}

/** @returns {Function|undefined} the persona-nonce supplier, if present. */
export function getSystemPromptNonceFn() {
  return globalThis.__ccpGetSystemPromptNonce;
}

/** @returns {Function|undefined} the raw live-prompt getter (callers may probe typeof). */
export function systemPromptGetterRaw() {
  return globalThis.__ccpGetSystemPrompt;
}

/** Read the live persona via the host getter. @returns {string|null} */
export function getSystemPrompt() {
  return globalThis.__ccpGetSystemPrompt?.() ?? null;
}

/** @returns {string|null} the fallback override slot used by expose_system_prompt. */
export function systemPromptOverride() {
  return globalThis.__ccpSystemPromptOverride ?? null;
}

// ── delegate / subagent (expose_agent_tool) ───────────────────────────────────

/** @returns {{invoke?:Function}|undefined} the agent-tool surface. */
export function agentTool() {
  return globalThis.__ccpAgentTool;
}

/** @returns {boolean} true when __ccpAgentTool.invoke is callable. */
export function hasDelegate() {
  return typeof globalThis.__ccpAgentTool?.invoke === 'function';
}

// ── router / input injection (expose_submit_input) ────────────────────────────

/** @returns {Function|undefined} the submit-input adapter. */
export function submitInput() {
  return globalThis.__ccpSubmitInput;
}

/** @returns {boolean} true when __ccpSubmitInput is callable. */
export function hasSubmitInput() {
  return typeof globalThis.__ccpSubmitInput === 'function';
}

// ── event bus (event_bus / fetch_interceptor) ─────────────────────────────────

/** @returns {{on?:Function,off?:Function,emit?:Function}|undefined} the live bus. */
export function bus() {
  return globalThis.__ccpBus;
}

/** @returns {boolean} true when a bus object is present. */
export function hasBus() {
  return !!globalThis.__ccpBus;
}

/**
 * Fully-guarded emit: never throws, no-op when the bus is absent or an observer
 * crashes. Use this for fire-and-forget telemetry where the caller doesn't want
 * its own try/catch.
 * @param {string} topic
 * @param {*} payload
 */
export function emit(topic, payload) {
  try {
    globalThis.__ccpBus?.emit(topic, payload);
  } catch (_) {
    /* an observer crash must never break ADK logic */
  }
}

// ── unified observability seam ────────────────────────────────────────────────
// Before this seam every ADK catch block picked its OWN failure channel: some
// emitted a bus event, some did a bare console.warn, some a DEBUG-gated
// console.warn, some just returned false. The SAME class of failure therefore
// surfaced (or didn't) depending purely on which catch you landed in, and a
// silent fallback was an accident of omission rather than a decision.
//
// report() is the one channel. It ALWAYS emits `event` to the bus (so every
// failure is observable by an attached observer regardless of log level) and
// then OPTIONALLY logs a single `[adk] event: …detail` line to the console per
// `level`:
//
//   'error' | 'warn'  → always console.warn (operator-visible failures)
//   'debug'           → console.warn only when host.debug() is on (authoring
//                       noise: definition-time hints, transient races)
//   'silent'          → never logs; the bus emit is the ONLY surface
//
// "silent" is a DELIBERATE level — a catch that wants the event on the bus but
// no console line states that intent explicitly, instead of being a console.warn
// someone forgot to add. Both the emit and the (best-effort) log are fully
// guarded: report() never throws, so fail-open catch sites stay fail-open.
//
/** @typedef {'error'|'warn'|'debug'|'silent'} ReportLevel */

/** @type {Set<string>} levels that always log to the console. */
const LOUD_LEVELS = new Set(['error', 'warn']);

/**
 * Unified failure-reporting seam: emit `event` to the bus (always) and log a
 * single line to the console per `level`. Never throws.
 * @param {ReportLevel} level  'error'|'warn' always log; 'debug' logs only under
 *   host.debug(); 'silent' never logs (bus-only — a deliberate choice).
 * @param {string} event  bus topic, also the log tag (e.g. 'memory.corrupt').
 * @param {*} [detail]  structured payload emitted on the bus; when it carries a
 *   human-readable `message`/`reason` string (or is itself a string) that text
 *   is appended to the log line.
 */
export function report(level, event, detail) {
  // 1. ALWAYS surface on the bus — the one channel every level shares.
  emit(event, detail);
  // 2. Log per level. Best-effort; a console failure must never break a catch.
  try {
    const loud = LOUD_LEVELS.has(level);
    const debugLine = level === 'debug' && debug();
    if (!loud && !debugLine) return; // 'silent', or 'debug' with debug off.
    let line = `[adk] ${event}`;
    const msg =
      typeof detail === 'string'
        ? detail
        : detail && typeof detail === 'object'
          ? detail.message ?? detail.reason
          : undefined;
    if (typeof msg === 'string' && msg.length) line += `: ${msg}`;
    console.warn(line);
  } catch (_) {
    /* logging must never break ADK logic */
  }
}

// ── typed contract registry (core/contracts.mjs) ──────────────────────────────

/** @returns {Function|undefined} __ccpInspectContracts, if the host registered it. */
export function inspectContracts() {
  return globalThis.__ccpInspectContracts;
}

/** @returns {Function|undefined} __ccpRequire (version/shape-checked accessor). */
export function requireFn() {
  return globalThis.__ccpRequire;
}

// ── misc ──────────────────────────────────────────────────────────────────────

/** @returns {string|undefined} the breadcrumb path used to tag handoff ids. */
export function path() {
  return globalThis.__ccp_path;
}

/**
 * @returns {boolean} whether the debug switch is on (CLAUDE_DEBUG env OR the
 * __ccpDebug global). Centralizes the two-source check every module duplicated.
 */
export function debug() {
  return !!(process.env.CLAUDE_DEBUG || globalThis.__ccpDebug);
}

/**
 * Namespaced default object form, for call sites that prefer `host.rawTools()`
 * over named imports. Same live-read semantics — this is just a bag of the
 * functions above.
 */
export const host = Object.freeze({
  hasRawTools, rawTools, hasRegisterTool, callRegisterTool,
  hasUnregisterTool, callUnregisterTool, getDispatchNonce,
  hasSetSystemPrompt, setSystemPromptFn, getSystemPromptNonceFn,
  systemPromptGetterRaw, getSystemPrompt, systemPromptOverride,
  agentTool, hasDelegate, submitInput, hasSubmitInput,
  bus, hasBus, emit, report, inspectContracts, requireFn, path, debug,
});
