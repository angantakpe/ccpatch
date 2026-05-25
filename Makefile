-include .env
export

include scripts/mk/vars.mk
include scripts/mk/cli.mk

.PHONY: help refmap refmap-check
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
