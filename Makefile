-include .env
export

include scripts/mk/vars.mk
include scripts/mk/cli.mk

.PHONY: help refmap refmap-check smoke-bridge smoke-integration \
        smoke-integration-roundtrip test-tty canary \
        bridge-host bridge-host-stop bridge-tail bridge-submit \
        verticals-check lint lint-dead lint-unused lint-registry lint-capabilities lint-contracts \
        lint-ordering lint-honesty \
        test\:patches test\:patch test\:tty lint\:dead lint\:unused \
        lint\:registry lint\:capabilities lint\:contracts lint\:ordering lint\:honesty heal

# ── Naming-drift aliases ────────────────────────────────────────────────────
# Kill the spelling drift between the two build systems: every operation that
# exists in BOTH make and npm is reachable under BOTH spellings.
#   make test-patches  ==  make test:patches   (npm: test:patches / test-patches)
#   make lint-dead     ==  make lint:dead      (npm: lint:dead    / lint-dead)
#   make lint-unused   ==  make lint:unused    (npm: lint:unused  / lint-unused)
# GNU make accepts a literal colon in a target name when it is backslash-escaped.
# The dash-spelled targets these forward to live in scripts/mk/cli.mk
# (test-patches) and below in this file (lint-dead, lint-unused). package.json
# carries the mirror dash-spelled npm scripts.
test\:patches: test-patches ## Alias for test-patches (npm-style spelling)
test\:patch: test-patch ## Alias for test-patch (npm-style spelling): make test:patch NAME=debug
test\:tty: test-tty ## Alias for test-tty (npm-style spelling)
lint\:dead: lint-dead ## Alias for lint-dead (npm-style spelling)
lint\:unused: lint-unused ## Alias for lint-unused (npm-style spelling)
lint\:registry: lint-registry ## Alias for lint-registry (npm-style spelling)
lint\:capabilities: lint-capabilities ## Alias for lint-capabilities (npm-style spelling)
lint\:contracts: lint-contracts ## Alias for lint-contracts (npm-style spelling)
lint\:ordering: lint-ordering ## Alias for lint-ordering (npm-style spelling)
lint\:honesty: lint-honesty ## Alias for lint-honesty (npm-style spelling)

# ── Verticals: testing the headless bridge + agent tree ─────────────────────

# Default socket / token for the interactive `bridge-host` + tier-3 smoke.
# Override on the command line: make bridge-host CC_BRIDGE_ADDR=tcp://127.0.0.1:7878
CC_BRIDGE_ADDR  ?= unix:/tmp/ccpatch.sock
# The bridge token is root-equivalent: anyone presenting it can submit prompts
# and dispatch tools in the running CLI. It is therefore never echoed to stdout
# and never given a guessable fallback: bridge-host generates a random token
# into a 0600 file and the client targets (bridge-submit / bridge-tail) read it
# back from that same file — which also means a second shell's `make
# bridge-submit` authenticates against the running host (the old per-invocation
# `?= $(shell openssl rand …)` default generated a DIFFERENT token in each make
# run, so cross-shell submits could never match). Set CC_BRIDGE_TOKEN explicitly
# to pin your own secret instead; missing openssl is a hard error, not a stub.
CC_BRIDGE_TOKEN      ?=
CC_BRIDGE_TOKEN_FILE ?= storage/outputs/bridge-host.token

smoke-bridge: ## Tier 1 — NDJSON protocol smoke against a stubbed host (no patched CLI)
	@node tests/smoke_bridge.mjs

bridge-host: ## Tier 2 — boot a stub bridge host so you can prod it with ccpatch-bridge / nc
	@echo "[bridge-host] CC_BRIDGE_ADDR=$(CC_BRIDGE_ADDR)"
	@mkdir -p $(dir $(CC_BRIDGE_TOKEN_FILE))
	@if [ -n "$(CC_BRIDGE_TOKEN)" ]; then \
		umask 177 && printf '%s\n' "$(CC_BRIDGE_TOKEN)" > $(CC_BRIDGE_TOKEN_FILE); \
	else \
		command -v openssl >/dev/null 2>&1 || { \
			echo "[bridge-host] ERROR: openssl not found and CC_BRIDGE_TOKEN unset."; \
			echo "[bridge-host] The bridge token is root-equivalent — refusing to start with a guessable one."; \
			echo "[bridge-host] Install openssl, or pass CC_BRIDGE_TOKEN=<secret> explicitly."; \
			exit 1; }; \
		umask 177 && openssl rand -hex 16 > $(CC_BRIDGE_TOKEN_FILE); \
	fi
	@chmod 600 $(CC_BRIDGE_TOKEN_FILE)
	@echo "[bridge-host] token written to $(CC_BRIDGE_TOKEN_FILE) (0600, not echoed) — bridge-submit/bridge-tail read it from there"
	@CC_BRIDGE_ADDR=$(CC_BRIDGE_ADDR) CC_BRIDGE_TOKEN=$$(head -n1 $(CC_BRIDGE_TOKEN_FILE)) node tests/bridge_host.mjs

