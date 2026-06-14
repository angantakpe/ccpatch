/**
 * index.d.ts — ambient TypeScript declarations for the ccpatch ADK.
 *
 * Hand-authored to mirror the JSDoc-typed .mjs source (index.mjs, agent.mjs,
 * tool-registry.mjs, handoff.mjs, memory.mjs). Covers BOTH consumption modes:
 *   - the top-level named exports bound to the process-global DEFAULT instance;
 *   - createAdk(), which returns the same surface backed by an isolated scope.
 *
 * NOTE: the ADK leans on ccpatch-exposed __ccp* globals at runtime; those are an
 * internal contract and intentionally NOT declared here (the public surface is
 * the exports below).
 */

// ── Agents ────────────────────────────────────────────────────────────────────

/**
 * A registered agent definition. `name` is the registry key; `systemPrompt` is
 * the persona a swap handoff / router can flip the live session to.
 */
export interface AgentDef {
  /** Unique agent id (registry key). */
  name: string;
  /** Human / `whenToUse` description. */
  description?: string;
  /** Persona prompt (used by swap handoffs & router). */
  systemPrompt?: string;
  /** Allowed tool names (defaults to ['*'] downstream). */
  tools?: string[];
  /**
   * If true, the persona is immutable: a later `defineAgent` for the same `name`
   * with a different `systemPrompt` THROWS instead of silently re-pointing it.
   */
  frozen?: boolean;
  /** Optional predicate `(ctx) => nextName|null` for AgentRouter. */
  handoff?: ((context: RouterContext) => string | null | Promise<string | null>) | null;
  /** Optional model override. */
  model?: string;
}

/** Register an agent in the DEFAULT (process-global) ADK instance. */
export function defineAgent(spec: AgentDef): AgentDef;

/** Look up an agent in the DEFAULT instance; null when unknown. */
export function getAgent(name: string): AgentDef | null;

/** List agents registered in the DEFAULT instance. */
export function listAgents(): AgentDef[];

// ── Tools ─────────────────────────────────────────────────────────────────────

/**
 * A tool result block (Claude Code tool_result content). `execute` may return a
 * bare string (wrapped into a single text block) or an array of blocks.
 */
export interface ToolResultBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}

/** The output of a tool's `execute`: a string or pre-built result blocks. */
export type ToolResult = string | ToolResultBlock[];

/** A tool definition passed to defineTool. */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON-schema subset (type 'object' with required/properties). */
  inputSchema: object;
  /** Returns string | tool_result blocks (sync or async). */
  execute: (input: any) => ToolResult | Promise<ToolResult>;
  /**
   * Optional callback fired once when the bounded poll times out and the tool was
   * never injected (the same moment `.ready` resolves false). Lets authors surface
   * the silent-failure case.
   */
  onInjectFail?: (name: string) => void;
  /**
   * When true, a timed-out injection also REJECTS the handle's separate
   * `.injected` promise (default: it resolves false, mirroring `.ready`).
   */
  throwOnInjectFail?: boolean;
}

/**
 * The object returned by defineTool / defineHandoff: the original def plus
 * lifecycle handles.
 */
export interface ToolHandle extends ToolDef {
  /** Resolves true once injected live in __ccpRawTools; false on poll timeout (never rejects). */
  ready: Promise<boolean>;
  /**
   * Like `ready`, but REJECTS on poll timeout when `throwOnInjectFail` is set
   * (otherwise resolves false). An opt-in hard signal for never-injected tools.
   */
  injected: Promise<boolean>;
  /** Unregister: remove from __ccpRawTools / cancel a pending queue entry. Returns true if a live tool was removed. */
  dispose: () => boolean;
}

/**
 * Define + inject a tool into the DEFAULT instance. The returned handle carries
 * `.ready` (Promise<boolean>), `.injected` (Promise<boolean>) and `.dispose()`.
 */
export function defineTool(spec: ToolDef): ToolHandle;

/** Names of tools currently live/queued in the DEFAULT instance. */
export function listTools(): string[];

/** Lifecycle status of a tool: queued (awaiting inject), live, or failed (poll timeout). */
export type ToolStatus = 'queued' | 'live' | 'failed';

/** A tool plus its current lifecycle status, as reported by toolStatuses(). */
export interface ToolStatusEntry {
  name: string;
  status: ToolStatus;
}

/**
 * Full lifecycle view of the DEFAULT instance: every tool it knows about with its
 * current status — 'queued' / 'live' / 'failed'. Completes the "why didn't my tool
 * inject?" story alongside listTools().
 */
