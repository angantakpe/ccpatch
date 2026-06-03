# ADK Handoff Protocol

Status: **delegate and swap both shipping.** Delegate resolves native *and*
ADK-defined agents; swap is unblocked by the `expose_system_prompt` patch.

A *handoff* lets the model move work from the active agent to another agent. The
protocol is **tool-call driven** — the LLM decides when to hand off by calling a
`transfer_to_<target>` tool — with two transfer **modes** behind one API.

```js
import { defineHandoff } from 'ccpatch-adk';

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

The base Claude Code system prompt (tools, environment, harness rules) always
remains — only the persona overlay changes. Swapping again replaces the overlay;
`__ccpSetSystemPrompt(null)` clears it. **Caveat:** the overlay is global to the
main-loop assembly path and is not yet scoped by `querySource`, so a subagent
query running while an overlay is set also receives it — clear the overlay when
the swapped session ends.

## Bus events

Emitted on `__ccpBus` for observability (additive to the documented topic set):

| Topic | Payload | When |
|---|---|---|
| `handoff.start` | `{ id, from, target, mode }` | tool invoked |
| `handoff.end` | `{ id, target, mode, ok, ms }` | transfer resolved |
| `handoff.degraded` | `{ id, target, requested: 'swap', used: 'delegate', reason }` | swap fell back |

`id` is a per-handoff string; `from` is `globalThis.__ccp_path` at call time so
handoffs thread into the same agent-path tree the lifecycle patch builds.

## Primitives (resolved)

### swap — `expose_system_prompt`

`extensions/expose_system_prompt.mjs` provides `__ccpSetSystemPrompt(str|null)`,
`__ccpGetSystemPrompt()`, and wraps the main-loop system-prompt array builder
(`<var>=<wrap>([…isNonInteractive…hasAppendSystemPrompt…].filter(Boolean))`,
cardinality 1 across v2.1.156–161) so a set overlay is appended as a trailing
system block. Remaining refinement: scope the overlay by `querySource` so it does
not leak into concurrent subagent queries.

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
})
```

Returns the injected tool definition. Registering N handoffs injects N tools; the
model picks among them like any other tool.