bridge-host-stop: ## Tier 2 — kill any stray bridge-host and unlink the unix socket
	@-pkill -f tests/bridge_host.mjs 2>/dev/null || true
	@if echo "$(CC_BRIDGE_ADDR)" | grep -q '^unix:'; then \
		SOCK=$$(echo $(CC_BRIDGE_ADDR) | sed 's/^unix://'); \
		rm -f "$$SOCK" && echo "removed $$SOCK"; \
	fi
	@rm -f $(CC_BRIDGE_TOKEN_FILE) && echo "removed $(CC_BRIDGE_TOKEN_FILE)"

# Shared token resolution for the client targets: explicit CC_BRIDGE_TOKEN
# wins; otherwise read the 0600 file bridge-host wrote. No token → hard error
# (never fall back to anything guessable).
define resolve_bridge_token
	TOKEN="$(CC_BRIDGE_TOKEN)"; \
	if [ -z "$$TOKEN" ] && [ -f $(CC_BRIDGE_TOKEN_FILE) ]; then TOKEN=$$(head -n1 $(CC_BRIDGE_TOKEN_FILE)); fi; \
	if [ -z "$$TOKEN" ]; then \
		echo "[bridge] ERROR: no CC_BRIDGE_TOKEN set and no $(CC_BRIDGE_TOKEN_FILE) found."; \
		echo "[bridge] Start the host first (make bridge-host) or pass CC_BRIDGE_TOKEN=<secret>."; \
		exit 2; \
	fi
endef

bridge-submit: ## Tier 2 — send PROMPT to the running bridge-host: make bridge-submit PROMPT="hi"
	@test -n "$(PROMPT)" || (echo "usage: make bridge-submit PROMPT=\"...\"" && exit 2)
	@$(resolve_bridge_token); \
	CC_BRIDGE_ADDR=$(CC_BRIDGE_ADDR) CC_BRIDGE_TOKEN=$$TOKEN \
		node tools/ccpatch-bridge.mjs submit "$(PROMPT)"

bridge-tail: ## Tier 2 — tail bus events from the running bridge-host
	@$(resolve_bridge_token); \
	CC_BRIDGE_ADDR=$(CC_BRIDGE_ADDR) CC_BRIDGE_TOKEN=$$TOKEN \
		node tools/ccpatch-bridge.mjs tail '*'

patch-daemon: ## Tier 3 prep — patch cli with the daemon profile (event_bus + bridge + emits)
	@mkdir -p releases/$(VERSION)
	@SRC=$(INPUT); \
	[ ! -f "$$SRC" ] && SRC=storage/archives/claude-code-v$(VERSION)/cli.js; \
	[ ! -f "$$SRC" ] && SRC=storage/archives/claude-code-v$(VERSION)/cli.v$(VERSION).cjs; \
	[ ! -f "$$SRC" ] && SRC=$$(ls storage/archives/claude-code-v$(VERSION)/cli*.cjs 2>/dev/null | head -1); \
	if [ -z "$$SRC" ] || [ ! -f "$$SRC" ]; then echo "ERROR: no cli source for v$(VERSION) — run 'make download VERSION=$(VERSION)' first"; exit 2; fi; \
	echo "[patch-daemon] using $$SRC"; \
	node bin/patch-cli.mjs "$$SRC" $(OUTPUT) --profile daemon --allow-unacked

smoke-integration: ## Tier 3 — drive a real patched CLI over the bridge (uses CCPATCH_INTEGRATION_CLI if set, else latest releases/)
	@node tests/smoke_integration.mjs

