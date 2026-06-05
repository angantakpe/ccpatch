/**
 * adk-types-usage.ts — type-level smoke fixture for packages/adk/index.d.ts.
 *
 * This file is never executed. It is compiled with `tsc --noEmit --strict` by
 * tests/adk-types.test.mjs to assert the hand-authored .d.ts type-checks the
 * public ADK surface (defineTool / defineHandoff / createAdk / createMemory /
 * capabilities + the introspection additions). If a signature in index.d.ts
 * drifts away from how callers use it, this fixture fails to compile and the
 * test goes red. It lives under tests/fixtures/** so knip/tsconfig ignore it for
 * normal linting; the drift test compiles it on its own.
 */

import {
  defineAgent,
  defineTool,
  defineHandoff,
  restoreSystemPrompt,
  listTools,
  swapDepth,
  currentPersona,
  createMemory,
  capabilities,
  useAgentBus,
  createAdk,
  AgentRouter,
  type Capabilities,
  type CapabilityDetail,
  type ToolHandle,
  type Memory,
  type Adk,
} from '@adk';

// ── Agents ────────────────────────────────────────────────────────────────────
const agent = defineAgent({ name: 'planner', systemPrompt: 'You plan.', tools: ['Read'] });
const agentName: string = agent.name;

// ── Tools ───────────────────────────────────────────────────────────────────--
const handle: ToolHandle = defineTool({
  name: 'echo',
  description: 'echoes',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  execute: (input: any) => `you said ${input.q}`,
  onInjectFail: (name: string) => { void name; },
  throwOnInjectFail: true,
});
const ready: Promise<boolean> = handle.ready;
const injected: Promise<boolean> = handle.injected;
const removed: boolean = handle.dispose();
void ready; void injected; void removed;

// execute may also return pre-built result blocks.
defineTool({
  name: 'blocks',
  description: 'returns blocks',
  inputSchema: { type: 'object' },
  execute: async () => [{ type: 'text', text: 'hi' }],
});

// ── Handoffs + introspection ────────────────────────────────────────────────--
const transfer: ToolHandle = defineHandoff({
  target: 'planner',
  mode: 'swap',
  allowSwapTargets: ['planner'],
});
void transfer;
const popped: boolean = restoreSystemPrompt();
const toolNames: string[] = listTools();
const depth: number = swapDepth();
const persona: string | null = currentPersona();
void popped; void toolNames; void depth; void persona; void agentName;

// ── Capabilities (booleans + detail/reason) ─────────────────────────────────--
const caps: Capabilities = capabilities();
if (caps.swap) {
  // boolean usage must keep working
}
const swapDetail: CapabilityDetail = caps.detail.swap;
const live: boolean = swapDetail.live;
const patch: string = swapDetail.patch;
const reason: string | undefined = swapDetail.reason;
void live; void patch; void reason;

// ── Bus ───────────────────────────────────────────────────────────────────────
const bus = useAgentBus();
bus.emit('topic', { a: 1 });

// ── Memory (deep snapshot + dispose) ───────────────────────────────────────────
const mem: Memory = createMemory({ path: '.claude/x.json' });
mem.set('k', { nested: [1, 2, 3] });
const snap: Record<string, any> = mem.snapshot();
const keys: string[] = mem.keys();
const flushed: Promise<void> = mem.flush();
mem.dispose();
void snap; void keys; void flushed;

// ── createAdk(): isolated instance mirrors the surface + introspection ─────────
const adk: Adk = createAdk();
adk.defineAgent({ name: 'a' });
const adkTools: string[] = adk.listTools();
const adkDepth: number = adk.swapDepth();
const adkPersona: string | null = adk.currentPersona();
const adkCaps: Capabilities = adk.capabilities();
const router = new adk.AgentRouter({ maxTransitions: 10 });
void adkTools; void adkDepth; void adkPersona; void adkCaps; void router;

// Top-level AgentRouter is also a value export.
const topRouter = new AgentRouter();
void topRouter;
