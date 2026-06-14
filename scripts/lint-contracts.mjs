#!/usr/bin/env node
/**
 * scripts/lint-contracts.mjs — cross-patch __ccp* global ↔ contract gate.
 *
 * Architecture-review finding #2 ("contracts under-adopted"): the typed contract
 * registry (__ccpProvide / __ccpRequire, core/contracts.mjs) exists to turn
 * "producer drifted / producer disabled" into a LOUD, actionable error at the
 * consumer boundary instead of a silent `undefined`. That only works if every
 * cross-patch global is actually REGISTERED as a contract. This lint enforces it.
 *
 * Rule
 * ────
 * A patch that writes a cross-patch `globalThis.__ccp*` global (or the minified
 * `__ccp* =` form inside an injected hook string) MUST also call __ccpProvide —
 * i.e. declare a typed contract for the surface it exposes — UNLESS every global
 * it writes is in the ALLOWLIST below (kernel internals and purely-private
 * globals that are legitimately NOT cross-patch contracts).
 *
 * The check is deliberately PER-PATCH, not per-global: the house idiom is one
 * __ccpProvide per exposing patch (see expose_tool_dispatch / expose_system_prompt
 * / event_bus / auth_token / agent_tree / coverage_kernel — each writes several
 * related globals and registers ONE contract whose value bundles them). A patch
 * that exposes a cross-patch surface but registers NOTHING is the real smell this
 * gate catches; a patch that registers at least one contract has declared its
 * boundary. Globals that are private to a single patch (idempotency sentinels,
 * boot buffers) live in the ALLOWLIST so they don't force a meaningless contract.
 *
 * Read-only by design. Exit 0 when the corpus satisfies the rule; exit 1 on any
 * violation. Modelled on scripts/lint-registry.mjs (reuse the loader, collect
 * findings purely, route to ERROR, print an actionable message).
 */

import { readFileSync } from 'node:fs';

import { loadPatches } from '../runner/loader.mjs';

// ── Allowlist ──────────────────────────────────────────────────────────────
// Globals that are legitimately NOT cross-patch contracts. A patch whose ONLY
// __ccp* writes are allowlisted is exempt from the "must call __ccpProvide" rule.
// Each entry MUST carry a reason. Keep this list small — if you find yourself
// adding a writable cross-patch surface here, register a __ccpProvide instead.
const ALLOWLIST = new Map([
  // ── Contract kernel internals (core/contracts.mjs) ──────────────────────
  // These ARE the registry; they cannot register themselves as contracts.
  ['__ccpRegistry', 'contracts kernel: backing Map for the registry itself'],
  ['__ccpProvide', 'contracts kernel: the provide() helper'],
  ['__ccpRequire', 'contracts kernel: the require() helper'],
  ['__ccpInspectContracts', 'contracts kernel: debug inspector over the registry'],
  ['__ccpAdkContract', 'contracts kernel: coarse top-level ADK handshake marker (advisory)'],

  // ── Per-patch idempotency / install sentinels (booleans, not surfaces) ───
  // A versioned sentinel a patch sets once to make re-injection a no-op. Reading
  // it tells a consumer nothing useful; it is not a value contract.
  ['__ccpFetchInterceptorInstalled__', 'fetch_interceptor: install-once sentinel'],
  ['__ccpFetchBusProvided_v1', 'fetch_interceptor: provide-once sentinel for the fetchBus contract'],
  ['__ccpBusWarnBudget', 'fetch_interceptor: private bounded-surfacing counter for swallowed bus errors'],
  ['__ccpSlashCommandsProvided_v1', 'custom_commands: provide-once sentinel for the slashCommands contract'],
  ['__ccpSubagentStubInstalled', 'subagent_hooks_stub: install-once sentinel'],
  ['__ccpPolicyGateInstalled_v1', 'policy_gate: install-once sentinel'],
  ['__ccpAgentLifecycle_v1', 'agent_lifecycle: install-once sentinel'],
  ['__ccpDotenvLoaded', 'dotenv_loader: load-once sentinel'],
  ['__ccpAssistantStream_v1', 'assistant_stream_events: install-once sentinel'],
  ['__ccpRateLimitRegistered', 'rate_limit: register-once sentinel'],
  ['__ccpHeadlessBridge_v1', 'headless_bridge: install-once sentinel'],
  ['__ccpBus_v1', 'event_bus: install-once sentinel (the contract is __ccpBus -> "bus")'],
  ['__ccpAuth_v1', 'auth_token: install-once sentinel (the contract is __ccpAuth -> "auth")'],
  ['__ccpAgentTree_v1', 'agent_tree: install-once sentinel (the contract is __ccpAgentTree -> "agentTree")'],
  ['__ccpSystemPromptExposed_v1', 'expose_system_prompt: install-once sentinel'],
  ['__ccpToolDispatchExposed_v2', 'expose_tool_dispatch: install-once sentinel'],

  // ── Purely-private globals (single-patch internal state / scratch) ───────
  ['__ccpBootBuf', 'tool_result_error_content: private boot-output buffer'],
  ['__ccpSystemPromptOverride', 'expose_system_prompt: private backing field for the overlay string'],
  ['__ccpApplySystemPromptOverride', 'expose_system_prompt: internal array-builder wrapper, injected at the assembly site (not called by consumers)'],
  ['__ccpActiveStreams', 'expose_api_client: private in-process stream counter'],
  ['__ccpFs', 'expose_agent_tool: private cached node:fs module handle'],
  ['__ccp_path', 'expose_agent_tool: private current agent path marker (scoping signal)'],
  ['__ccpFormattedTools', 'expose_tool_dispatch: private stash of the last formatted tools array'],
  ['__ccpRawTools', 'expose_tool_dispatch: private stash of raw tool objects'],
  ['__ccpToolUseCtx', 'expose_tool_dispatch: private stash of the last toolUseContext'],
]);