smoke-integration-roundtrip: ## Tier 3 — boot a daemon bundle, drive a full agent-loop + tool-dispatch round-trip with a stubbed API (skips cleanly if no daemon bundle)
	@node tests/integration_roundtrip.mjs

# ── Interactive pty boot smoke + canary ─────────────────────────────────────
# Every headless tier exits before the interactive TUI initializes — which is
# how the v2.1.175 boot deadlocks (Bun-only fullscreen PTY host; swallowed
# require('ws') rejection) shipped through a green suite. test-tty boots the
# patched bundle in a REAL pty (python3 helper answers terminal capability
# queries) in a pre-trusted hermetic $HOME and asserts a UI frame renders.
# Skips cleanly when python3 or a patched bundle is missing.
test-tty: ## Tier 4 — interactive pty boot smoke: assert a real UI frame renders (skips without python3/bundle)
	node --test tests/boot-tty.test.mjs

# canary = build-if-needed + pty boot smoke against the current release.
# This is the ONLY tier that catches server-side feature-gate flips (e.g.
# tengu_pewter_brook turning the fullscreen TUI on with ZERO bundle change),
# because it boots the real interactive path against live account state.
# Run it before adopting a new upstream version — and after gate-flip
# suspicion — not just on code changes.
canary: ## Tier 4 — build (if needed) + pty boot smoke against the current release; catches server-side gate flips
	@if [ ! -f $(OUTPUT) ]; then \
		echo "[canary] $(OUTPUT) not found — building..."; \
		$(MAKE) patch-claude-code VERSION=$(VERSION); \
	fi
	CCPATCH_TTY_BUNDLE=$(OUTPUT) node --test tests/boot-tty.test.mjs

verticals-check: lint smoke-bridge ## Tier 1 — full vertical CI gate (lint + protocol smoke)
	@echo "[verticals-check] OK"

# ── Dead-code lint ──────────────────────────────────────────────────────────

lint-dead: ## Static dead-code check via tsc --checkJs (unused locals/params/imports)
	@node scripts/lint-dead.mjs

lint-unused: ## Find unused exports / files / dependencies via knip
	@node_modules/.bin/knip

lint-registry: ## Validate ccpatch.yml against the patch corpus (entries, acks, dependsOn)
	@node scripts/lint-registry.mjs

lint-capabilities: ## Capability-honesty check: declared capabilities vs syscall-shaped source patterns
	@node scripts/lint-capabilities.mjs

lint-contracts: ## Contract-honesty check: every cross-patch __ccp* global must call __ccpProvide (or be allowlisted)
	@node scripts/lint-contracts.mjs

lint-ordering: ## Ordering-honesty check: no bootInject+priority runtime-ordering misuse (docs/ordering.md)
	@node scripts/lint-ordering.mjs

lint-honesty: ## All honesty lints in one pass: capabilities + contracts + escape-hatches + ordering
	@node scripts/lint-honesty.mjs

lint: lint-dead lint-unused lint-registry lint-honesty ## Run all dead-code + registry + honesty (capability/contract/escape-hatch/ordering) checks

help: ## Show this help
	@echo "Usage: make <target> [VERSION=x.y.z]"
	@echo ""
	@echo "Quick start:"
	@echo "  make dev                       fast inner loop: clean + patch + start (no sidecar/verify)"
	@echo "  make patch-claude-code         full build → releases/<ver>/ (writes revert + sidecar)"
	@echo "  make start CLI_ARGS='--help'   run the patched CLI (verifies the build sidecar first)"
	@echo "  make doctor                    fuzzy-anchor candidates — run this when a build reports drift>0"
	@echo ""
	@echo "Env bypasses (use sparingly):"
	@echo "  CCPATCH_SKIP_SHA_CHECK=1        skip the build-time supply-chain integrity gate"
	@echo "  CCPATCH_SKIP_LAUNCH_VERIFY=1    skip the launch-time bundle sidecar check at 'make start'"
	@echo ""
	@echo "Variables:"
	@echo "  VERSION=$(VERSION)     Target version"
	@echo "  INPUT=$(INPUT)"
	@echo "  OUTPUT=$(OUTPUT)"
	@echo "  PATCH=<patches>        Comma-separated patches (default in vars.mk)"
	@echo ""
	@echo "Targets:"
	@grep -h -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*##"}; {printf "  %-30s %s\n", $$1, $$2}' || true
