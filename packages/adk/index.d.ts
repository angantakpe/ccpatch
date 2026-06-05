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
}

/**
 * The object returned by defineTool / defineHandoff: the original def plus
 * lifecycle handles.
 */
export interface ToolHandle extends ToolDef {
  /** Resolves true once injected live in __ccpRawTools; false on poll timeout. */
  ready: Promise<boolean>;
  /** Unregister: remove from __ccpRawTools / cancel a pending queue entry. Returns true if a live tool was removed. */
  dispose: () => boolean;
}

/**
 * Define + inject a tool into the DEFAULT instance. The returned handle carries
 * `.ready` (Promise<boolean>) and `.dispose()`.
 */
export function defineTool(spec: ToolDef): ToolHandle;

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
}

/** Register a tool-call-driven handoff to `target` in the DEFAULT instance. */
export function defineHandoff(opts: HandoffOptions): ToolHandle;

/** Restore the previous system prompt in the DEFAULT instance (pop swap stack). */
export function restoreSystemPrompt(): boolean;

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
  /** Shallow copy of the whole store (from cache). */
  snapshot(): Record<string, any>;
  /** Drop every key (cache + debounced async persist). */
  clear(): void;
  /** Force-persist any pending write, awaitable. */
  flush(): Promise<void>;
}

/** Options for createMemory. */
export interface CreateMemoryOptions {
  /** Store path; must resolve within the project root (default .claude/adk-memory.json). */
  path?: string;
}

/** Create a JSON-file key/value store with an in-memory write-through cache. */
export function createMemory(opts?: CreateMemoryOptions): Memory;

// ── Capabilities & bus ────────────────────────────────────────────────────────

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
}

/** Probe the __ccp* globals and report which ADK capabilities are live. */
export function capabilities(): Capabilities;

/** The ccpatch event bus surface returned by useAgentBus. */
export interface AgentBus {
  emit: (topic: string, payload?: any) => void;
  on?: (topic: string, handler: (...args: any[]) => void) => void;
  off?: (topic: string, handler: (...args: any[]) => void) => void;
}

/** Return the live __ccpBus or throw if the event bus patch is off. */
export function useAgentBus(): AgentBus;

// ── createAdk: isolated instance ──────────────────────────────────────────────

/**
 * An isolated ADK instance. Mirrors the top-level exports exactly, but all
 * agent/tool/handoff state is scoped to this object; two instances never share
 * registries.
 */
export interface Adk {
  defineAgent(spec: AgentDef): AgentDef;
  getAgent(name: string): AgentDef | null;
  listAgents(): AgentDef[];
  defineTool(spec: ToolDef): ToolHandle;
  defineHandoff(opts: HandoffOptions): ToolHandle;
  /** Pop this instance's swap stack. */
  restoreSystemPrompt(): boolean;
  /** Router pre-bound to this instance's agents. */
  AgentRouter: new (opts?: AgentRouterOptions) => AgentRouter;
  createMemory(opts?: CreateMemoryOptions): Memory;
  capabilities(): Capabilities;
  useAgentBus(): AgentBus;
}

/** Create an isolated ADK instance with its own agent/tool/handoff registries. */
export function createAdk(): Adk;
