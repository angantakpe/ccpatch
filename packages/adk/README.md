# ccpatch ADK — Agent Development Kit

The ADK is a small, dependency-free (ESM, Node 20+, no build step) toolkit for
**defining, registering, and orchestrating agents inside a live Claude Code
session**. It does not talk to the model API directly — instead it sits on top of
the internals that ccpatch exposes onto `globalThis`
(`__ccpRawTools`, `__ccpInvokeTool`, `__ccpAgentTool`, `__ccpSetSystemPrompt`,
`__ccpSubmitInput`, `__ccp_path`, `__ccpBus`). You define an agent's persona, push
tools into the live tool array, and wire up tool-call-driven handoffs; the ADK
mutates the running CC session in place. Because each exposed primitive comes from
a separate patch, the live surface is variable — always call `capabilities()` to
preflight which primitives are actually wired before you depend on them.

> Import paths below use the in-repo relative form (`../packages/adk/index.mjs`),
> matching the existing tests. Published, the package is `@codehornets/adk`
> (`main: index.mjs`, subpaths `./memory`, `./tool-registry`).

## Quickstart

A runnable end-to-end wiring: define an agent, inject a tool, register a handoff,
and preflight capabilities before relying on any of it.

```js
import {
  defineAgent, defineTool, defineHandoff, capabilities,
} from '../packages/adk/index.mjs';

// Preflight: which __ccp* primitives are actually live this session?
const caps = capabilities();
// → { tools, delegate, swap, router, bus } — each a boolean.

// 1. Register an agent persona (its systemPrompt is a swap target — see SECURITY).
defineAgent({
  name: 'researcher',
  description: 'Investigates open questions and reports findings.',
  systemPrompt: 'You are a meticulous research agent. Cite sources.',
  tools: ['*'],
});

// 2. Inject a tool into the live __ccpRawTools array.
const echo = defineTool({
  name: 'echo',
  description: 'Echo the message back.',
  inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  execute: async ({ msg }) => `echo: ${msg}`,
});
if (caps.tools) await echo.ready;     // resolves true once live, false on ~5s timeout
// echo.dispose();                    // unregister later: removes it from __ccpRawTools

// 3. Register a tool-call-driven handoff. delegate spawns an isolated subagent;
//    swap overlays the target persona in place (reversible — see SECURITY).
if (caps.delegate) {
  defineHandoff({ target: 'researcher', mode: 'delegate' });
}
```

`defineTool` returns a `ToolHandle`: the def plus `.ready` (a `Promise<boolean>`)
and `.dispose()` (removes the tool from the live array / cancels its pending queue
entry). `defineHandoff` returns the injected `transfer_to_<target>` tool handle.

## Memory

`createMemory()` is a JSON-file key/value store with an in-memory write-through
cache. Reads come from cache; writes are debounced (~100ms) to disk. Call
`flush()` to force a pending write to land now (awaitable) — do this before you
need a durable on-disk read or before a controlled shutdown.

```js
import { createMemory } from '../packages/adk/index.mjs';

const mem = createMemory({ path: '.claude/adk-memory.json' }); // path is sandboxed
mem.set('lastTopic', 'token budgets');
mem.get('lastTopic');     // 'token budgets' (from cache)
mem.keys();               // ['lastTopic']
mem.snapshot();           // { lastTopic: 'token budgets' } (shallow copy)

await mem.flush();        // force the debounced write to disk now
mem.delete('lastTopic');  // cache + debounced persist
mem.clear();              // drop every key + debounced persist
```

A best-effort flush also runs on process `exit`, so a pending debounced write is
not lost on a clean shutdown. The on-disk file is size-bounded (5 MB) — a larger
file is ignored rather than parsed.

## Isolated instances — `createAdk()`

The top-level exports (`defineAgent`, `defineTool`, `defineHandoff`,
`AgentRouter`, `restoreSystemPrompt`, …) bind to a single process-global DEFAULT
instance. `createAdk()` returns the **same API** backed by an isolated scope: two
instances never share agent / tool / handoff registries. Use it for per-test or
per-session isolation.