// Matches a write to a cross-patch global, in both source form
// (`globalThis.__ccpX = ` / `globalThis.__ccpX=`) and the rare destructured
// form is intentionally NOT matched (none exist in the corpus). The trailing
// negative lookahead on `=` excludes comparisons (`=== 'function'`, `== '...'`)
// so CONSUMERS that merely probe `typeof globalThis.__ccpOnFetch === 'function'`
// are not mistaken for producers.
const WRITE_RE = /globalThis\.(__ccp[A-Za-z0-9_]+)\s*=(?!=)/g;
const PROVIDE_RE = /__ccpProvide\s*\(/;

/**
 * Pure check core. Given a map of { name -> source }, return finding messages.
 * Exported for tests.
 *
 * @param {Record<string, string>} sources  patch name -> raw .mjs source text
 * @returns {string[]}
 */
export function collectFindings(sources) {
  const findings = [];
  for (const [name, src] of Object.entries(sources)) {
    const hasProvide = PROVIDE_RE.test(src);
    const written = new Set();
    let m;
    WRITE_RE.lastIndex = 0;
    while ((m = WRITE_RE.exec(src)) !== null) written.add(m[1]);
    if (written.size === 0) continue;

    // A patch that registers ANY contract has declared its cross-patch boundary.
    if (hasProvide) continue;

    // Otherwise every global it writes must be allowlisted.
    const unprovided = [...written].filter((g) => !ALLOWLIST.has(g));
    if (unprovided.length === 0) continue;

    for (const g of unprovided.sort()) {
      findings.push(
        `patch '${name}' writes cross-patch global 'globalThis.${g}' but never calls __ccpProvide. ` +
        `Register a contract for it (mirror expose_tool_dispatch / expose_system_prompt: ` +
        `__ccpProvide('<name>', { version, producer: '${name}', shape: [...], value: ... })) ` +
        `so a disabled producer yields a loud __ccpRequire error instead of a silent undefined — ` +
        `OR, if '${g}' is a private/sentinel global, add it to the ALLOWLIST in scripts/lint-contracts.mjs with a reason.`
      );
    }
  }
  return findings;
}

/** Load the canonical patch set and read each patch's raw source. */
async function loadSources() {
  // includeModules:false — third-party module patches are namespaced and not
  // part of this repo's contract corpus (matches lint-registry.mjs).
  const patches = await loadPatches({ includeModules: false });
  const sources = {};
  for (const [name, mod] of Object.entries(patches)) {
    const fp = mod && mod.__filePath;
    if (!fp) continue;
    try {
      sources[name] = readFileSync(fp, 'utf8');
    } catch (err) {
      throw new Error(`could not read patch source for '${name}' (${fp}): ${err.message}`);
    }
  }
  return sources;
}

/** Run the lint against the real repo. Returns the process exit code. */
export async function runLint() {
  let sources;
  try {
    sources = await loadSources();
  } catch (err) {
    console.error(`ERROR: patch corpus failed to load: ${err.message}`);
    return 1;
  }

  const errors = collectFindings(sources);
  for (const e of errors) console.error(`ERROR: ${e}`);

  if (errors.length > 0) {
    console.error(`\nlint-contracts: ${errors.length} un-provided cross-patch global(s).`);
    return 1;
  }
  console.log(
    `OK: every cross-patch __ccp* global is contracted or allowlisted ` +
    `(${Object.keys(sources).length} patches scanned, ${ALLOWLIST.size} allowlisted globals).`
  );
  return 0;
}

// Run as a gate only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await runLint());
}