export function toolStatuses(): ToolStatusEntry[];

// ── Handoffs ──────────────────────────────────────────────────────────────────

/** Handoff mode: spawn an isolated subagent ('delegate') or swap persona in place ('swap'). */
export type HandoffMode = 'delegate' | 'swap';

/** Options for defineHandoff. */
export interface HandoffOptions {
  /** Agent to hand off to (required). */
  target: string;
  /** Default 'delegate'. */
  mode?: HandoffMode;
  /** Tool description shown to the model. */
  description?: string;
  /** Override the injected tool name (default transfer_to_<target>). */
  toolName?: string;
  /** Override the tool input schema. */
  inputSchema?: object;
  /** Property carrying the prompt to hand over (default 'task'). */
  promptKey?: string;
  /** Allowlist; a swap only proceeds if target ∈ it (programmer error otherwise). */
  allowSwapTargets?: string[];
  /**
   * Swap-mode TOCTOU escape hatch (default false). By default defineHandoff
   * THROWS when a `swap` target is not registered at definition time (no persona
   * to pin). Set true to opt into legacy pin-on-first-resolve, accepting the
   * define→first-execute window.
   */
  allowDeferredPin?: boolean;
}

/** Register a tool-call-driven handoff to `target` in the DEFAULT instance. */
export function defineHandoff(opts: HandoffOptions): ToolHandle;

/**
 * Restore the previous system prompt in the DEFAULT instance (pop the single
 * process-global swap stack, LIFO-owned by the default scope). Returns false on an
 * out-of-order cross-instance restore without clobbering the live persona.
 */
export function restoreSystemPrompt(): boolean;

/**
 * Swap-stack depth owned by the DEFAULT instance — entries this instance pushed
 * onto the single process-global swap stack. 0 when nothing is swapped in.
 */
export function swapDepth(): number;

/** The live persona overlay currently applied (single global slot), or null. */
export function currentPersona(): string | null;

/**
 * The exclusive swap-lock token returned by tryAcquireSwap(). Drives an in-place
 * persona swap: `swap` pushes a persona, `restore` LIFO-pops one entry, `release`
 * unwinds every entry this lock owns and frees the lock. `owned` is false once
 * released (or if a different scope owns the lock).
 */
export interface SwapToken {
  /** Push `persona` as the live system prompt (records the prior prompt for restore). */
  swap(persona: string): void;
  /** Pop one entry this scope owns; false when there is nothing to restore. */
  restore(): boolean;
  /** Unwind every entry this scope still owns and release the exclusive lock. */
  release(): void;
  /** True while this token still holds the exclusive swap lock. */
  readonly owned: boolean;
}

/**
 * Acquire the exclusive swap lock for the DEFAULT instance. Returns a SwapToken,
 * or null when a DIFFERENT scope already holds the lock.
 */
export function tryAcquireSwap(): SwapToken | null;

// ── AgentRouter ───────────────────────────────────────────────────────────────

/** Context passed to an agent's `handoff` predicate. */
export interface RouterContext {
  /** The currently active agent name. */
  active: string | null;
  /** Names of all agents registered on the router. */
  agents: string[];
}

/** Options for the AgentRouter constructor. */
export interface AgentRouterOptions {
  /** Cap on chained transitions before a `limit` event fires (default 50). */
  maxTransitions?: number;
  /** Agent lookup used when an agent isn't registered directly (defaults to DEFAULT instance). */
  getAgent?: (name: string) => AgentDef | null;
}

/** Emitted on each persona transition. */
export interface RouterTransitionEvent {
  from: string | null;
  to: string;
}

/** Emitted (only when observed) on a predicate / install failure. */
export interface RouterErrorEvent {
  phase: 'install' | 'handoff';
  error: unknown;
}

/** Emitted when maxTransitions is reached. */
export interface RouterLimitEvent {
  transitions: number;
}

import { EventEmitter } from 'node:events';

/**
 * Predicate-driven (code-decided) handoff orchestrator. Register agents, call
 * start(name); after each install the agent's `handoff` predicate picks the next.
 *
 * Events: `transition` {from,to} · `error` {phase,error} · `limit` {transitions}.
 */
export class AgentRouter extends EventEmitter {
  constructor(opts?: AgentRouterOptions);
  /** The currently active agent name (read-only). */
  get active(): string | null;
  /** Register an agent definition; chainable. */
  register(agentDef: AgentDef): this;
  /** Halt the chain; in-flight predicate results are ignored. */
  stop(): void;
  /** Install `agentName` as the active persona and schedule its predicate. */
  start(agentName: string): Promise<void>;

