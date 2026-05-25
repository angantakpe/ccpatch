[![drift-check](https://github.com/angantakpe/ccpatch/actions/workflows/drift-check.yml/badge.svg)](https://github.com/angantakpe/ccpatch/actions/workflows/drift-check.yml)

# ccpatch

Claude Code has no extension API for its internals. MCP adds tools — but it cannot touch what lives inside the process: the tool list Claude is offered, the feature flags baked into the bundle, the UI layer, the agent loop, or the module-scoped state that drives the harness.

ccpatch solves that. It injects scripts directly into `cli.js` so you can alter behavior that is otherwise unreachable:

- **Modify the tool list** before it is sent to the API — add, remove, or reshape tools without Claude knowing
- **Flip internal feature flags** (`loop_dynamic`, `durable_cron`, `extended_thinking`) that are boolean checks hardcoded in the bundle — no proxy or wrapper can reach these
- **Intercept user input** at the submit level, before the harness processes it — add native slash commands indistinguishable from built-ins
- **Access internal conversation state** — the agent loop, turn history, and module-scope variables that are never serialized or exposed
- **Poke holes in the module boundary** — `expose_tool_dispatch`, `expose_api_client`, `expose_submit_input` let external scripts call into the running CLI process
- **Patch the UI** — React/Ink component tree, input bar rendering, terminal output

ccpatch is not a fork. It ships **no Anthropic code**. It transforms a copy of the Claude Code CLI that is already installed on your machine.

---

## How it works

- **Anchor → transform → verify.** Each patch declares a stable string anchor (or AST anchor via windowed Acorn parse), a transform function over the bundle text, and a `verify.present` / `verify.absent` assertion that runs immediately after apply. Anchor misses are logged with fuzzy candidates so drift is diagnosable, not silent.
- **Shims-as-patches.** Substantial logic lives in real `.mjs` files under `core/` and `extensions/`. Patches inject a small wrapper at the anchor that calls into the shim, so contributors edit normal JavaScript instead of escaped patch strings.
- **Phase-based runner.** Patches declare `phase: pre | main | post` and optional `dependsOn`. The runner topo-sorts within each phase and enforces that dependencies live in the same or an earlier phase.
- **Native binary repack.** For versions shipped as a Bun-compiled binary, ccpatch extracts the embedded JS, patches it, and repacks via `node-lief`. The patched JS is padded to the original region size so the binary stays byte-for-byte the same length — no offset fixups needed.

---

## Install

Requires Node.js 20+ and either Bun or npm.

```
git clone https://github.com/angantakpe/ccpatch.git ccpatch
cd ccpatch
bun install        # or: npm install
```

> **Bun users:** `node-lief` (required for native binary repack) uses a postinstall build script that Bun blocks by default. Run `bun pm trust node-lief` after install if you plan to use `patch-claude-code-native`. The `npm install` path runs postinstall automatically.

The Makefile auto-detects the locally installed `claude` binary's version. Override with `VERSION=x.y.z` on any target.

---

## Quick start

Apply every patch enabled in `ccpatch.yml` to your locally installed Claude Code version:

```
make patch-claude-code
```

Patch a specific version and write to a custom path:

```
make patch-claude-code VERSION=2.1.148 OUTPUT=./my-cli.js
```

Override the YAML and apply an explicit list of patches:

```
make patch-claude-code PATCH=fetch_interceptor,fix_bun_shim,cost_tracker
```

Preview the diff without writing the output:

```
node bin/patch-cli.mjs <input.js> <output.js> --dry-run
```

List every patch that's loadable:

```
make patch-list
```

Patch a native (Bun-compiled) Claude Code binary end-to-end:

```
make patch-claude-code-native VERSION=2.1.148
```

> **Prerequisite:** `esm_compat` and `fix_bun_shim` must be disabled in `ccpatch.yml` (or excluded from `PATCH=`) before running the native pipeline. Those patches rewrite the CJS wrapper for Node.js and produce output that cannot be embedded back into a Bun SEA binary.

Run the patch verification test suite:

```
make test-patches
```

### Profiles _(coming)_

A `--profile minimal | standard | power` selector is planned to bundle curated patch sets. For now, edit `ccpatch.yml` or pass `PATCH=` explicitly.

### Drift check

```
node bin/patch-cli.mjs doctor <bundle> --version <x.y.z>
```

Reports patches whose anchors have drifted in a new Claude Code release. Fuzzy candidates are logged to `storage/outputs/anchor-drift.jsonl` with scores and offsets so re-anchoring is a targeted lookup, not a hunt.

---

## Patch categories

The current patch set, grouped by intent. Full list and toggles live in `ccpatch.yml`.

| Category | Patches |
| --- | --- |
| **Infrastructure** (`core/`) | `react_singleton`, `esm_compat`, `contracts`, `fetch_interceptor` |
| **Bug fixes** (`core/`) | `fix_bun_shim`, `fix_stdin_da1_leak`, `fix_message_normalizer`, `fix_project_root`, `tool_result_error_content` |
| **Fixes / QoL** (`extensions/`) | `dotenv_loader`, `hook_noise_mute`, `fix_cache_ttl`, `fix_grep_shadow`, `rate_limit`, `large_content_guard`, `recap_strip_hint`, `input_bar_color` |
| **Feature unlocks** | `durable_cron`, `loop_dynamic`, `plan_mode_interview` _(no-op on recent versions — upstream removed the flag)_, `unhide_features`, `extended_thinking`, `force_thinking`, `mcp_lazy` |
| **Command system** | `custom_commands`, `slash_dispatch`, `subagent_hooks_stub` |
| **Observability** | `cost_tracker`, `context_budget_warn`, `tool_result_trim`, `tools_log`, `boost_project_commands`, `session_timer`, `debug` |
| **Expose internals** | `expose_tool_dispatch`, `expose_api_client`, `expose_submit_input`, `expose_agent_tool`, `prime_agent_tool_on_boot`, `capture_interactive_request` |
| **Optional integrations** | `model`, `block_tools`, `save_conversations`, `webhook`, `cache_responses` |

By default only `core/` infrastructure and bug fixes are enabled. Extensions are opt-in via `ccpatch.yml`.

---

## Compatibility & safety

- Patches run inside your local Claude Code process. They share the same trust boundary as the CLI itself — anything the CLI can do, an enabled patch can also do.
- ccpatch makes **no network calls** from the patcher and ships **no telemetry**.
- ccpatch ships **no Anthropic source code** and is not affiliated with, sponsored by, or endorsed by Anthropic.
- See [THREAT_MODEL.md](./THREAT_MODEL.md) for a per-patch breakdown of what each touches, reads, and sends.
- See [SUPPORTED_VERSIONS.md](./SUPPORTED_VERSIONS.md) for the upstream versions exercised in CI and known bundle hashes.
- See [NOTICE](./NOTICE) for trademark and terms-of-service notes.

When Anthropic ships a new Claude Code version, anchors may drift. The runner logs near-miss candidates to `storage/outputs/anchor-drift.jsonl` so the relevant patch can be re-anchored quickly. Most patches use stable string literals (e.g. feature-flag keys) rather than minified identifiers, which keeps drift surface small.

---

## Security

Report vulnerabilities privately via GitHub Security Advisories or the email
in [SECURITY.md](./SECURITY.md). Please do not open public issues for
security reports.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the patch contract, the step-by-step "add a new patch" walkthrough, and the PR checklist.

---

## License

MIT. See [LICENSE](./LICENSE).
