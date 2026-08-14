# TESTING-CHECKLIST

**Summary (2026-07-20):** 60 shippable patches in `ccpatch.yml` (12 core + 48
extensions; plus 1 demo `_overlay_example` excluded from the test enumerator) —
**all 60 carry automated verification coverage**, so none are strictly
untested. Within that: **21 also have a dedicated behavioral/named test**, and
**39 are baseline-only** (their anchor→transform→verify triple is validated
generically, but no test exercises their runtime effect). CLI: **11 of 12
subcommands tested** (`outputs` has no dedicated test). Core runner/framework
subsystems and boot smoke tests are broadly covered.

## How coverage works here (read this first)

Two tiers of automated coverage exist, and most patches only have the first:

- **Baseline (every non-`_` patch):** `tests/patch-verification.test.mjs`
  enumerates **every** `.mjs` in `core/` + `extensions/` and runs Layers 1–4 on
  each (apply mutates input, re-apply is a byte-identical no-op, `verify.present`
  exists after apply, injected runtime surface registers, boot-registry splice is
  ordered/idempotent). `tests/all-patches-validate.test.mjs` validates every
  patch's registry/manifest shape. Any patch is reachable individually via
  `CCPATCH_TEST_PATCH=<name> npm run test:patch` (filters
  `patch-verification.test.mjs` by patch name). **So the per-patch test exists for
  every patch in the registry — it validates the patch's declared triple, not its
  behavior.**
- **Dedicated (only some patches):** a test file that exercises the patch's actual
  runtime behavior (or a named test for it). These are marked `[x]` below.

Legend: `[x]` = has a dedicated behavioral/named test · `[~]` = baseline verify
coverage only (Layers 1–4 + `CCPATCH_TEST_PATCH`, no dedicated behavioral test).

---

## Patches — Core (`core/`)

- [x] react_singleton — unify bundled React with host React (baseline Layers 1–4; exercised indirectly by boot suites)
- [x] esm_compat — CJS-IIFE→ESM wrap + react/ink preload (tested via boot-smoke / boot-tty / paranoid-mode / platform-degradation)
- [x] contracts — typed `__ccp*` provide/require registry (tested via contracts.test.mjs, repl.test.mjs, repack.test.mjs)
- [x] coverage_kernel — runtime hit counter for instrumented patches (tested via coverage.test.mjs)
- [x] overlay_loader — single anchor loading `ccpatch-overlay.mjs` (tested via overlay.test.mjs)
- [x] fetch_interceptor — fan-out fetch tee (tested via fetch-response-fidelity.test.mjs, paranoid-mode.test.mjs, policy_gate_consumer.test.mjs)
- [x] bun_shim — Bun polyfill for Node (tested via bun-polyfill.test.mjs, bun-api-scan.test.mjs, boot-smoke, boot-tty)
- [~] stdin_da1_leak — strip DA1/DA2 escape sequences from stdin (baseline only)
- [~] message_normalizer — guard display-item type crashes (baseline only)
- [~] project_root — projectRoot fallback so `.cc/commands/` loads (baseline only)
- [~] tool_result_error_content — non-empty content on is_error blocks (baseline only)
- [x] boot_banner — render ccpatch boot-log box (tested via boot-watchdog.test.mjs, diag-sink.test.mjs)

## Patches — Extensions (`extensions/`)

### Fixes (opinionated)
- [~] dotenv_loader — load `.env` before patches (baseline only)
- [~] hook_noise_mute — suppress noisy hook stderr (baseline only; appears as fixture in repack.test.mjs)
- [~] cache_ttl — force 1h prompt-cache TTL (baseline only)
- [~] grep_shadow — disable grep/find shadow injection (baseline only)
- [~] rate_limit — skip retries on subscription limits (baseline only)
- [~] large_content_guard — truncate oversized system-message content (baseline only)
- [~] recap_strip_hint — remove recap config hint (baseline only)
- [~] suppress_npm_deprecation — hide native-installer banner (baseline only)

### Command System
- [~] custom_commands — slash-command registry (baseline only)
- [~] slash_dispatch — route `/commands` from prompt bar (baseline only)
- [~] subagent_hooks_stub — no-op subagent event bus (baseline only)

