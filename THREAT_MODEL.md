# ccpatch threat model

Patches produced by ccpatch run inside your local Claude Code process. They share the same trust boundary as the CLI itself — anything the patched CLI can do (read your filesystem, call the Anthropic API, spawn subprocesses), an enabled patch can also do. ccpatch ships **no Anthropic code**. It transforms a copy of Claude Code that is already installed on your machine.

The patcher itself (the `bin/`, `runner/`, `tools/`, `core/`, `extensions/` tree) makes no network calls, ships no telemetry, and has no auto-update path.

---

## Per-patch risk table

Columns:

- **Touches** — what part of the CLI the patch rewrites.
- **Reads** — what runtime data flows into the patch.
- **Writes / Sends** — where data leaves the patch (local disk, network, stdout). "None" means in-process only.
- **Default** — `on` if enabled out of the box in `ccpatch.yml`, `off` if opt-in.

### Core (`core/`)

| Patch | Touches | Reads | Writes / Sends | Default |
| --- | --- | --- | --- | --- |
| `react_singleton` | bundled React module export | n/a | None | on |
| `esm_compat` | CJS-IIFE wrapper | n/a | None | on |
| `contracts` | typed `__ccp*` registry surface | n/a | None | on |
| `fetch_interceptor` | global `fetch` | every outgoing CLI HTTP request | fans out to in-process subscribers only; no I/O of its own | on |
| `fix_bun_shim` | Bun runtime polyfills | n/a | None | on |
| `fix_stdin_da1_leak` | stdin handler | terminal stdin | strips DA1/DA2 escape sequences in-process | on |
| `fix_message_normalizer` | display-item type guard | conversation display items | None | on |
| `fix_project_root` | projectRoot resolver | cwd / env | None | on |
| `tool_result_error_content` | tool_result block builder | tool error blocks | None | on |

### Extensions — fixes & QoL

| Patch | Touches | Reads | Writes / Sends | Default |
| --- | --- | --- | --- | --- |
| `dotenv_loader` | early boot | local `.env` files | sets `process.env`; no network | off |
| `hook_noise_mute` | hook stderr writer | hook stderr | swallows known-noisy lines | off |
| `fix_cache_ttl` | prompt-cache TTL selector | n/a | None | off |
| `fix_grep_shadow` | grep/find shadow injector | n/a | None | off |
| `rate_limit` | retry / Retry-After logic | API response headers | None | off |
| `large_content_guard` | system-message content sizer | system messages | None | off |
| `recap_strip_hint` | recap renderer | recap text | None | off |
| `input_bar_color` | prompt theme border value | n/a | None | off |

### Extensions — command system

| Patch | Touches | Reads | Writes / Sends | Default |
| --- | --- | --- | --- | --- |
| `custom_commands` | slash-command registry | user input | local files via existing CLI tools only | off |
| `slash_dispatch` | prompt-bar input handler | user input | None directly | off |
| `subagent_hooks_stub` | no-op event bus | subagent events | None | off |

### Extensions — feature unlocks

| Patch | Touches | Reads | Writes / Sends | Default |
| --- | --- | --- | --- | --- |
| `durable_cron` | `isDurableCronEnabled()` | n/a | None | off |
| `loop_dynamic` | loop-dynamic / loop-prompt flag fns | n/a | None | off |
| `plan_mode_interview` | plan-mode-interview flag fn | env var | None | off |
| `unhide_features` | client-side feature gates | n/a | None | off |
| `extended_thinking` | thinking / effort injection | `CC_THINKING`, `CC_EFFORT_LEVEL` | flags ride along on existing API calls | off |
| `force_thinking` | interactive thinking trigger | `CC_THINKING` | flags ride along on existing API calls | off |
| `mcp_lazy` | MCP `tools/list` handler | cached MCP tool list | None new; refreshes via existing MCP transport | off |

### Extensions — observability

| Patch | Touches | Reads | Writes / Sends | Default |
| --- | --- | --- | --- | --- |
| `cost_tracker` | status-bar renderer | token usage from API responses | renders to terminal; no network | off |
| `context_budget_warn` | warning injector | context size | renders to terminal | off |
| `tool_result_trim` | tool_result builder | tool results | truncates before upstream send | off |
| `tools_log` | fetch-interceptor SSE subscriber | tool_use / tool_result blocks | writes to local log files under `storage/` | off |
| `boost_project_commands` | autocomplete ordering | command metadata | None | off |
| `session_timer` | session clock | session start time | renders to terminal | off |
| `debug` | API + tool-call logger | full request/response payloads | writes verbose logs to stderr / local files when `CLAUDE_DEBUG` set | off |

### Extensions — expose internals

