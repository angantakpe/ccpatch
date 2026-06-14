[![drift-check](https://github.com/angantakpe/ccpatch/actions/workflows/drift-check.yml/badge.svg)](https://github.com/angantakpe/ccpatch/actions/workflows/drift-check.yml)

# ccpatch

ccpatch injects scripts into Claude Code's `cli.js` to extend and alter its behavior from within the process:

- **Modify the tool list** before it is sent to the API — add, remove, or reshape tools
- **Flip internal feature flags** (`loop_dynamic`, `durable_cron`, `extended_thinking`) that are boolean checks hardcoded in the bundle — note that flipping a client-side flag only unlocks locally gated behavior; some flags gate capabilities that are also controlled server-side or by your account tier, so enabling the flag does not guarantee the feature works
- **Intercept user input** at the submit level, before the harness processes it — add native slash commands
- **Access internal conversation state** — the agent loop, turn history, and module-scope variables
- **Expose internal APIs** — `expose_tool_dispatch`, `expose_api_client`, `expose_submit_input` let external scripts call into the running CLI process
- **Patch the UI** — React/Ink component tree, input bar rendering, terminal output

ccpatch is not a fork. It ships **no Anthropic code**. It transforms a copy of the Claude Code CLI that is already installed on your machine.

---

## How it works

- **Anchor → transform → verify.** Each patch declares a stable string anchor (or AST anchor via windowed Acorn parse), a transform function over the bundle text, and a `verify.present` / `verify.absent` assertion that runs immediately after apply. Anchor misses are logged with fuzzy candidates so drift is diagnosable, not silent.
- **Shims-as-patches.** Substantial logic lives in real `.mjs` files under `core/` and `extensions/`. Patches inject a small wrapper at the anchor that calls into the shim, so contributors edit normal JavaScript instead of escaped patch strings.
- **Phase-based runner.** Patches declare `phase: pre | main | post` and optional `dependsOn`. The runner topo-sorts within each phase and enforces that dependencies live in the same or an earlier phase.
- **Native binary repack.** For versions shipped as a Bun-compiled binary, ccpatch extracts the embedded JS, patches it, and splices the patched JS back into the binary at the original byte offset (direct buffer rewrite — no `node-lief`). When the patched JS is *smaller* than the original region it is padded with insignificant whitespace; when it is the *same* size it is spliced as-is. When it is *larger* — which can happen because patches add code — ccpatch decodes Bun's `StandaloneModuleGraph` and rewrites every blob-relative offset (the `payload_len` header, `byte_count`, module-record `StringPointer`s, and the ELF section/segment offsets) by the growth delta, then gates the result on a smoke check that the repacked binary boots the embedded entrypoint (`bin/bun-sea-graph.mjs`). This grow path is implemented for ELF (linux-x64) and thin Mach-O (darwin-arm64/x64) Bun binaries; fat/universal Mach-O (thin it to the target slice first) and PE (Windows) growth still **fail loudly** rather than risk corruption, and those targets fall back to the plain-JS path or a reduced patch set. Growing a Mach-O binary invalidates and **strips** its code signature, so the emitted darwin binary is **unsigned** — re-sign before distribution on a darwin host (`codesign -s - --force <output>` for ad-hoc, or with a Developer ID). ccpatch does not forge signatures. Native repack now **fails closed**: the post-repack smoke check is required and Bun-version drift aborts the build; pass `--allow-unverified` (local dev) to downgrade these to warnings. This rests on Bun's **undocumented, unversioned** SEA trailer format (the `VALIDATED_BUN_VERSIONS` gate is a proxy for "trailer layout unchanged"), so treat native repack as a **second-class, best-effort path** — do not build features that assume it succeeds; it may fall back to plain-JS or a reduced patch set. See [docs/native-repack-notes.md](docs/native-repack-notes.md) for the full support status and fencing.

---

## Install

Requires Node.js 20+ and either Bun or npm.

**Quick path (no clone) — run it straight from npm:**

```
npx @codehornets/ccpatch doctor <path-to-cli.js>   # read-only anchor-health check
npx @codehornets/ccpatch <input.js> <output.js>    # apply patches to a bundle
```

`npx @codehornets/ccpatch --help` lists every subcommand. The published package ships
the `ccpatch` runner, `ccpatch.yml`, and the patch sources, so the one-shot
`npx` invocation works without a checkout — handy for CI or a quick `doctor`
run. Clone the repo (below) when you want the `make` wrappers,
auto-version-detection, the TUI, or to author new patches.

**Full checkout (recommended for day-to-day work):**

```
git clone https://github.com/angantakpe/ccpatch.git ccpatch
cd ccpatch
bun install        # or: npm install
```

> **Native repack** (`patch-claude-code-native`) runs entirely on Node's built-in `fs`/`Buffer` plus the in-repo `tools/bun-decompiler` — there are no native build dependencies to trust, so a plain `bun install` / `npm install` is sufficient.

The Makefile auto-detects the locally installed `claude` binary's version. Override with `VERSION=x.y.z` on any target.

---

## Which entry point should I use?

There are three layers, and they wrap each other: **`make` targets → `bin/patch-cli.mjs` → the runner (`runner/`)**. `bin/patch-cli.mjs` *is* the `ccpatch` CLI (it just calls `runPatchCli` in `runner/cli.mjs`); the `make` targets are thin wrappers that invoke it with the version auto-detected and the right arguments filled in. Reach for the highest layer that does what you need:

| Task | Canonical path | Notes |
| --- | --- | --- |
| Apply patches | `make patch-claude-code` | Auto-detects the installed `claude` version + standard profile. Drop to `node bin/patch-cli.mjs <in> <out>` only when you need an explicit input/output path or a flag the target doesn't expose. |
| Drift / health check | `make doctor` | Read-only anchor-health check against the installed bundle (wraps `bin/patch-cli.mjs doctor`). |
| Coverage | `make patch-coverage` | Apply + smoke-run + cross-reference apply-time results with runtime hits (wraps `bin/patch-cli.mjs coverage`). |
| Revert a patched bundle | `node bin/patch-cli.mjs revert <bundle>` | No `make` wrapper — restores each patched region from the recorded pre-patch sha. |
| Author a new patch | `make new-patch NAME=my_feature` | Scaffolds a manifest-valid patch stub (wraps `bin/scaffold-patch.mjs`). Add `KIND=prefix\|free\|postfix\|transpiler\|splice\|flag` and `CATEGORY=extension\|core`. The scaffolder prints the exact single-patch dry-run command to iterate with. |
| Interactive TUI | `node bin/patch-tui.mjs` | Menu-driven front-end over the same subcommands (apply, doctor, diff, …) — handy for browsing/toggling patches without memorizing flags. Run with `--help` for details. |
| Everything else | `node bin/patch-cli.mjs <subcommand>` | `explain`, `capabilities`, `diff`, `heal`, `fallback-capture`, … — subcommands without a dedicated `make` target. |

Rule of thumb: prefer `make` for day-to-day work; drop to `bin/patch-cli.mjs` when you need a subcommand or argument the target doesn't pass through; touch the runner modules only when authoring or debugging patches.

> **npm scripts mirror the `make` targets.** `package.json` exposes `npm run test:patches`, etc., which run the same checks as the corresponding `make` target. Both spellings work in both build systems — `npm run test:patches` and `npm run test-patches` are aliases, as are `make test-patches` and `make test:patches` (and likewise for the `lint:dead` / `lint-dead` and `lint:unused` / `lint-unused` pairs). Use whichever fits your workflow.

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
make patch-claude-code PATCH=fetch_interceptor,bun_shim,cost_tracker
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

> **Prerequisite:** `esm_compat` and `bun_shim` must be disabled in `ccpatch.yml` (or excluded from `PATCH=`) before running the native pipeline. Those patches rewrite the CJS wrapper for Node.js and produce output that cannot be embedded back into a Bun SEA binary.

Run the patch verification test suite:

```
make test-patches
```

Run the interactive pty boot smoke (the suite's only tier that boots the real TUI):

```
make test-tty     # pty boot smoke against the newest bundle in releases/ (skips without python3 or a bundle)
make canary       # build the current release if needed, then run the pty boot smoke against it
```

The headless tiers (verify strings, `--version` boot smoke, daemon round-trip) all exit before the interactive TUI initializes, so a bundle can pass every one of them and still deadlock the moment a user actually opens it — that is exactly how two real boot hangs once shipped through a green suite. `test-tty` closes that gap: a python3 helper (`tests/helpers/pty-boot-probe.py`) forks the patched bundle in a real pty, answers the terminal capability queries boot blocks on (DA1, XTVERSION, OSC 11, CPR, DECRQM), runs it in a pre-trusted hermetic `$HOME`, and asserts a UI frame renders. It runs as part of `npm run test:all` and skips cleanly when python3 or a patched bundle is missing.

`make canary` is the only tier that can catch **server-side feature-gate flips**: upstream can turn a code path on per-account (e.g. `tengu_pewter_brook` enabled the fullscreen TUI with zero bundle change), so a bundle that booted yesterday can hang today without a single byte differing. Run `make canary` before adopting a new upstream version — and any time boot behavior changes with no local change to explain it.

### Profiles

`--profile <name>` (or `-p`) bundles a curated patch set defined under `profiles:` in `ccpatch.yml`. When set, only the patches listed in that profile are applied — the per-patch `enabled:` flags in `ccpatch.yml` are ignored for that run. When omitted, behaviour falls back to the `ccpatch.yml` enabled flags.

`make patch-claude-code` defaults to the **standard** profile. Override with `PROFILE=` (or disable with `PROFILE=`, empty):

```
make patch-claude-code                  # standard profile (default)
make patch-claude-code PROFILE=minimal  # bug fixes + minimum infra
make patch-claude-code PROFILE=power    # every patch listed in ccpatch.yml
make patch-claude-code PROFILE=         # no profile — use ccpatch.yml enabled flags
```

Directly via the CLI:

```
node bin/patch-cli.mjs <input.js> <output.js> --profile standard
```

The three curated profiles:

| Profile | Intent | Contents |
| --- | --- | --- |
| **minimal** | Bug fixes plus the minimum infrastructure those fixes need to run. | `react_singleton`, `esm_compat`, `contracts`, `overlay_loader`, `fetch_interceptor`, `bun_shim`, `stdin_da1_leak`, `message_normalizer`, `project_root`, `tool_result_error_content`, `subagent_hooks_stub` |
| **standard** _(default)_ | `minimal` plus quality-of-life features (model/command system, thinking unlocks, context guards, MCP lazy-load). | everything in `minimal`, plus `input_bar_color`, `model`, `custom_commands`, `slash_dispatch`, `context_budget_warn`, `recap_strip_hint`, `unhide_features`, `extended_thinking`, `force_thinking`, `tool_result_trim`, `large_content_guard`, `hook_noise_mute`, `mcp_lazy`, `dotenv_loader`, `block_tools` |
| **power** | Every patch listed under `patches:` in `ccpatch.yml` — all features, observability, exposed internals, and optional integrations. | the full patch set (infrastructure, bug fixes, QoL, feature unlocks, command system, observability, exposed internals, and integrations such as `cost_tracker`, `webhook`, `save_conversations`, `cache_responses`) |

Two additional vertical profiles ship for automation use cases: **daemon** (drive the running CLI headlessly via the event bus) and **orchestrator**. Profile membership is the source of truth in `ccpatch.yml`; an unknown patch name in a profile is skipped with a warning.

`doctor` and `capabilities` accept the same `--profile` flag (`make doctor PROFILE=standard`). An explicit `PATCH=name1,name2` list bypasses the profile entirely.

### Drift check

```
node bin/patch-cli.mjs doctor <bundle> --version <x.y.z>
```

Reports patches whose anchors have drifted in a new Claude Code release. Fuzzy candidates are logged to `storage/outputs/anchor-drift.jsonl` with scores and offsets so re-anchoring is a targeted lookup, not a hunt.

### Build failure modes

A patch that declares a real `verify.present` (it has a positive thing to inject) but produces **no change** has silently failed — its anchor almost certainly drifted. By default this is now a **build failure**: the build prints the no-op, exits non-zero, and the end-of-run summary reports a `No-op:` count. Patches that declare only `verify.absent` (a desired end-state, not a transform) keep the lenient "no-change is fine" semantics.

Pass `--best-effort` (or set `CCPATCH_BEST_EFFORT=1`) to restore the older lenient behaviour — a `verify.present` no-op is downgraded to a warning and the build continues:

```
node bin/patch-cli.mjs <input.js> <output.js> --best-effort
```

When `apply()` no-ops but a stored unified diff (`fallbackDiff`) still applies, the patch is recorded as **applied via stale fallback diff** — a loud, separately-counted outcome (the summary shows a `Stale fallback:` count). The anchors have drifted even though the textual diff still landed, so fix the anchors. Under `--strict` a stale-fallback apply is **fatal**; in the default mode it applies but warns prominently.

---

## Patch categories

The current patch set, grouped by intent. Full list and toggles live in `ccpatch.yml`.

| Category | Patches |
| --- | --- |
| **Infrastructure** (`core/`) | `react_singleton`, `esm_compat`, `contracts`, `fetch_interceptor` |
| **Bug fixes** (`core/`) | `bun_shim`, `stdin_da1_leak`, `message_normalizer`, `project_root`, `tool_result_error_content` |
| **Fixes / QoL** (`extensions/`) | `dotenv_loader`, `hook_noise_mute`, `cache_ttl`, `grep_shadow`, `rate_limit`, `large_content_guard`, `recap_strip_hint`, `input_bar_color` |
| **Feature unlocks** | `durable_cron`, `loop_dynamic`, `unhide_features`, `extended_thinking`, `force_thinking`, `mcp_lazy` |
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
- Patches that declare `network`, `exec`, or `env` capabilities are gated by an `ack:` block in `ccpatch.yml`. Builds fail until you acknowledge each capability per patch (e.g. `fetch_interceptor: [network]`).
- Acking is a one-line attestation that you've read THREAT_MODEL.md for that patch. Pass `--allow-unacked` to bypass the gate (legacy warn-only mode).
- See `ccpatch.yml`'s `ack:` block for the shipped defaults that cover the always-on core patches.
- See [SUPPORTED_VERSIONS.md](./SUPPORTED_VERSIONS.md) for the upstream versions exercised in CI and known bundle hashes. Versions not listed there will trigger anchor-drift warnings on first run — this is expected and handled by the drift log / `doctor` flow, not a hard failure.
- See [NOTICE](./NOTICE) for trademark and terms-of-service notes.

When Anthropic ships a new Claude Code version, anchors may drift. The runner logs near-miss candidates to `storage/outputs/anchor-drift.jsonl` so the relevant patch can be re-anchored quickly. Most patches use stable string literals (e.g. feature-flag keys) rather than minified identifiers, which keeps drift surface small.

---

## TUI — read-only patch browser

```
node bin/patch-tui.mjs
```

The TUI is a **read-only patch browser**: it lists every loadable patch with its
enabled/ack state and the latest anchor drift, and lets you expand a patch to
inspect its manifest. It never mutates `ccpatch.yml` or any patch file. It is
intentionally narrow — for the rich operations (apply, `doctor`, `heal`,
`capabilities`, `coverage`, `module`, `repl`, `revert`/`diff`, …) use the CLI
(`node bin/patch-cli.mjs <command>`). Run `node bin/patch-tui.mjs --help` for
keybindings.

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
