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

> Examples below import from the published package specifier
> **`@codehornets/adk`** (`main: index.mjs`), with the subpaths
> `@codehornets/adk/memory` and `@codehornets/adk/tool-registry` where relevant —
> so they copy-paste for anyone consuming the package. The in-repo tests use the
> relative form (`../packages/adk/index.mjs`) instead; substitute that path if you
> are working inside this repo rather than against the installed package.

## Quickstart

A runnable end-to-end wiring: define an agent, inject a tool, register a handoff,
and preflight capabilities before relying on any of it.

```js
import {
  defineAgent, defineTool, defineHandoff, capabilities,
} from '@codehornets/adk';

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

### Tool input validation — the built-in check is SHALLOW and FAIL-OPEN

> ⚠️ **Do not rely on `inputSchema` for security.** The ADK's built-in
> `validateInput` is intentionally a *shallow, fail-open* subset of JSON Schema.
> If it cannot interpret a keyword, it **accepts the input**. For any real
> validation guarantee you MUST pass your own `validate(input) => string|null`
> hook (wire in ajv/zod/etc.).

What the built-in `validateInput` **does** check, at the **top level only**:

- `type` (the five primitives: `string` / `number` / `boolean` / `object` / `array`)
- `required` properties present
- `additionalProperties: false` (only the literal `false` is honored — not a schema)
- `enum` membership
- `minLength` / `maxLength` on strings

What it **does NOT** check (silently accepted):

- **Nested object/array shapes.** A property typed `object`/`array` is checked
  *only* for being an object/array — its **contents are completely unchecked**
  (no recursion into sub-`properties`/`items`).
- **Numeric bounds:** `minimum` / `maximum` / `exclusiveMinimum` /
  `exclusiveMaximum` / `multipleOf`.
- `pattern`, `format`, `const`, `oneOf` / `anyOf` / `allOf` / `not`, `$ref`.
- Any keyword not in the "does check" list above → **silently ignored**.

Anything it cannot interpret (an unknown schema, a non-`object` root type) is
treated as valid (**fail-open**). Security therefore depends on the caller:

```js
import { z } from 'zod';

const schema = z.object({ age: z.number().int().min(0).max(120) });

defineTool({
  name: 'set_age',
  description: 'Record a person’s age.',
  inputSchema: { type: 'object', properties: { age: { type: 'number' } }, required: ['age'] },
  // DEEP check the built-in cannot do (numeric bounds, nested shapes, etc.).
  // Runs AT THE call() BOUNDARY, AFTER the built-in. Return a string to reject,
  // or null/undefined to accept; a thrown error is surfaced as a validation error.
  validate: (input) => {
    const r = schema.safeParse(input);
    return r.success ? null : r.error.issues[0].message;
  },
  execute: async ({ age }) => `age set to ${age}`,
});
```

Independently of schema, every tool call is also subject to a coarse
**`MAX_INPUT_BYTES` ceiling (256 KB)** on the serialized input, enforced in the
`call()` wrapper — an oversized payload is rejected before `validateInput` or your
`validate` hook runs. That is a blunt oversized-input guard, **not** a substitute
for the deep `validate` hook above.

### Introspection

```js
import { listTools, toolStatuses, swapDepth, currentPersona } from '@codehornets/adk';

listTools();       // names of tools that are LIVE in the DEFAULT instance's scope
toolStatuses();    // FULL lifecycle view: [{ name, status }] — status is
                   //   'queued' | 'live' | 'failed' (see below)
