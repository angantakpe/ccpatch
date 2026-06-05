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
// → { tools, delegate, swap, router, bus } — each a boolean (use as `if (caps.swap)`).
// caps.detail adds per-capability remediation info:
//   caps.detail.swap === { live, patch: 'expose_system_prompt', reason? }
// `reason` is set only when the contract version/shape handshake DOWNGRADED the
// capability — e.g. a drifted host advertising an old systemPrompt v1 (no nonce
// gate) flips caps.swap to false with reason "contract systemPrompt v1 < required v2".

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

`defineTool` returns a `ToolHandle`: the def plus `.ready` (a `Promise<boolean>` —
true once live, false on the ~5s bounded-poll timeout, never rejects), `.injected`
(mirrors `.ready` but **rejects** on timeout when you pass `throwOnInjectFail: true`),
and `.dispose()` (removes the tool from the live array / cancels its pending queue
entry). An optional `onInjectFail(name)` callback fires once if injection times out,
so a never-injected tool is observable rather than a silent no-op. `defineHandoff`
returns the injected `transfer_to_<target>` tool handle.

Tool injection is **nonce-gated**: the `expose_tool_dispatch` patch exposes
`__ccpRegisterTool` / `__ccpUnregisterTool` guarded by the same dispatch nonce as
`__ccpInvokeTool`, so only code that acquired the nonce at load can add or remove
live tools. The ADK routes through that registrar; it falls back to a direct array
mutation only when the registrar is absent (e.g. a bare-array unit-test stub).

### Introspection

```js
import { listTools, swapDepth, currentPersona } from '../packages/adk/index.mjs';

listTools();       // names of tools live/queued in the DEFAULT instance's scope
swapDepth();       // swap-stack entries OWNED by the DEFAULT instance (0 if none)
currentPersona();  // the live persona overlay (single global slot), or null
```

`createAdk()` instances expose the same three as methods (`adk.listTools()`,
`adk.swapDepth()`, `adk.currentPersona()`). `listTools`/`swapDepth` are per-scope;
`currentPersona` reads the one global persona slot shared by every instance.

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
mem.snapshot();           // { lastTopic: 'token budgets' } (DEEP copy)

await mem.flush();        // force the debounced write to disk now
mem.delete('lastTopic');  // cache + debounced persist
mem.clear();              // drop every key + debounced persist
mem.dispose();            // detach from the exit registry + cancel pending debounce
```

`snapshot()` returns a **deep** copy (`structuredClone`), so mutating a nested
object in the snapshot cannot leak back into the live store.

`dispose()` detaches the instance from the module-level exit-flush registry and
cancels any pending debounce timer. It is idempotent and does **not** auto-flush —
call `flush()` first if you need pending writes persisted. (One shared
`process.on('exit')` listener serves every instance, so disposing avoids leaking
per-instance listeners + closures.)

A best-effort flush also runs on process `exit`, so a pending debounced write is
not lost on a clean shutdown. Writes are **atomic and owner-only**: each flush
writes a sibling temp file with mode `0600` (rw-------) then `rename()`s it over the
target, so a crash mid-write leaves the old file intact and the store is never
world/group readable on disk. The on-disk file is size-bounded (5 MB) — a larger
file is ignored rather than parsed. The contents are still untrusted plaintext JSON
at rest; `0600` limits who can read it, it is not encrypted.

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
the model can change "who it is" in place. Mitigations:

- **Nonce-gated writer.** Flipping the live persona is *higher* authority than tool
  dispatch, so the writer is nonce-gated exactly like tool dispatch. The patch
  exposes `__ccpSetSystemPrompt(nonce, value)` plus `__ccpGetSystemPromptNonce()`;
  the ADK acquires the nonce lazily at the call site. Code that did not participate
  in the patch load (e.g. a compromised MCP server) cannot reassign the persona.
  (A legacy single-arg `__ccpSetSystemPrompt(value)` fallback keeps older
  hosts/test stubs working.)
- **Allowlist.** Pass `allowSwapTargets: ['researcher', …]`. A swap to a target not
  in the list throws at definition time (a programmer error), so a disallowed
  persona flip can never silently occur.
- **Persona pin (TOCTOU refusal).** `allowSwapTargets` only allowlists the *name*; a
  later `defineAgent()` could swap a hostile `systemPrompt` under that name. So when
  the swap target is already registered at definition time, the ADK pins the sha256
  of its `systemPrompt`. At execute time, if the live persona's hash has drifted the
  swap is **refused** (emits `handoff.pin.mismatch`, returns a readable tool_result
  error) rather than applying a persona that changed since the handoff was defined.
- **Reversible (single global slot, LIFO ownership).** The host exposes exactly ONE
  live persona slot, so swaps from all instances are backed by a **single
  process-global swap stack** whose entries record the owning scope. Before
  overwriting, the displaced prompt is pushed (tagged with the scope id) and a
  `transfer_back` tool is auto-registered (once). `restoreSystemPrompt()` (or
  `adk.restoreSystemPrompt()`) pops **only** when the stack's top entry is owned by
  that scope — well-nested (LIFO) usage restores correctly; an out-of-order
  cross-instance restore refuses to clobber another instance's live persona, emits
  `handoff.restore.skipped`, and returns `false`. `createAdk()` swap isolation is
  therefore *honest but shares one global slot*: each instance owns its own stack
  entries, but they all mirror the same single live persona.

When `__ccpSetSystemPrompt` is absent (the `expose_system_prompt` patch is off),
`swap` **degrades to `delegate`** and emits `handoff.degraded` rather than failing.

### AgentRouter drives the CLI via `__ccpSubmitInput`

`AgentRouter` is the **secondary, lower-authority, trusted-code-only** handoff path
— not the primary protocol (reach for tool-call-driven `defineHandoff` first). It
exists for *code-decided* orchestration: predicates pick the next agent and the
persona is injected by calling `__ccpSubmitInput` — i.e. it **drives the live CLI by
submitting input on the user's behalf**. That input arrives as a *user* message,
which is **strictly lower authority than a swap** (which rewrites the system prompt):
the model is free to ignore it. The real risk is that the predicates and the set of
reachable agents are not model-controlled and not sandboxed — they are **trusted
code**, so registering an agent/predicate here grants it the right to steer the
session. Never wire untrusted input into a predicate or a reachable `systemPrompt`.
The first real `__ccpSubmitInput` submit emits `router.active` on the bus so
operators can observe that code (not the user) is now driving session control.
Transitions are capped (`maxTransitions`, default 50) so a non-converging predicate
halts instead of looping unbounded. See `../../THREAT_MODEL.md` for the broader
`__ccpSubmitInput` injection surface.

### `createMemory` path sandboxing

`createMemory({ path })` resolves the path and **rejects anything outside the
project root** — a `..` traversal or an outside absolute path throws
(`path escapes project root`). The store is also size-capped (5 MB) so a hostile or
corrupt file is ignored rather than parsed into memory. Still, treat the memory
file as untrusted-at-rest: it is plain JSON on disk and anything that can write the
file can influence what your agents read back.
