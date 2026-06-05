# ADK Handoff Protocol

Status: **delegate and swap both shipping.** Delegate resolves native *and*
ADK-defined agents; swap is unblocked by the `expose_system_prompt` patch. The
persona writer is now **nonce-gated** (`__ccpSetSystemPrompt(nonce, value)` +
`__ccpGetSystemPromptNonce()`). Swap is **reversible** via a single
process-global, scope-owned LIFO stack (auto-registered `transfer_back` tool /
`restoreSystemPrompt()`), **allowlistable** (`allowSwapTargets`), and **persona-
pinned** (sha256 TOCTOU refusal). Injected tools are disposable
(`handle.dispose()`) and their liveness is observable (`handle.ready` /
`handle.injected`). Call `capabilities()` to preflight the live `__ccp*` surface
(now with `caps.detail`) before depending on any mode — see [Trust](#trust).

A *handoff* lets the model move work from the active agent to another agent. The
protocol is **tool-call driven** — the LLM decides when to hand off by calling a
`transfer_to_<target>` tool — with two transfer **modes** behind one API.

```js
import { defineHandoff } from '@codehornets/adk';

defineHandoff({
  target: 'researcher',
  mode: 'delegate',          // 'delegate' (default) | 'swap'
  description: 'Hand the open question to the research agent.',
});
```

## Why tool-call, not orchestrator injection

Three architectures were on the table:

1. **Tool-call → delegate** — `transfer_to_X` tools backed by
   `__ccpAgentTool.invoke`. LLM-decided. Isolated subagent context. Control
   returns to the caller. **Buildable today.**
2. **Tool-call → in-place swap** — same context, swap persona + tools, continue.
   The "true baton pass." Unblocked by the `expose_system_prompt` patch
   (see [swap](#swap-requires-expose_system_prompt)).
3. **Orchestrator injection** — a router watches `turn.end`, evaluates a JS
   predicate, injects the next persona via `__ccpSubmitInput`. Code-decided, and
   the persona arrives as a *user* message (low authority). This is what the
   original `AgentRouter` stub half-built; it survives as the predicate-driven
   path (`AgentRouter`) but is **not** the primary protocol.

The hybrid commits to tool-call (#1) as the surface. `swap` (#2) lights up when
`expose_system_prompt` is enabled; when the `__ccpSetSystemPrompt` primitive is
absent, `swap` **degrades gracefully to delegate** and emits a `handoff.degraded`
bus event.

## Modes

### `delegate` (default, works today)

The handoff tool calls `__ccpAgentTool.invoke({ subagent_type: target, prompt })`.
A fresh subagent runs in an **isolated context** and its final text returns into
the caller's `tool_result`. Control returns to the calling agent — this is
delegation, not a permanent transfer.

```
caller turn ──calls transfer_to_researcher──▶ subagent(researcher) runs
                                                      │
            ◀────────── result text as tool_result ──┘
caller continues with the result in context
```

**Resolution.** `subagent_type` is resolved by Claude Code against the live
`options.agentDefinitions.activeAgents` list (see
`extensions/prime_agent_tool_on_boot.mjs:52`). Native CC subagent types (a
`.claude/agents/*.md` agent, an octo persona, etc.) resolve directly. For an
**ADK-defined agent** (`defineAgent(...)`), `defineHandoff` converts the ADK
definition to CC's agent shape and passes it as `agentDef` to
`__ccpAgentTool.invoke`, which merges it into `activeAgents` at dispatch time — so
ADK agents resolve without any new bundle anchor. The synthetic def survives the
resolution filter (`kPH` only drops deny-ruled agents) and the spawn path calls
its `getSystemPrompt()`.

### `swap` (requires `expose_system_prompt`)

True handoff: keep the same context window and overlay the target agent's persona
onto the live system prompt, continuing the conversation with full **system**
authority (not a synthetic user message) and shared history. Backed by
`globalThis.__ccpSetSystemPrompt`, provided by the `expose_system_prompt` patch,
which appends the persona as a trailing system block on every main-loop query.
`defineHandoff` reads the target's `systemPrompt` (via `defineAgent`) and sets the
overlay. When the patch is not enabled (`__ccpSetSystemPrompt` absent), `swap`
logs once and falls back to `delegate`.

**Nonce-gated writer.** The persona write is *higher* authority than tool dispatch,
so it is gated like `__ccpInvokeTool`: the patch exposes
`__ccpSetSystemPrompt(callerNonce, value)` and `__ccpGetSystemPromptNonce()`, and
the ADK acquires the nonce lazily at the call site. Unguarded in-process code that
did not participate in the patch load (e.g. a compromised MCP server) cannot flip
the persona. A legacy single-arg `__ccpSetSystemPrompt(value)` fallback is kept for
older hosts / test stubs that expose no nonce getter.

**Reversible — single global slot, LIFO ownership.** The host exposes exactly ONE
live persona slot, so swaps from *all* `createAdk()` instances are backed by a
**single process-global swap stack** whose entries record the owning scope id and
the displaced prompt. Before overwriting, that entry is pushed and a `transfer_back`
tool is auto-registered (once). `restoreSystemPrompt()` (DEFAULT) /
`adk.restoreSystemPrompt()` pops **only** when the stack's top entry is owned by
that scope: well-nested (LIFO) usage restores correctly and emits `handoff.restore`;
an out-of-order cross-instance restore refuses to clobber another instance's persona,
emits `handoff.restore.skipped`, warns once, and returns `false`. So `createAdk()`
swap isolation is honest *but shares one global slot* — each instance owns its own
stack entries while they all mirror the same single live persona.

**Allowlist.** Pass `allowSwapTargets: [...]` to restrict which personas a swap may
flip to. A swap whose `target` is not listed throws at definition time (a
programmer error), so a disallowed persona flip can never silently occur.

**Persona pin (TOCTOU refusal).** `allowSwapTargets` only allowlists the target
*name*; a later `defineAgent()` could rebind a hostile `systemPrompt` under it. When
the target is already registered at definition time, `defineHandoff` pins the sha256
of its `systemPrompt`. At execute time a drifted live hash **refuses** the swap
(emits `handoff.pin.mismatch`, returns a readable tool_result error) instead of
applying a persona that changed since the handoff was defined. An unregistered
target has nothing to pin (`handoff.pin.deferred`) and falls back to current
behavior.

The base Claude Code system prompt (tools, environment, harness rules) always
remains — only the persona overlay changes. Swapping again replaces the overlay;
`__ccpSetSystemPrompt(null)` clears it. The overlay is **scoped by query source**:
`__ccpApplySystemPromptOverride` only appends the persona when
`globalThis.__ccp_path` is unset or `"root"`, so a subagent query running while an
overlay is set (its `__ccp_path` is the non-root `"<parent>/<child>"` set by
`expose_agent_tool`) does **not** receive it. Still clear the overlay when the
swapped session ends so the next top-level turn starts clean.

## Bus events

Emitted on `__ccpBus` for observability (additive to the documented topic set):

| Topic | Payload | When |
|---|---|---|
| `handoff.start` | `{ id, from, target, mode }` | tool invoked |
| `handoff.end` | `{ id, target, mode, ok, ms }` | transfer resolved |
| `handoff.degraded` | `{ id, target, requested: 'swap', used: 'delegate', reason }` | swap fell back |
| `handoff.pin.mismatch` | `{ id, target, pinned, live }` | swap refused — persona changed since define |
| `handoff.pin.deferred` | `{ id, target }` | target unregistered at define → nothing pinned |
| `handoff.restore` | `{ restored, depth }` | swap stack popped (`restoreSystemPrompt` / `transfer_back`) |
| `handoff.restore.skipped` | `{ owner, requestedBy, depth }` | out-of-order cross-instance restore refused |

`id` is a per-handoff string; `from` is `globalThis.__ccp_path` at call time so
handoffs thread into the same agent-path tree the lifecycle patch builds.

## Primitives (resolved)

### swap — `expose_system_prompt`

`extensions/expose_system_prompt.mjs` provides the nonce-gated
`__ccpSetSystemPrompt(callerNonce, str|null)`, the nonce getter
`__ccpGetSystemPromptNonce()`, the ungated reader `__ccpGetSystemPrompt()`, and
wraps the main-loop system-prompt array builder
(`<var>=<wrap>([…isNonInteractive…hasAppendSystemPrompt…].filter(Boolean))`,
cardinality 1 across v2.1.156–161) so a set overlay is appended as a trailing
system block. The overlay is scoped to main-loop queries via `globalThis.__ccp_path`
(unset/`"root"` ⇒ apply; non-root ⇒ skip), so it does not leak into concurrent
subagent queries. It registers a typed `systemPrompt` contract (version **2**,
shape `['set', 'get', 'getNonce']`) that `capabilities()` cross-checks.

### ADK-agent resolution — `agentDef` merge

`__ccpAgentTool.invoke` accepts an optional CC-shaped `agentDef` and merges it into
`bgCtx.options.agentDefinitions.activeAgents` at dispatch. `defineHandoff` converts
the `defineAgent` shape (`{ name, description, systemPrompt, tools, model }`) into
CC's (`{ agentType, whenToUse, tools, source:'user', getSystemPrompt, model }`).
Runtime merge — no bundle anchor, version-independent.

## API

```js
defineHandoff({
  target,                       // required — subagent_type / agent name to hand to
  mode = 'delegate',            // 'delegate' | 'swap'
  description,                  // tool description shown to the model
  toolName = `transfer_to_${target}`,
  inputSchema,                  // JSON Schema; default { task: string (required) }
  promptKey = 'task',           // which input field becomes the subagent prompt
  allowSwapTargets,             // optional string[]; swap to a target ∉ it throws (TRUST)
})
```

Returns the injected tool *handle* — the def plus `.ready` (`Promise<boolean>`:
true once live in `__ccpRawTools`, false on the ~5s poll timeout, never rejects),
`.injected` (mirrors `.ready` but rejects on timeout when `throwOnInjectFail: true`),
and `.dispose()` (removes it from the live array / cancels its pending queue entry).
Registering N handoffs injects N tools; the model picks among them like any other
tool. `restoreSystemPrompt()` pops the (scope-owned, global) swap stack to revert
the most recent swap.

## Preflight — `capabilities()`

Call `capabilities()` before depending on a mode: it probes the `__ccp*` globals
and returns `{ tools, delegate, swap, router, bus }` (each a boolean — keep using
`if (caps.swap)`), so you can branch on what is actually wired this session instead
of failing at call time. It is pure / side-effect-free. `caps.detail` adds
per-capability `{ live, patch, reason? }`: `patch` names the providing patch and
`reason` is set only when the **version/shape contract handshake** downgraded the
capability. Where a typed contract is registered (`core/contracts.mjs`),
`capabilities()` cross-checks version + shape so a present-but-drifted global is
refused loudly — e.g. an old `systemPrompt` v1 contract flips `caps.swap` to false
with reason `"contract systemPrompt v1 < required v2"`, and a `toolDispatch` shape
lacking `registerTool` flips `caps.tools`.

## Trust

A `swap` handoff lets a **model-triggered** tool call replace the live system
prompt with a registered agent's persona — a privilege-escalation surface (the
model can change "who it is" mid-session). Audit every `defineAgent` `systemPrompt`
as security-sensitive: registering an agent grants it the right to become the
active persona. Mitigations: a **nonce-gated** persona writer (unguarded
in-process code cannot flip the persona), `allowSwapTargets` (disallowed flip =
programmer error), a **persona pin** (sha256 TOCTOU refusal if the persona changed
since define), and the reversible **single-global-slot, scope-owned LIFO** swap
stack (`transfer_back` / `restoreSystemPrompt()`; an out-of-order cross-instance
restore is refused, not allowed to clobber). Tool injection is likewise nonce-gated
(`__ccpRegisterTool` / `__ccpUnregisterTool`). `AgentRouter` is the secondary,
lower-authority path: it drives the live CLI via `__ccpSubmitInput` (a *user*
message — the model may ignore it), but its predicates and reachable agents are
trusted code that can steer the session — never wire untrusted input into them. See
`README.md` and the project-wide `../../THREAT_MODEL.md`.