```js
import { createAdk } from '../packages/adk/index.mjs';

const adk = createAdk();
adk.defineAgent({ name: 'planner', systemPrompt: 'You plan tasks.' });
adk.defineTool({
  name: 'noop',
  description: 'Does nothing.',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => 'ok',
});
adk.defineHandoff({ target: 'planner', mode: 'delegate' });

adk.capabilities();        // same preflight, instance-agnostic
adk.restoreSystemPrompt(); // pops THIS instance's swap stack only

// A second instance shares nothing with the first:
const other = createAdk();
other.listAgents();        // [] — does not see 'planner'
```

Note: `createMemory`, `capabilities`, and `useAgentBus` are intentionally
instance-agnostic — they probe process-global `__ccp*` state / the filesystem, not
per-instance registries, so the same function is reused on every instance.

## The agent bus — `useAgentBus()`

`useAgentBus()` returns the live `globalThis.__ccpBus` event emitter, or **throws**
if the event-bus patch is not applied (so a missing bus is a loud failure, not a
silent no-op). Handoffs emit observability topics on it
(`handoff.start`, `handoff.end`, `handoff.degraded`, `handoff.restore`).

```js
import { useAgentBus } from '../packages/adk/index.mjs';

const bus = useAgentBus();                       // throws if __ccpBus absent
bus.on?.('handoff.degraded', ({ target, reason }) => {
  console.warn(`swap → delegate for ${target}: ${reason}`);
});
bus.emit('app.ready', { at: Date.now() });
```

Guard the call (`if (capabilities().bus)`) or wrap it in try/catch if the bus may
not be present.

## SECURITY / TRUST

Read the project-wide [`../../THREAT_MODEL.md`](../../THREAT_MODEL.md) for how the
underlying ccpatch primitives are gated; the points below are ADK-specific.

### Agent definitions are a trust boundary

Every `defineAgent(...)` carries a `systemPrompt`. In a swap-mode handoff a
**model-triggered tool call** can flip the live persona to one of those prompts.
Registering an agent therefore grants it the right to *become the active persona*
mid-session. Treat every registered `systemPrompt` as security-sensitive and audit
it — a registry of agents is a registry of personas the model is allowed to assume.

### swap-mode authority — and that swap is now reversible + allowlistable

`mode: 'swap'` overlays the target agent's `systemPrompt` onto the live system
prompt via `__ccpSetSystemPrompt`, continuing the conversation with full **system**
authority (not a synthetic user message). This is a privilege-escalation surface:
the model can change "who it is" in place. Two mitigations:

- **Allowlist.** Pass `allowSwapTargets: ['researcher', …]`. A swap to a target not
  in the list throws at definition time (a programmer error), so a disallowed
  persona flip can never silently occur.
- **Reversible.** Before overwriting, the previous prompt is pushed onto a per-scope
  swap stack, and a `transfer_back` tool is auto-registered (once) to give the model
  a revert affordance. Call `restoreSystemPrompt()` (or `adk.restoreSystemPrompt()`)
  to pop the stack and restore the prior persona.

When `__ccpSetSystemPrompt` is absent (the `expose_system_prompt` patch is off),
`swap` **degrades to `delegate`** and emits `handoff.degraded` rather than failing.

### AgentRouter drives the CLI via `__ccpSubmitInput`

`AgentRouter` is the *secondary*, code-decided handoff path: predicates pick the
next agent and the persona is injected by calling `__ccpSubmitInput` — i.e. it
**drives the live CLI by submitting input on the user's behalf**. That input
arrives as a *user* message (lower authority than a swap), but it is still
programmatic control of the session loop; treat router predicates and the agents
they can reach as trusted code. Transitions are capped (`maxTransitions`, default
50) so a non-converging predicate halts instead of looping unbounded. See
`../../THREAT_MODEL.md` for the broader `__ccpSubmitInput` injection surface.

### `createMemory` path sandboxing

`createMemory({ path })` resolves the path and **rejects anything outside the
project root** — a `..` traversal or an outside absolute path throws
(`path escapes project root`). The store is also size-capped (5 MB) so a hostile or
corrupt file is ignored rather than parsed into memory. Still, treat the memory
file as untrusted-at-rest: it is plain JSON on disk and anything that can write the
file can influence what your agents read back.
</content>
</invoke>