  on(event: 'transition', listener: (e: RouterTransitionEvent) => void): this;
  on(event: 'error', listener: (e: RouterErrorEvent) => void): this;
  on(event: 'limit', listener: (e: RouterLimitEvent) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}

// ── Memory ────────────────────────────────────────────────────────────────────

/** A JSON-file key/value store with an in-memory write-through cache. */
export interface Memory {
  /** Read a value (from cache). */
  get(key: string): any;
  /** Write a value (cache + debounced async persist). */
  set(key: string, value: any): void;
  /** Remove a value (cache + debounced async persist). */
  delete(key: string): void;
  /** List keys (from cache). */
  keys(): string[];
  /** DEEP copy of the whole store (from cache); nested mutations cannot leak back into the live store. */
  snapshot(): Record<string, any>;
  /** Drop every key (cache + debounced async persist). */
  clear(): void;
  /** Force-persist any pending write, awaitable. */
  flush(): Promise<void>;
  /**
   * Detach from the module exit registry and cancel any pending debounce timer.
   * Idempotent. Pending dirty data is NOT auto-flushed — call flush() first if you
   * need it persisted. After dispose() the instance still works but won't
   * auto-persist on process exit.
   */
  dispose(): void;
}

/** Reversible on-disk transform (e.g. encrypt/encode). onRead MUST invert onWrite. */
export interface MemoryTransform {
  /** Map the serialized JSON string to the bytes written to disk. Default identity. */
  onWrite?: (jsonString: string) => string;
  /** Map raw on-disk bytes back to a JSON string before parse. Default identity. */
  onRead?: (raw: string) => string;
}

/** Options for createMemory. */
export interface CreateMemoryOptions {
  /** Store path; must resolve within the project root (default .claude/adk-memory.json). */
  path?: string;
  /** Reversible on-disk transform (encrypt/encode/redact). Caller-supplied; no crypto bundled. */
  transform?: MemoryTransform;
  /**
   * On-disk size cap (default 5 MB). In default mode bounds the whole-file
   * rewrite + the read that is otherwise ignored; in appendLog mode it is the
   * delta-log compaction threshold.
   */
  maxBytes?: number;
  /**
   * Persist mutations as O(delta) NDJSON records to a sibling `<path>.log`,
   * replayed on load and compacted past maxBytes. For stores that outgrow the
   * default full-rewrite cost. Does NOT do the default mode's cross-process key
   * merge (single owning process intended).
   */
  appendLog?: boolean;
}

/** Create a JSON-file key/value store with an in-memory write-through cache. */
export function createMemory(opts?: CreateMemoryOptions): Memory;

// ── Capabilities & bus ────────────────────────────────────────────────────────

/** Per-capability remediation detail returned in Capabilities.detail. */
export interface CapabilityDetail {
  /** Mirrors the top-level boolean for this capability. */
  live: boolean;
  /** The patch name that provides this capability. */
  patch: string;
  /**
   * The typed __ccp* contract this capability is pinned to (a key of
   * ADK_CONTRACT_REQUIREMENTS in contracts.mjs), when one exists.
   */
  contract?: string;
  /**
   * Set only when the version/shape contract handshake DOWNGRADED `live` to false
   * (e.g. "contract systemPrompt v1 < required v2" or "... shape missing getNonce ...").
   * Names WHICH contract failed and the producer-vs-required version mismatch.
   */
  reason?: string;
}

/** Per-capability detail map (one CapabilityDetail per capability). */
export interface CapabilityDetailMap {
  tools: CapabilityDetail;
  delegate: CapabilityDetail;
  swap: CapabilityDetail;
  router: CapabilityDetail;
  bus: CapabilityDetail;
}

/** Which ADK primitives are live, per the __ccp* global probe. */
export interface Capabilities {
  /** __ccpRawTools is a live array (expose_tool_dispatch). */
  tools: boolean;
  /** __ccpAgentTool.invoke is callable (expose_agent_tool). */
  delegate: boolean;
  /** __ccpSetSystemPrompt is callable (expose_system_prompt). */
  swap: boolean;
  /** __ccpSubmitInput is callable (drives AgentRouter). */
  router: boolean;
  /** __ccpBus is present (event_bus / fetch_interceptor). */
  bus: boolean;
  /**
   * Per-capability remediation detail: `{ live, patch, reason? }`. `live` mirrors
   * the boolean; `patch` names the providing patch; `reason` is present only when
   * the contract version/shape handshake downgraded the capability to false.
   */
  detail: CapabilityDetailMap;
}

/**
 * Probe the __ccp* globals and report which ADK capabilities are live. Booleans
 * stay stable for `if (caps.swap)`; `caps.detail` adds remediation info and a
 * version/shape contract handshake that downgrades a drifted host loudly.
 */
export function capabilities(): Capabilities;

/** The ccpatch event bus surface returned by useAgentBus. */
export interface AgentBus {
  emit: (topic: string, payload?: any) => void;
  on?: (topic: string, handler: (...args: any[]) => void) => void;
  off?: (topic: string, handler: (...args: any[]) => void) => void;
}

/** Return the live __ccpBus or throw if the event bus patch is off. */
export function useAgentBus(): AgentBus;

// ── Contract pins (contracts.mjs) ─────────────────────────────────────────────

/** One pinned __ccp* contract dependency (see packages/adk/contracts.mjs). */
export interface ContractRequirement {
  /** The capabilities() boolean this contract gates. */
  capability: 'tools' | 'delegate' | 'swap' | 'router' | 'bus';
  /** Consumer id passed to __ccpRequire (error attribution). */
  consumer: string;
  /** Minimum producer contract version the ADK supports. */
  minVersion: number;
  /** Dotted value paths the producer MUST satisfy. */
  shape: readonly string[];
  /** The ccpatch patch expected to produce this contract. */
  producerPatch: string;
}

/** Result of validating one ADK contract dependency against the live registry. */
export interface ContractCheckResult {
  /** 'unchecked' = nothing to prove (fail-open); 'ok' = validated; 'drift' = refuse. */
  status: 'unchecked' | 'ok' | 'drift';
  /** How an 'ok' was proven ('require' probed actual value paths). */
  via?: 'require' | 'advertised';
  /** For 'drift': names the contract, producer version, and required minimum. */
  reason?: string;
  /** The registry entry that was checked, when one was found. */
  entry?: { name: string; version: number; producer: string; shape: string[] };
  /** The contract value, when validated via __ccpRequire. */
  value?: unknown;
}

/**
 * The ADK's centralized pin table: every __ccp* typed contract it consumes and
 * the minimum version/shape it requires of each producer.
 */
export const ADK_CONTRACT_REQUIREMENTS: Readonly<Record<string, Readonly<ContractRequirement>>>;

/**
 * Validate one ADK contract dependency against the live registry. Never throws;
 * fail-open ('unchecked') when no registry / no registered entry exists.
 */
export function checkContract(name: string): ContractCheckResult;

// ── createAdk: isolated instance ──────────────────────────────────────────────

/**
 * An ADK instance. agent/tool/handoff state is INSTANCE-LOCAL (two instances
 * never share those registries); `capabilities`, `useAgentBus`, and
 * `createMemory` front PROCESS-GLOBAL resources and are intentionally shared.
 * See the ISOLATION CONTRACT in index.mjs for the per-method breakdown.
 */
export interface Adk {
  /** Stable per-instance id (introspection / debug only). */
  id: string;
  defineAgent(spec: AgentDef): AgentDef;
  getAgent(name: string): AgentDef | null;
  listAgents(): AgentDef[];
  defineTool(spec: ToolDef): ToolHandle;
  defineHandoff(opts: HandoffOptions): ToolHandle;
  /** Pop this instance's swap stack (LIFO ownership on the single global stack). */
  restoreSystemPrompt(): boolean;
  /** Names of tools currently live/queued in this instance's tool scope. */
  listTools(): string[];
  /** Full lifecycle view of this instance's tools (queued/live/failed). */
  toolStatuses(): ToolStatusEntry[];
  /** Swap-stack entries owned by this instance (its current swap depth). */
  swapDepth(): number;
  /** The live persona overlay currently applied (single global slot), or null. */
  currentPersona(): string | null;
  /**
   * Acquire this instance's exclusive swap lock; null when a different scope
   * already holds it.
   */
  tryAcquireSwap(): SwapToken | null;
  /** Router pre-bound to this instance's agents. */
  AgentRouter: new (opts?: AgentRouterOptions) => AgentRouter;
  createMemory(opts?: CreateMemoryOptions): Memory;
  capabilities(): Capabilities;
  useAgentBus(): AgentBus;
  /**
   * Tear down this instance's tool/swap/agent scopes: removes live tools, cancels
   * pending injections, unwinds its swap footprint (and frees the swap lock if
   * held), and clears its agent registry. Idempotent — safe to call twice.
   */
  dispose(): void;
}

/** Create an isolated ADK instance with its own agent/tool/handoff registries. */
export function createAdk(): Adk;
