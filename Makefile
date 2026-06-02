-include .env
export

include scripts/mk/vars.mk
include scripts/mk/cli.mk

.PHONY: help refmap refmap-check smoke-bridge smoke-integration \
        smoke-integration-roundtrip \
        bridge-host bridge-host-stop bridge-tail bridge-submit \
        verticals-check lint lint-dead lint-unused \
        test\:patches lint\:dead lint\:unused

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
lint\:dead: lint-dead ## Alias for lint-dead (npm-style spelling)
lint\:unused: lint-unused ## Alias for lint-unused (npm-style spelling)

# ── Verticals: testing the headless bridge + agent tree ─────────────────────

# Default socket / token for the interactive `bridge-host` + tier-3 smoke.
# Override on the command line: make bridge-host CC_BRIDGE_ADDR=tcp://127.0.0.1:7878
CC_BRIDGE_ADDR  ?= unix:/tmp/ccpatch.sock
# The bridge token is root-equivalent: anyone presenting it can submit prompts
# and dispatch tools in the running CLI. Generate a random ephemeral token per
# invocation rather than shipping a guessable literal. Falls back to a clearly
# marked stub only if openssl is unavailable (warned about in the dev targets).
CC_BRIDGE_TOKEN ?= $(shell openssl rand -hex 16 2>/dev/null || echo "INSECURE-STUB-set-CC_BRIDGE_TOKEN")

smoke-bridge: ## Tier 1 — NDJSON protocol smoke against a stubbed host (no patched CLI)
	@node tests/smoke_bridge.mjs

bridge-host: ## Tier 2 — boot a stub bridge host so you can prod it with ccpatch-bridge / nc
	@echo "[bridge-host] CC_BRIDGE_ADDR=$(CC_BRIDGE_ADDR)"
	@echo "[bridge-host] CC_BRIDGE_TOKEN=$(CC_BRIDGE_TOKEN)"
	@case "$(CC_BRIDGE_TOKEN)" in INSECURE-STUB*) echo "[bridge-host] WARNING: openssl missing — using an INSECURE stub token. Set CC_BRIDGE_TOKEN to a real secret (e.g. openssl rand -hex 16)." ;; esac
	@CC_BRIDGE_ADDR=$(CC_BRIDGE_ADDR) CC_BRIDGE_TOKEN=$(CC_BRIDGE_TOKEN) node tests/bridge_host.mjs

bridge-host-stop: ## Tier 2 — kill any stray bridge-host and unlink the unix socket
	@-pkill -f tests/bridge_host.mjs 2>/dev/null || true
	@if echo "$(CC_BRIDGE_ADDR)" | grep -q '^unix:'; then \
		SOCK=$$(echo $(CC_BRIDGE_ADDR) | sed 's/^unix://'); \
		rm -f "$$SOCK" && echo "removed $$SOCK"; \
	fi

bridge-submit: ## Tier 2 — send PROMPT to the running bridge-host: make bridge-submit PROMPT="hi"
	@test -n "$(PROMPT)" || (echo "usage: make bridge-submit PROMPT=\"...\"" && exit 2)
	@CC_BRIDGE_ADDR=$(CC_BRIDGE_ADDR) CC_BRIDGE_TOKEN=$(CC_BRIDGE_TOKEN) \
		node tools/ccpatch-bridge.mjs submit "$(PROMPT)"

bridge-tail: ## Tier 2 — tail bus events from the running bridge-host
	@CC_BRIDGE_ADDR=$(CC_BRIDGE_ADDR) CC_BRIDGE_TOKEN=$(CC_BRIDGE_TOKEN) \
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

verticals-check: lint smoke-bridge ## Tier 1 — full vertical CI gate (lint + protocol smoke)
	@echo "[verticals-check] OK"

# ── Dead-code lint ──────────────────────────────────────────────────────────

lint-dead: ## Static dead-code check via tsc --checkJs (unused locals/params/imports)
	@node scripts/lint-dead.mjs

lint-unused: ## Find unused exports / files / dependencies via knip
	@node_modules/.bin/knip

lint: lint-dead lint-unused ## Run all dead-code checks

help: ## Show this help
	@echo "Usage: make <target> [VERSION=x.y.z]"
	@echo ""
	@echo "Targets:"
	@grep -h -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*##"}; {printf "  %-30s %s\n", $$1, $$2}'
	@echo ""
	@echo "Variables:"
	@echo "  VERSION=$(VERSION)     Target version"
	@echo "  INPUT=$(INPUT)"
	@echo "  OUTPUT=$(OUTPUT)"
	@echo "  PATCH=<patches>        Comma-separated patches (default in vars.mk)"