swapDepth();       // swap-stack entries OWNED by the DEFAULT instance (0 if none)
currentPersona();  // the live persona overlay (single global slot), or null
```

`listTools()` reports **live tools only** — a tool that is still queued (registry
not ready yet) or that ultimately **failed** to inject (its bounded poll timed out)
is excluded. `toolStatuses()` complements it with the complete queued/live/failed
lifecycle view, so a tool that never injected is observable rather than a silent
no-op. Use `toolStatuses()` when you need to *diagnose* injection; `listTools()`
when you just want the names that are actually callable right now.

`createAdk()` instances expose the same four as methods (`adk.listTools()`,
`adk.toolStatuses()`, `adk.swapDepth()`, `adk.currentPersona()`).
`listTools`/`toolStatuses`/`swapDepth` are per-scope; `currentPersona` reads the
one global persona slot shared by every instance.

## Memory

`createMemory()` is a JSON-file key/value store with an in-memory write-through
cache. Reads come from cache; writes are debounced (~100ms) to disk. Call
`flush()` to force a pending write to land now (awaitable) — do this before you
need a durable on-disk read or before a controlled shutdown.

```js
import { createMemory } from '@codehornets/adk';        // or '@codehornets/adk/memory'

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
import { createAdk } from '@codehornets/adk';

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

adk.dispose();             // tear the instance down — see below
```

Note: `createMemory`, `capabilities`, and `useAgentBus` are intentionally
instance-agnostic — they probe process-global `__ccp*` state / the filesystem, not
per-instance registries, so the same function is reused on every instance.

### `adk.dispose()` — tear an instance down

`dispose()` tears down the instance: it unregisters/disposes its **tools**, pops
and restores its **swap-stack entries** (releasing the exclusive swap lock if this
instance holds it), and clears its **agent** registry. It is **idempotent** — safe
to call more than once. Use it for per-test or per-session cleanup so a finished
instance leaves no live tools or persona overlays behind.

```js
const adk = createAdk();
// … define agents / tools / handoffs, run work …
adk.dispose();             // tools removed, swaps restored, lock released, agents cleared
```

### `tryAcquireSwap()` — make swap contention explicit (single shared persona slot)

Swap operates over a **single host persona slot shared by all instances**, so
per-instance swap isolation is *cooperative / LIFO*: instances back their swaps
with one process-global stack, and an out-of-order cross-instance restore is
refused rather than allowed to clobber another instance's persona (it emits
`handoff.restore.skipped` and returns `false`).

`tryAcquireSwap()` (top-level **and** an instance method, `adk.tryAcquireSwap()`)
makes that shared-slot contention **explicit and opt-in**. It acquires the
exclusive swap lock and returns a **token**, or `null` when another scope already
holds the lock — so a caller that needs guaranteed sole control of the live
persona can detect contention *up front* instead of discovering it at restore time:

```js
import { tryAcquireSwap } from '@codehornets/adk';

const token = tryAcquireSwap();   // null if another scope holds the lock
if (token) {
  try {
    token.swap('You are the reviewer persona.'); // push prev + overlay this persona
    // … run the swapped-in turn …
    token.restore();                              // LIFO-restore the previous prompt
  } finally {
    token.release();                              // restore any remaining owned entries + drop the lock
  }
}
```

The token exposes:

- `swap(persona)` — push the displaced prompt onto the shared stack and overlay
  `persona`. Throws if the token has been released.
- `restore()` — LIFO-restore the most recent entry **this** scope owns; returns a
  boolean (false if the top isn't owned by this scope).
- `release()` — restore every remaining entry this scope still owns (LIFO), drop
  the lock, and emit `handoff.swap.release`. Idempotent.
- `owned` — getter, `true` while this token still holds the lock.

The lock is **advisory** over the same shared swap stack the legacy
`defineHandoff` swap / `restoreSystemPrompt()` path uses — those callers do *not*
consult it, so existing code is unaffected. `tryAcquireSwap()` is purely the opt-in
way to coordinate when you care about exclusivity.

## The agent bus — `useAgentBus()`

`useAgentBus()` returns the live `globalThis.__ccpBus` event emitter, or **throws**
if the event-bus patch is not applied (so a missing bus is a loud failure, not a
silent no-op). Handoffs emit observability topics on it
(`handoff.start`, `handoff.end`, `handoff.degraded`, `handoff.restore`).

```js
import { useAgentBus } from '@codehornets/adk';

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