### Feature Unlocks
- [x] durable_cron — force `isDurableCronEnabled()`→true (tested via at-selector.test.mjs, dissect.test.mjs, heal.test.mjs)
- [x] loop_dynamic — unlock self-pacing loop (tested via dissect.test.mjs, cmd-dissect.test.mjs)
- [x] unhide_features — expose client-gated features (tested via unhide-features-anchor.test.mjs, coordinate-frame.test.mjs)
- [~] extended_thinking — inject thinking/effort via env (baseline only)
- [x] force_thinking — force thinking when CC_THINKING set (tested via patch-kinds.test.mjs)
- [~] mcp_lazy — serve cached tools/list, refresh in background (baseline only)

### Observability
- [~] cost_tracker — token/cost in status bar (baseline only; appears as fixture in hot-reload.test.mjs)
- [~] context_budget_warn — inject context-full warning at 85% (baseline only)
- [~] tool_result_trim — truncate oversized tool_result blocks (baseline only)
- [~] tools_log — log tool calls/results via SSE (baseline only)
- [~] boost_project_commands — re-sort deprecated commands to top (baseline only)

### Expose Internals
- [x] expose_tool_dispatch — MCP tool registry + invoker (tested via capgate-required-caps.test.mjs, runner-hook-ordering.test.mjs, hot-reload.test.mjs)
- [x] expose_api_client — Anthropic SDK client via `__ccpApiClient` (tested via lint-anchors.test.mjs as anchor subject)
- [~] expose_submit_input — React submit callback via `__ccpSubmitInput` (baseline only)
- [~] expose_agent_tool — native AgentTool via `__ccpAgentTool` (baseline only; used as dep in capgate/adk tests)
- [x] expose_system_prompt — persona overlay via `__ccpSetSystemPrompt` (tested via policy_gate_consumer.test.mjs)
- [x] policy_gate — host-driven behavior gate (tested via policy-gate.test.mjs, policy_gate_consumer.test.mjs)
- [~] prime_agent_tool_on_boot — prime AgentTool at React mount (baseline only)
- [~] capture_interactive_request — capture first `/v1/messages` shape (baseline only; fixture in lint-capabilities.test.mjs)

### Optional (opt-in via env/flag)
- [~] model — change default model via CC_MODEL (baseline only)
- [~] block_tools — block specific tools via CC_BLOCKED_TOOLS (baseline only)
- [~] debug — verbose API/tool debug logging (baseline only; used as the canonical sample patch across cmd-* tests)
- [~] save_conversations — auto-save conversations to JSON (baseline only)
- [~] session_timer — track session time (baseline only)
- [~] webhook — send webhook on key events (baseline only)
- [~] cache_responses — cache API responses (baseline only)
- [~] input_bar_color — color prompt input bar border (baseline only)
- [ ] _overlay_example — demo: publish via sibling overlay file (excluded from enumerator; `_`-prefixed, no coverage)

### ADK (Agent Development Kit)
- [~] adk_hello_agent — register hello agent + adk_ping tool (baseline only)
- [x] adk_user_agents — load user-authored ADK modules (tested via adk-user-agents-security.test.mjs)
- [x] adk_handoff_demo — end-to-end ADK reference consumer (tested via patch-verification.test.mjs "COD-13" named tests)

### Verticals
- [x] event_bus — typed pub/sub `__ccpBus` (baseline; hook-size guard referenced in patch-helpers.test.mjs)
- [x] auth_token — shared-secret loader (tested via auth-token.test.mjs, headless-bridge-auth.test.mjs)
- [x] agent_lifecycle — emit turn/agent lifecycle events (tested via agent-lifecycle-turns.test.mjs)
- [~] agent_tree — parent→child subagent tree accounting (baseline only)
- [~] assistant_stream_events — re-emit SSE events to `__ccpBus` (baseline only)
- [x] headless_bridge — NDJSON control socket (tested via headless-bridge-auth.test.mjs)
- [x] standup_command — native `/standup` prompt rewrite (tested via standup_command.test.mjs)

---

## CLI Commands (`bin/patch-cli.mjs` → `runner/cli/`)

