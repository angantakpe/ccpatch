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
| `bun_shim` | Bun runtime polyfills | n/a | None | on |
| `stdin_da1_leak` | stdin handler | terminal stdin | strips DA1/DA2 escape sequences in-process | on |
| `message_normalizer` | display-item type guard | conversation display items | None | on |
| `project_root` | projectRoot resolver | cwd / env | None | on |
| `tool_result_error_content` | tool_result block builder | tool error blocks | None | on |

`fetch_interceptor` isolates each registered subscriber: a throw in a
network/fetch subscriber is **caught and swallowed by default** so one buggy
handler cannot disrupt the CLI's network path. Swallowed errors are routed to a
debug sink (`__ccpBusWarn`) that stays silent unless `CLAUDE_DEBUG=1` (or
`globalThis.__ccpDebug`) is set. This contains the blast radius of a faulty
subscriber, but it also means a misbehaving one fails invisibly — see
[CONTRIBUTING.md](./CONTRIBUTING.md#debugging-a-networkfetch-subscriber) for how
to surface those errors when authoring or auditing a subscriber patch.

**Paranoid mode flips this swallowed surface to opt-in-loud — see
[Paranoid / strict mode](#paranoid--strict-mode) below.**

### Extensions — fixes & QoL

| Patch | Touches | Reads | Writes / Sends | Default |
| --- | --- | --- | --- | --- |
| `dotenv_loader` | early boot | local `.env` files | sets `process.env` (security-critical keys denylisted — see below); no network | off |
| `hook_noise_mute` | hook stderr writer | hook stderr | swallows known-noisy lines | off |
| `cache_ttl` | prompt-cache TTL selector | n/a | None | off |
| `grep_shadow` | grep/find shadow injector | n/a | None | off |
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
| `cache_responses` | API response path | full API responses + auth header (hashed into key) | **writes response bodies to a local cache directory**; dev/testing only — cache dir is trusted (poisoning surface), see below | off |

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

There are two layers to the gate.

**Default-strict ack gate (always on).** Patches that declare `network`, `exec`,
`env`, `tools`, or `telemetry` are gate-required **unconditionally** — even in
the default, non-strict `make patch-claude-code` path. A build refuses to apply
such a patch until every one of those capabilities is acknowledged, either by an
`ack:` entry in `ccpatch.yml` or via `--allow-capabilities`. This closes the hole
where the most dangerous patches (`expose_tool_dispatch` / `expose_agent_tool`,
both `tools`; any `telemetry` sink) could previously be applied with only a
warning. The acknowledgement is rejected up front, before any code is rewritten.
(The set of caps that *force* this gate — `GATE_REQUIRED_CAPS` — is broader than
`ACK_REQUIRED_CAPS`, which still governs only what `ccpatch ack` writes by
default: `network`, `exec`, `env`.)

**Strict mode (`--strict` / `CCPATCH_STRICT=1`)** additionally refuses any
remaining `high`-risk capability not covered by `--allow-capabilities`:

```
ccpatch apply ... --strict --allow-capabilities network,fs,telemetry
ccpatch apply ... --strict --allow-capabilities=all
```

The curated **`daemon` / `daemon_native` / `orchestrator`** profiles compose the
full remote tool/code-execution stack (`headless_bridge` + the `expose_*`
patches). They are **intentionally not pre-acked** — selecting one still forces
explicit per-capability acknowledgement of its `tools`/`network`/`telemetry`
patches, so standing up the bridge is always a deliberate, auditable act.

**The capability gate protects BUILD time, not RUNTIME.** The gate decides
*whether a patch is allowed into the bundle*; it does nothing once the bundle is
running. In particular, running the patched bundle with
`--dangerously-skip-permissions` means patched tool-dispatch code runs with **no
runtime allow/deny prompts at all** — the bundle you acknowledged at build time
then executes its tool calls unprompted. Acknowledging a `tools`/`exec`/`network`
capability is a build-time decision; it is not a substitute for the runtime
permission prompts that `--dangerously-skip-permissions` removes.

## Dangerous combinations & full-bypass flags

The per-patch table treats each patch in isolation, but some combinations are
materially more dangerous than the sum of their parts. Read this section before
enabling anything in the "expose internals" or "optional integrations" groups.

### Remote tool/code-execution surface

Enabling **`expose_tool_dispatch`**, **`expose_api_client`**, or
**`expose_agent_tool`** alongside **`headless_bridge`** turns the patched CLI
into an **authenticated remote tool/code-execution surface**.

Individually these patches only publish `__ccp*` globals for in-process
introspection. But `headless_bridge` accepts *external* requests (gated by the
`__ccpAuth` shared secret) and can route them at those globals. Combined blast
radius:

- `expose_tool_dispatch` + bridge → a remote caller who holds the bridge token
  can invoke **any tool the CLI has** (Bash, Write, Edit, file reads, MCP tools).
  That is arbitrary command and filesystem execution on the host, as the user
  running the CLI.
- `expose_api_client` + bridge → a remote caller can drive the Anthropic SDK
  client directly, spending your credits and exfiltrating whatever the client
  can read.
- `expose_agent_tool` + bridge → a remote caller can spawn sub-agents, which in
  turn have the full tool surface above — recursively.

**Permission gate disabled for invoked subagents.** Subagents dispatched via
`__ccpAgentTool.invoke()` run with the `canUseTool` permission callback hard-set
to `() => true` (see `expose_agent_tool.mjs`, the `_callSelf` dispatch). This is
deliberate: the background dispatch path is headless — it has no TUI surface to
render an allow/deny prompt to, so the real interactive callback would block
forever. The consequence is a **privilege escalation beyond the interactive
CLI**: every tool an invoked subagent runs (Bash, Write, Edit, MCP, …) executes
with **no allow/deny prompt at all**. There is no per-tool gate on this path.
This is a primary reason `expose_agent_tool` is **off by default**, and — when
combined with `headless_bridge` — why the bridge token is treated as
root-equivalent: holding it lets a remote caller spawn ungated, fully-privileged
subagents on the host.

In other words: with this combination, **anyone who obtains the bridge token
gets the same power over the host as the local user**. Treat the bridge token
as a root-equivalent credential. Only enable this combination on a host you
fully control, never expose the bridge port to an untrusted network, and rotate
the token (SIGHUP re-reads it) if it may have leaked. The compare path is
constant-time and length-independent, but that only protects the token, not the
blast radius behind it.

### Persona-swap and tool-injection are nonce-gated

Two ADK-facing write surfaces let *in-process* code change session behavior:
**tool injection** (`expose_tool_dispatch`'s `__ccpRegisterTool` /
`__ccpUnregisterTool`) and **persona swap** (`expose_system_prompt`'s
`__ccpSetSystemPrompt`). Both are now **nonce-gated**, mirroring the existing
`__ccpInvokeTool` dispatch gate:

- `expose_tool_dispatch` generates a load-time dispatch nonce and exposes it via
  `__ccpGetDispatchNonce()`. `__ccpInvokeTool`, `__ccpRegisterTool`, and
  `__ccpUnregisterTool` all require that nonce as their first argument — tool
  *invocation* and tool *registration* share one trust domain.
- `expose_system_prompt` generates its **own** load-time nonce
  (`__ccpGetSystemPromptNonce()`); `__ccpSetSystemPrompt(nonce, value)` requires
  it. Reading the active persona (`__ccpGetSystemPrompt()`) stays ungated —
  reading is not a privilege escalation, only writing is. Flipping the live
  persona is treated as *higher* authority than tool dispatch (it changes "who
  the agent is" mid-session), which is why it gets a distinct gate.

The gate stops **unguarded in-process code** — e.g. a compromised MCP server, or
any module that did not participate in the patch load — from silently registering
a tool or reassigning the persona by poking a global. It is *not* a defense
against the patches' intended trusted callers (the ADK, the bridge): a caller
that legitimately holds the nonce has full authority, so the bridge-token caveats
above still apply.

**Persona swap is a single global slot.** The host exposes exactly ONE live
persona override slot. The ADK backs *all* swaps — across every `createAdk()`
instance — with a single process-global LIFO stack whose entries record the
owning scope, so an out-of-order cross-instance restore is **refused** rather than
allowed to clobber another instance's live persona. Per-instance swap "isolation"
is therefore honest but shares that one slot: two instances cannot each privately
own the live persona simultaneously. The swap target is also **pinned** (sha256 of
its `systemPrompt`) at definition time so a later `defineAgent()` cannot rebind a
hostile persona under an allowlisted name (TOCTOU); a drifted hash refuses the
swap. See `packages/adk/HANDOFF.md` for the full ADK persona-swap trust model.

### `--allow-capabilities=all` is a full bypass

`--allow-capabilities=all` **disables the entire per-patch capability
acknowledgement gate in a single flag.** Instead of acknowledging
`network`, `exec`, `env`, `telemetry`, etc. per patch, `all` blanket-approves
every high-risk capability of every patch being applied — there is no remaining
prompt or refusal for network egress, subprocess execution, or env access.

Because it collapses the whole safety model to one token, it should **never
appear in scripts, CI pipelines, or shared Makefile targets**. In automation,
enumerate the exact capabilities you intend to allow
(`--allow-capabilities network,fs`) so the acknowledgement stays auditable and
a newly-introduced high-risk patch fails closed instead of being silently
waved through. Reserve `all` for interactive, one-off local use where a human
has just read the capability table.

### Paranoid / strict mode

`--paranoid` (a global flag — works on `ccpatch <in> <out>`, `ccpatch doctor`,
etc.) turns ccpatch's **silent-failure surfaces into opt-in-loud / fail-closed
ones**. It is the inverse of the default posture, which favours never disrupting
a working CLI over surfacing a problem.

Effects:

1. **Loud network/fetch subscriber errors (runtime).** The injected
   `fetch_interceptor` normally swallows a throwing subscriber and routes it to a
   debug sink that is silent unless `CLAUDE_DEBUG=1`. Paranoid mode makes that
   sink **always write the error to stderr** (prefixed `[ccp:bus][paranoid]`).
   The error is still *caught* — the CLI's network path is never disrupted — it
   is merely no longer invisible.

   *Mechanism:* `fetch_interceptor` runs inside the **patched CLI at runtime**,
   not in the patcher process, so the toggle is read at runtime from
   `process.env.CCPATCH_PARANOID === '1'`. When you pass `--paranoid` to the
   ccpatch CLI, it exports `CCPATCH_PARANOID=1` into the build process
   environment; anything the build spawns inherits it. You can also set
   `CCPATCH_PARANOID=1` directly in the environment that launches the patched
   CLI to surface these errors **without rebuilding**.

2. **Fail-closed native repack (build time).** Paranoid mode never forwards
   `--allow-unverified` to the native repacker (the post-repack smoke check stays
   REQUIRED — a binary that can't be verified is rejected rather than shipped),
   and it treats any `[repack:skip]` native grow-path degradation (patches
   dropped because the host can't grow the embedded JS region) as a **build
   failure** instead of a warning.

Default behaviour (swallow + silent, accept reduced patch set with a warning) is
unchanged when `--paranoid` is not set.

### Webhook egress (`CC_WEBHOOK_URL`)

The `webhook` patch, when enabled and `CC_WEBHOOK_URL` is set, sends
**unredacted conversation/event data outbound** to that URL — CLI args, working
directory, process id, and per-event payloads, with no redaction layer. The
patch restricts the destination scheme to `https:` (or `http://localhost` for
dev) and refuses anything else, but it does **not** filter what is sent. Point
it only at an endpoint you control and trust, and assume that endpoint sees the
full content of your session.

Beyond the scheme check, the patch also **rejects destinations that resolve to
private, loopback, link-local, or cloud-metadata hosts** — RFC-1918 ranges,
`127.0.0.0/8`, `0.0.0.0/8`, `169.254.0.0/16` (including the
`169.254.169.254` cloud-metadata endpoint), and the IPv6 equivalents
(`::1`, `fe80::/10`, `fc00::/7`, `::ffff:` mapped v4). `http://localhost` and
`127.0.0.1` / `[::1]` remain allowed as an explicit dev exception. This blocks
the obvious SSRF / metadata-exfil targets; it does **not** defend against
DNS-rebinding, so still only point it at endpoints you trust.

### Project-local `.env` injection (`dotenv_loader`)

The `dotenv_loader` patch loads `.env` from `CC_PROJECT_ROOT || process.cwd()`
into `process.env` before any other patch runs. Because a `.env` ships inside
whatever repo you clone or open, it is **attacker-controllable input**. Left
unrestricted, a hostile repo could silently stand up the bridge
(`CC_BRIDGE_TOKEN` / `CC_BRIDGE_ADDR`) or repoint all API traffic through an
MITM (`ANTHROPIC_BASE_URL`). To prevent this, the loader enforces a denylist:
it **refuses to set** `CC_BRIDGE_TOKEN`, `CC_BRIDGE_ADDR`, `ANTHROPIC_BASE_URL`,
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CC_WEBHOOK_URL` (so a hostile repo
cannot silently set an egress target for the `webhook` patch), and any key
matching `CC_*_TOKEN` from `.env`, emitting a warning when it skips one. These keys can still be set
in the shell — shell-set values always take precedence over `.env` regardless.
Note the denylist does not cover every conceivable sensitive var; review a
repo's `.env` before opening it in a patched CLI.

### Cache poisoning / cross-account replay (`cache_responses`)

The `cache_responses` patch (dev/testing only) writes full API response bodies
to `~/.cc-cache` keyed by a hash of the request. Treat that directory as
**trusted**: a writable cache dir is a response-injection (poisoning) surface,
since a cached entry is replayed verbatim in place of a real API call. The patch
applies several hardening measures: keys are **sha256** (not md5, which is
collision-trivial and enables predictable-path poisoning); an **auth/identity
dimension** (sha256 of the `Authorization` / `x-api-key` header) is mixed into
the key so a response cached under one account can never be replayed to a
different credential — the raw secret is hashed and never lands in any on-disk
path; and entries are written `0600` (owner-only). This remains a dev/testing
feature — do not enable it in any setting where the cache directory is shared or
writable by another principal.

## Systemic risk: upstream toolchain change (anchor extinction)

Every anchor-resolution tier — version-specific regexes, refmap symbol tables,
multi-tier fallback chains, `findFunctionByLiteral` AST anchors — shares one
unstated assumption about the shape of the upstream bundle: **string literals
survive minification intact, functions are textually contiguous, and the
brace-walker can find an enclosing function around a literal.** That assumption
holds for esbuild's current output. It is not guaranteed.

An upstream toolchain change — aggressive string concatenation/interning, a
different mangling scheme, code splitting into multiple chunks, bytecode or
snapshot embedding — would break **all patches simultaneously**, and no
fallback tier helps, because every tier shares the same textual-bundle
assumption. This is an accepted bet, not an oversight: the alternative
(full-fidelity parsing of a ~10 MB bundle per patch) was rejected on cost.

**Detection signal.** The nightly drift sweep (`drift-check.yml`, which probes
`@latest` plus every refmap'd version) lights up **entirely red in one run** —
every patch reporting anchor MISS at once, rather than the usual one-or-two
patch drift. `ccpatch doctor` against the new bundle shows the same all-MISS
pattern. Treat "all anchors missed on a new version" as a toolchain-change
event, not as N independent regressions.

**Response plan, in order:**

1. **Do not chase individual anchors.** Per-patch regex fixes are wasted work
   against a toolchain change; confirm the failure mode first with
   `ccpatch dissect` / `doctor` on the new bundle (changed format? split
   chunks? mangled literals?).
2. **Pin users to the last working version.** `SUPPORTED_VERSIONS.md` and the
   known-shas registry identify the last bundle every patch verified against;
   communicate that as the supported ceiling until re-targeting lands.
3. **Re-target the resolution layer, not the patches.** The patch corpus
   anchors through `runner/anchors.mjs` / refmaps / AST helpers precisely so
   the bundle-shape knowledge lives in one layer. The port is: teach
   `dissect`/refmap generation the new bundle shape, regenerate refmaps, and
   let the corpus follow.
4. **Triage the corpus by tier.** Core (12 patches) is re-validated first;
   extensions re-enable per-patch as their anchors verify. The capability ack
   gate and `verify` blocks already prevent a half-ported patch from shipping
   silently.

## Escape-hatch registry & audit policy

Every gate in ccpatch has a deliberate bypass. Each is individually justified;
collectively they are the attack surface a reviewer must audit, because a gate
with a permanent hole is only as strong as the discipline around the hole.
Canonical registry:

| Escape hatch | Bypasses | Scope | Legitimate use |
|---|---|---|---|
| `--allow-unacked` | capability ack gate (`ccpatch.yml ack:`) | build | first-run exploration before writing acks |
| `--allow-capabilities=<list>` | per-capability gate for listed caps | build | CI with enumerated caps (`network,env`) |
| `--allow-capabilities=all` | **entire** capability gate | build | interactive one-off only — never scripts/CI (see above) |
| `--allow-unverified` | post-build verify failures / native smoke check | build | debugging a drifted anchor locally |
| `CCPATCH_SKIP_SHA_CHECK=1` | known-shas input pinning (never an explicit `--expect-sha256`) | build | testing against a deliberately modified bundle |
| `CCPATCH_SKIP_LAUNCH_VERIFY=1` | launch-time bundle integrity check (`make start`) | launch | running a deliberately hand-edited bundle |
| `CCPATCH_NO_AUTOPIN=1` | first-verified-build auto-pin into known-shas | build | keeping a registry pristine while experimenting |
| `CCPATCH_NO_CACHE=1` | build cache | build | cache-corruption debugging (no security impact) |
| `CCPATCH_BEST_EFFORT=1` | required-patch failure → hard error | build | degraded-host builds |
| `allowOverlapWith` (manifest field) | per-phase conflict detection for the named pair | per-patch | known-benign overlapping injections |
| `ccpatch pin --force` | re-pin refusal for a known version | registry | intentional upstream re-release |

Audit policy:

- **Annual audit** (or on any security review): enumerate live usage with
  `node scripts/lint-escape-hatches.mjs` and reconcile against this table.
- **Unused for 12 months → delete the hatch.** A bypass nobody needs is pure
  attack surface.
- **Used routinely → the gate is miscalibrated.** Recurring `--allow-unacked`
  in scripts means acks should be written; recurring `allowOverlapWith` pairs
  mean the conflict detector needs a smarter rule. Fix the gate, don't
  normalize the bypass.
- **New hatches land here first.** A PR adding a bypass flag must add a row to
  this table in the same change (the lint enforces drift between code and
  table).

## How to disable a patch

Three options, any of them is fine:

- Edit `ccpatch.yml`: set the patch to `false` or comment the line out, then re-run `make patch-claude-code`.
- Pass an explicit list that excludes it: `make patch-claude-code PATCH=bun_shim,react_singleton,esm_compat,contracts,fetch_interceptor`.
- Use `--profile minimal` _(coming)_ to apply only `core/` infrastructure and bug fixes.

To audit what was actually injected, run `node bin/patch-cli.mjs <input.js> /tmp/out.js --dry-run` and read the diff.

---

## Output `.sha256` sidecar: integrity, not authenticity

Every build writes a `.sha256` sidecar next to the patched bundle
(`<output>.sha256`, see `runner/cli/cmd-build.mjs`). It records the sha256 of
the bytes ccpatch just wrote, and the build re-reads the file to confirm it
landed on disk uncorrupted.

**This sidecar provides INTEGRITY (corruption detection), NOT AUTHENTICITY.**
It is a self-computed hash written next to a self-written file: anyone who can
tamper with the bundle can also rewrite the sidecar to match. It is **not a
cryptographic signature** and does **not** protect against a local attacker —
or any process — that can write to the output directory. Its sole job is to
catch **accidental corruption** (a truncated write, a bad disk, a botched
copy), so a downstream consumer can detect that the bundle no longer matches
what the build produced. Treat a matching sidecar as "these bytes are intact",
never as "these bytes are trustworthy".

This is a deliberately weaker guarantee than the **INPUT bundle TOFU pinning**
(`storage/known-shas.json`, the `ccpatch pin` subcommand, and
`scripts/verify-bundle-sha.mjs`). That registry pins the sha256 of the *input*
Claude Code bundle out-of-band and is **fail-closed**: re-pinning a different
sha for a known version is **refused** unless you pass `--force`, so an upstream
bundle that silently changes under a known version is caught. Trust-on-first-use
pinning of a known-good input hash is a real (if first-use-bounded) authenticity
control on what goes *into* the build; the output `.sha256` sidecar is only an
intactness check on what comes *out*. Do not conflate the two.

---

## Third-party module trust

Third-party patch modules (installed via `ccpatch module install`) run with the
same in-process trust as built-in patches once enabled. Two points matter for
the threat model:

- **The module "signature" is a content hash, not authenticity.** The
  `signature` field in `ccpatch-module.json` is a hex sha256 over the sorted
  `patches/` tree (file content only). It proves **integrity** — that the tree
  matches a known digest — but says nothing about **who** authored it. There is
  no public-key authorship signature. Trust comes from pinning a known-good hash
  out-of-band, not from the field merely being present.

- **`--expect-sha256` is the trust anchor for remote installs.** When installing
  from a tarball, pass the content hash you obtained out-of-band:

  ```
  ccpatch module install https://example.com/my-patches-1.2.0.tgz \
    --expect-sha256 <hex-sha256>
  ```

  The installer refuses to proceed if the downloaded `patches/` tree doesn't
  hash to the value you supplied. Without `--expect-sha256` you are trusting the
  transport and the endpoint.

- **`http://` requires `--insecure`.** Plain HTTP offers no transport integrity,
  so the installer refuses an `http://` URL unless you explicitly pass
  `--insecure`. Prefer `https://` combined with `--expect-sha256`; reserve
  `--insecure` for a trusted LAN where you control both ends.

- **Capabilities are self-declared and imports happen in-process.** The
  `capabilities` array is honoured by the `--allow-capabilities` gate at install
  and apply time, but `module install` imports each patch to read those
  capabilities — that is *disclosure*, not sandboxing. Auditing the source under
  `modules/<name>/patches/` before enabling is the actual trust boundary.

- **Update channels are not signed by ccpatch.** A compromised `updateChannel`
  endpoint can serve a different tarball. Pin a known content hash locally if
  that matters.

See [docs/authoring-patches.md](./docs/authoring-patches.md#third-party-patch-modules)
for the install workflow and the `module verify` command.

---

## What ccpatch does NOT do

- No telemetry from the patcher or the patched bundle.
- No network calls from the patcher itself.
- No auto-update. You upgrade by `git pull` and re-running `make patch-claude-code`.
- No modification of files outside the input and explicitly chosen output path.
- No interception of Anthropic credentials beyond what Claude Code itself already does in-process.

If you find a patch that violates any of the above, that's a bug — please open an issue.
