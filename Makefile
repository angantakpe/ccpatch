-include .env
export

include scripts/mk/vars.mk
include scripts/mk/cli.mk

.PHONY: help refmap refmap-check smoke-bridge lint lint-dead lint-unused
smoke-bridge: ## Smoke-test the headless_bridge NDJSON protocol (no patched CLI needed)
	@node tests/smoke_bridge.mjs

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