- [x] ack — acknowledge capabilities gate (tested via capabilities.test.mjs, capgate-required-caps.test.mjs)
- [x] build — patch a bundle (tested via cmd-build.test.mjs, plus build-cache.test.mjs)
- [x] coverage — report instrumented-patch coverage (tested via coverage.test.mjs)
- [x] diff — show patch diff (tested via fallback-diff.test.mjs, reversible.test.mjs — diff machinery)
- [x] dissect — bisect/inspect a patched bundle (tested via cmd-dissect.test.mjs, dissect.test.mjs)
- [x] doctor — diagnose patch/bundle health (tested via cmd-doctor.test.mjs)
- [x] explain — explain a patch/anchor (tested via explain.test.mjs)
- [x] module — module management (tested via cmd-module.test.mjs, module.test.mjs)
- [ ] outputs — list build outputs (no dedicated test found)
- [x] pin — pin bundle sha256 (tested via cmd-pin.test.mjs, auto-pin.test.mjs, known-shas.test.mjs)
- [x] revert — revert a patched bundle (tested via cmd-revert.test.mjs, reversible.test.mjs)
- [~] versions — list known versions (no dedicated cmd test; version resolution covered via per-version-dir.test.mjs, known-shas.test.mjs)

---

## Core Runner / Framework (`runner/`)

- [x] Runner (phase/dependsOn topo-sort, apply pipeline) — runner.test.mjs, runner-helpers.test.mjs, runner-hook-ordering.test.mjs
- [x] Verify engine (present/absent assertions) — verify-core.test.mjs, verify-batch.test.mjs, paranoid-mode.test.mjs
- [x] Anchor resolution (string/AST/at-selector/multi) — ast-anchor.test.mjs, at-selector.test.mjs, multi-anchor.test.mjs, lint-anchors.test.mjs
- [x] Conflict detection — conflict.test.mjs, conflict-prepend.test.mjs
- [x] Coordinate frame (span math) — coordinate-frame.test.mjs, coordinate-frame-invariant.test.mjs
- [x] Manifest schema/validators — manifest.test.mjs
- [x] Capability gate (ack + budgets) — capabilities.test.mjs, capgate-required-caps.test.mjs, lint-capabilities.test.mjs
- [x] Profiles / layer budgets — profiles.test.mjs, layer-profiles.test.mjs
- [x] Overlay builder / hot-reload — overlay.test.mjs, hot-reload.test.mjs
- [x] Boot registry / lifecycle — lifecycle.test.mjs, agents-dir.test.mjs
- [x] Heal (anchor drift repair) — heal.test.mjs
- [x] Refmap — refmap.test.mjs
- [x] Reverse-diff / reversibility — reversible.test.mjs, fallback-diff.test.mjs
- [x] Build cache — build-cache.test.mjs
- [x] Known-SHA pinning / auto-pin — known-shas.test.mjs, auto-pin.test.mjs
- [x] Per-version dirs / version resolver — per-version-dir.test.mjs
- [x] Patch kinds (declarative compile) — patch-kinds.test.mjs
- [x] Patch helpers — patch-helpers.test.mjs
- [x] Modules subsystem — module.test.mjs, cmd-module.test.mjs
- [x] Diagnostics sink — diag-sink.test.mjs
- [x] Platform degradation — platform-degradation.test.mjs
- [x] Contracts registry — contracts.test.mjs, lint-contracts.test.mjs
- [x] Registry lint — lint-registry.test.mjs
- [x] Scaffold-patch generator (`bin/scaffold-patch.mjs`) — scaffold-patch.test.mjs
- [x] Native SEA repack (`bin/repack-bundle.mjs`, macho/bun-sea) — repack.test.mjs, macho-repack.test.mjs, sea-extraction.test.mjs
- [x] Bun API surface scan — bun-api-scan.test.mjs
- [x] Shadow / dead-code detection — shadow.test.mjs

## Boot Smoke Tests

- [x] Boot smoke (--version/--help on patched bundle) — boot-smoke.test.mjs
- [x] TTY boot (interactive REPL render) — boot-tty.test.mjs
- [x] Boot watchdog (banner/timeout) — boot-watchdog.test.mjs

## Integration harnesses (non-`node:test` runners)

- [x] Round-trip integration — tests/integration_roundtrip.mjs (`npm run test:integration`)
- [x] Bridge smoke — tests/smoke_bridge.mjs, tests/bridge_host.mjs
- [x] Integration smoke — tests/smoke_integration.mjs