These don't change CLI behavior; they expose `__ccp*` globals so other tools can introspect or reuse the live CLI state.

| Patch | Touches | Reads | Writes / Sends | Default |
| --- | --- | --- | --- | --- |
| `expose_tool_dispatch` | tool-format pipeline | live tool registry, MCP clients | exposes `__ccpInvokeTool` etc.; no I/O of its own | off |
| `expose_api_client` | Anthropic SDK client constructor | SDK client | exposes `__ccpApiClient` | off |
| `expose_submit_input` | React submit callback | prompt input | exposes `__ccpSubmitInput` | off |
| `expose_agent_tool` | AgentTool definition | live AgentTool | exposes `__ccpAgentTool` | off |
| `prime_agent_tool_on_boot` | React mount path | AgentTool init | primes AgentTool during mount | off |
| `capture_interactive_request` | first `/v1/messages` call | first request body shape | stashes shape in memory for reuse | off |

### Extensions — optional integrations (highest scrutiny)

| Patch | Touches | Reads | Writes / Sends | Default |
| --- | --- | --- | --- | --- |
| `model` | default model selector | `CC_MODEL` env | changes which model the CLI calls | off |
| `block_tools` | tool registry | `CC_BLOCKED_TOOLS` env | filters tools from the registry; no I/O | off |
| `save_conversations` | conversation lifecycle | full conversation transcripts | **writes JSON files to local disk** when `CC_SAVE_CONVERSATIONS` is set | off |
| `webhook` | event hooks | event payloads | **POSTs to `CC_WEBHOOK_URL`** when set; opt-in via env var | off |
| `cache_responses` | API response path | full API responses | **writes response bodies to a local cache directory**; dev/testing only | off |

The bolded rows are the ones to read carefully before enabling. None of them act unless their env var is set.

---

## Capability declarations

Every patch declares a `capabilities: string[]` in its manifest. This is a self-reported vocabulary of *what powers the patch can exercise inside the patched bundle* — the same trust dimensions used in the per-patch table above, but in a form the tooling can read and enforce on.

| Capability | Meaning |
| --- | --- |
| `network` | patch intercepts `fetch` or makes outbound HTTP requests |
| `fs` | patch reads/writes files outside the bundle |
| `prompt` | patch modifies system or user prompt content |
| `tools` | patch alters tool dispatch or tool definitions |
| `env` | patch reads env vars beyond the ones declared in the documentation-only `env` field |
| `exec` | patch can execute subprocesses (`child_process`, `spawn`, etc.) |
| `telemetry` | patch sends data to external sinks (webhook, logging service) |

Empty / missing array means the patch is purely cosmetic.

### Risk classes

Capabilities map to a coarse three-tier risk class used by the CLI:

- **low** — no declared capabilities
- **medium** — only `prompt`, `fs`, and/or `env`
- **high** — any of `network`, `tools`, `exec`, `telemetry`

### Inspecting capabilities

```
ccpatch capabilities                  # full table for all loaded patches
ccpatch capabilities --profile power  # restrict to a profile from ccpatch.yml
ccpatch capabilities --json           # machine-readable form
```

### Apply-time gate

When the CLI runs in **strict mode** (`--strict` or `CCPATCH_STRICT=1`), it refuses to apply patches with `high`-risk capabilities unless the user explicitly acknowledges them:

```
ccpatch apply ... --strict --allow-capabilities network,fs,telemetry
ccpatch apply ... --strict --allow-capabilities=all
```

Any high-risk patch whose capabilities aren't fully covered by `--allow-capabilities` is rejected up front, before any code is rewritten. In non-strict mode the CLI emits a `[capabilities] WARN` line and proceeds — the gate exists to make capability acknowledgement a first-class, auditable step in CI / release pipelines, not to be a barrier in interactive use.

## How to disable a patch

Three options, any of them is fine:

- Edit `ccpatch.yml`: set the patch to `false` or comment the line out, then re-run `make patch-claude-code`.
- Pass an explicit list that excludes it: `make patch-claude-code PATCH=fix_bun_shim,react_singleton,esm_compat,contracts,fetch_interceptor`.
- Use `--profile minimal` _(coming)_ to apply only `core/` infrastructure and bug fixes.

To audit what was actually injected, run `node bin/patch-cli.mjs <input.js> /tmp/out.js --dry-run` and read the diff.

---

## What ccpatch does NOT do

- No telemetry from the patcher or the patched bundle.
- No network calls from the patcher itself.
- No auto-update. You upgrade by `git pull` and re-running `make patch-claude-code`.
- No modification of files outside the input and explicitly chosen output path.
- No interception of Anthropic credentials beyond what Claude Code itself already does in-process.

If you find a patch that violates any of the above, that's a bug — please open an issue.
