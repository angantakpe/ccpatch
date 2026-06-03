# ── CLI / Patch / Bun ────────────────────────────────────────────────────────

# ── Supply-chain integrity gate ───────────────────────────────────────────────
# Before patching, verify the extracted/downloaded cli.js against a pinned
# sha256 registry (storage/known-shas.json). Policy:
#   known version + sha match    -> proceed
#   known version + sha mismatch -> FAIL CLOSED (loud error, build stops)
#   unknown/new version          -> TOFU warning, proceed (new versions still work)
# Bypass intentionally with CCPATCH_SKIP_SHA_CHECK=1.
SHA_REGISTRY    ?= storage/known-shas.json
VERIFY_SHA_TOOL := scripts/verify-bundle-sha.mjs
# verify_bundle_sha <path-to-cli.js> — call inside a recipe ($$VAR ok).
verify_bundle_sha = $(NODE) $(VERIFY_SHA_TOOL) "$(1)" --version "$(VERSION)" --registry $(SHA_REGISTRY)

.PHONY: install reconstruct build smoke run run-p test download \
        extract-from-binary bun-decompile bun-run bun-verify bun-reconstruct \
        coverage bun-all all beautify beautify-fast patch \
        patch-claude-code patch-list doctor heal print-patch anchor-catalog \
        anchor-catalog-missing anchor-catalog-changed anchor-report repatch release run-extracted \
        start \
        patch-claude-code-native \
        clean clean-patched clean-identifiers clean-all \
        test-patches patch-coverage new-patch

install: ## Install tool dependencies (prettier + lebab required by reconstructor)
	bun install

reconstruct: ## Reconstruct source from target bundle → $(OUTPUT_DIR)/
	@if [ ! -f $(TARGET_BUNDLE) ]; then \
		echo "$(TARGET_BUNDLE) not found — downloading v$(VERSION) from npm..."; \
		npm pack @anthropic-ai/claude-code@$(VERSION); \
		tar xzf anthropic-ai-claude-code-$(VERSION).tgz; \
		mv package storage/archives/claude-code-v$(VERSION); \
		rm -f anthropic-ai-claude-code-$(VERSION).tgz; \
		echo "Downloaded to storage/archives/claude-code-v$(VERSION)/"; \
	fi
	@if [ ! -f $(TARGET_BUNDLE) ]; then \
		echo "$(TARGET_BUNDLE) still missing — this version uses a Bun binary. Run: make bun-reconstruct VERSION=$(VERSION)"; \
		exit 1; \
	fi
	@test -f $(BASE_BUNDLE) || (echo "Error: $(BASE_BUNDLE) not found" && exit 1)
	@test -f $(BASE_SOURCEMAP) || (echo "Error: $(BASE_SOURCEMAP) not found" && exit 1)
	@test -d $(BASE_SOURCE) || (echo "Error: $(BASE_SOURCE) not found" && exit 1)
	$(NODE) $(RE_TOOL) \
		--base-bundle     $(BASE_BUNDLE) \
		--base-source     $(BASE_SOURCE) \
		--base-sourcemap  $(BASE_SOURCEMAP) \
		--target-bundle   $(TARGET_BUNDLE) \
		--output          $(OUTPUT_DIR)

build: ## Build reconstructed source into a working cli.js
	@test -d $(OUTPUT_DIR) || (echo "Error: $(OUTPUT_DIR) not found. Run 'make reconstruct' first" && exit 1)
	$(NODE) $(TEST_BUILD) $(OUTPUT_DIR)

smoke: ## Build + run smoke test (cli.js --help)
	@test -d $(OUTPUT_DIR) || (echo "Error: $(OUTPUT_DIR) not found. Run 'make reconstruct' first" && exit 1)
	$(NODE) $(TEST_BUILD) $(OUTPUT_DIR) --run

run: ## Run the built CLI: make run [VERSION=x.y.z]
	@test -f $(BUILD_DIST) || (echo "Error: $(BUILD_DIST) not found. Run 'make build VERSION=$(VERSION)' first" && exit 1)
	node $(BUILD_DIST)

run-p: ## Run the built CLI with a prompt: make run-p PROMPT="hello" [VERSION=x.y.z]
	@test -f $(BUILD_DIST) || (echo "Error: $(BUILD_DIST) not found. Run 'make build VERSION=$(VERSION)' first" && exit 1)
	node $(BUILD_DIST) -p "$(PROMPT)"

test: ## Self-test: reconstruct v$(BASE_VERSION) from itself (should be 100% exact)
	$(NODE) $(RE_TOOL) \
		--base-bundle     $(BASE_BUNDLE) \
		--base-source     $(BASE_SOURCE) \
		--base-sourcemap  $(BASE_SOURCEMAP) \
		--target-bundle   $(BASE_BUNDLE) \
		--output          storage/outputs/reconstructed-v$(BASE_VERSION)-selftest
	@echo ""
	@echo "Verifying byte-identical output..."
	@if diff -rq $(BASE_SOURCE) storage/outputs/reconstructed-v$(BASE_VERSION)-selftest/src/; then \
		echo "PASS: Self-test output is byte-identical"; \
	else \
		echo "FAIL: Differences found"; \
		rm -rf storage/outputs/reconstructed-v$(BASE_VERSION)-selftest; \
		exit 1; \
	fi
	@rm -rf storage/outputs/reconstructed-v$(BASE_VERSION)-selftest

download: ## Download a new version from npm: make download VERSION=2.1.90
	@test -n "$(VERSION)" || (echo "Error: VERSION required" && exit 1)
	@if [ -d storage/archives/claude-code-v$(VERSION) ]; then \
		echo "storage/archives/claude-code-v$(VERSION) already exists — skipping download"; \
	else \
		PACK_JSON=$$(npm pack @anthropic-ai/claude-code@$(VERSION) --json); \
		TARBALL=$$(printf '%s' "$$PACK_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);process.stdout.write(a[0].filename||"")})'); \
		INTEGRITY=$$(printf '%s' "$$PACK_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);process.stdout.write(a[0].integrity||"")})'); \
		[ -z "$$TARBALL" ] && TARBALL=anthropic-ai-claude-code-$(VERSION).tgz; \
		if [ -n "$$INTEGRITY" ]; then \
			echo "[download] npm registry integrity: $$INTEGRITY"; \
			$(NODE) $(VERIFY_SHA_TOOL) --tarball-only \
				--tarball "$$TARBALL" --tarball-integrity "$$INTEGRITY" || exit 1; \
		else \
			echo "[download] WARNING: npm did not report a tarball integrity field — skipping tarball check"; \
		fi; \
		tar xzf "$$TARBALL"; \
		mv package storage/archives/claude-code-v$(VERSION); \
		rm -f "$$TARBALL"; \
		echo "Downloaded to storage/archives/claude-code-v$(VERSION)/"; \
	fi

extract-from-binary: ## Extract JS from archived Bun binary: make extract-from-binary [VERSION=x.y.z]
	@test -n "$(VERSION)" || (echo "Error: VERSION required" && exit 1)
	@if [ ! -d storage/archives/claude-code-v$(VERSION) ]; then \
		$(MAKE) download VERSION=$(VERSION); \
	fi
	@ARCHIVE_BIN=storage/archives/claude-code-v$(VERSION)/bin/claude.exe; \
	if [ ! -f "$$ARCHIVE_BIN" ] || [ $$(wc -c < "$$ARCHIVE_BIN") -lt 1000000 ]; then \
		OS=$$(uname -s | tr '[:upper:]' '[:lower:]'); \
		ARCH=$$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/'); \
		PKG="@anthropic-ai/claude-code-$${OS}-$${ARCH}"; \
		echo "Downloading platform binary: $$PKG@$(VERSION)"; \
		npm pack "$$PKG@$(VERSION)" --pack-destination /tmp; \
		TARBALL=$$(ls /tmp/anthropic-ai-claude-code-$${OS}-$${ARCH}-$(VERSION).tgz 2>/dev/null); \
		tar xzf "$$TARBALL" -C /tmp package/claude; \
		mkdir -p storage/archives/claude-code-v$(VERSION)/bin; \
		mv /tmp/package/claude "$$ARCHIVE_BIN"; \
		chmod +x "$$ARCHIVE_BIN"; \
		rm -f "$$TARBALL"; \
		rmdir /tmp/package 2>/dev/null || true; \
	fi
	@ARCHIVE_BIN=storage/archives/claude-code-v$(VERSION)/bin/claude.exe; \
	if [ -f "$$ARCHIVE_BIN" ]; then \
		MAGIC=$$(od -A n -t x1 -N 4 "$$ARCHIVE_BIN" | tr -d ' \n'); \
		if [ "$$MAGIC" != "7f454c46" ] && [ "$$MAGIC" != "cefaedfe" ] && [ "$$MAGIC" != "cafebabe" ]; then \
			echo "Error: $$ARCHIVE_BIN has unexpected magic bytes: $$MAGIC (expected ELF 7f454c46 or Mach-O cefaedfe/cafebabe)"; \
			rm -f "$$ARCHIVE_BIN"; \
			exit 1; \
		fi; \
	fi
	@echo "Extracting JS from: storage/archives/claude-code-v$(VERSION)/bin/claude.exe"
	@$(NODE) bin/extract-from-binary.mjs storage/archives/claude-code-v$(VERSION)/bin/claude.exe $(CJS_EXTRACTED)
	@echo "Done: $(CJS_EXTRACTED)"

bun-decompile: ## Decompile a Bun --compile binary: make bun-decompile [VERSION=x.y.z] [BUN_BIN=path] [BUN_OUT=dir]
	@test -f $(BUN_BIN) || (echo "Error: $(BUN_BIN) not found — run: make extract-from-binary VERSION=$(VERSION)" && exit 1)
	@mkdir -p $(BUN_OUT)
	@$(NODE) tools/bun-decompiler/decompile.mjs $(BUN_BIN) --out $(BUN_OUT)
	@printf '{"dependencies":{"ws":"*"}}\n' > $(BUN_OUT)/package.json
	@npm install --prefix $(BUN_OUT) --silent

bun-run: ## Run decompiled Bun cli.js on Node via shim: make bun-run [VERSION=x.y.z] [BUN_ARGS='--help']
	@test -d $(BUN_OUT) || (echo "Error: $(BUN_OUT) not found — run: make bun-decompile VERSION=$(VERSION)" && exit 1)
	@BUN_SHIM_ROOT=$(BUN_OUT) $(NODE) --require $(CURDIR)/tools/bun-decompiler/shim.cjs $(BUN_OUT)/src/entrypoints/cli.js $(BUN_ARGS)

bun-verify: bun-decompile ## Decompile + smoke-test with --version + --help: make bun-verify [VERSION=x.y.z]
	@$(MAKE) --no-print-directory bun-run BUN_ARGS="--version"
	@$(MAKE) --no-print-directory bun-run BUN_ARGS="--help" | head -3
	@echo "✓ bun-verify passed"

bun-reconstruct: bun-decompile ## Decompile Bun binary then reconstruct TypeScript source: make bun-reconstruct [VERSION=x.y.z]
	@test -f $(BUN_OUT)/src/entrypoints/cli.js || (echo "Error: $(BUN_OUT)/src/entrypoints/cli.js not found" && exit 1)
	@if [ -d $(OUTPUT_DIR) ] && [ -z "$(FORCE)" ]; then \
		echo "$(OUTPUT_DIR) already exists — skipping (use FORCE=1 to rebuild)"; \
	else \
		$(NODE) $(RE_TOOL) \
			--base-bundle     $(BASE_BUNDLE) \
			--base-source     $(BASE_SOURCE) \
			--base-sourcemap  $(BASE_SOURCEMAP) \
			--target-bundle   $(BUN_OUT)/src/entrypoints/cli.js \
			--output          $(OUTPUT_DIR); \
	fi

coverage: ## Show reconstruction coverage report: make coverage [VERSION=x.y.z]
	@test -f $(OUTPUT_DIR)/COVERAGE.md || (echo "Error: $(OUTPUT_DIR)/COVERAGE.md not found. Run 'make bun-reconstruct VERSION=$(VERSION)' first" && exit 1)
	@cat $(OUTPUT_DIR)/COVERAGE.md

bun-all: install bun-reconstruct ## Full Bun pipeline: install + decompile + reconstruct + smoke test
	@$(MAKE) --no-print-directory bun-run BUN_ARGS="--version"
	@$(MAKE) --no-print-directory bun-run BUN_ARGS="--help" | head -3
	@echo "✓ bun-all complete"

all: install reconstruct smoke ## Install, reconstruct, and smoke test

beautify: ## Beautify a minified JS file: make beautify INPUT=cli.js OUTPUT=cli.pretty.js
	@test -f $(INPUT) || (echo "Error: $(INPUT) not found" && exit 1)
	$(NODE) $(BEAUTIFY_TOOL) $(INPUT) $(OUTPUT)

beautify-fast: ## Fast beautify (skip lebab): make beautify-fast INPUT=cli.js OUTPUT=cli.pretty.js
	@test -f $(INPUT) || (echo "Error: $(INPUT) not found" && exit 1)
	$(NODE) $(BEAUTIFY_TOOL) $(INPUT) $(OUTPUT) --fast

PATCH ?= all

patch: ## Apply patches to CLI: make patch [VERSION=x.y.z] [PATCH=startup,debug] [INPUT=cli.js] [OUTPUT=out.js]
	@test -f $(INPUT) || (echo "Error: $(INPUT) not found" && exit 1)
	$(NODE) $(PATCH_TOOL) $(INPUT) $(OUTPUT) $(addprefix --patch ,$(subst $(comma), ,$(PATCH)))

patch-claude-code: ## Apply the standard profile: make patch-claude-code [VERSION=x.y.z] [PROFILE=minimal|standard|power] [INPUT=cli.js] [OUTPUT=out.js]
	@$(NODE) scripts/print-banner.mjs --version $(VERSION) --profile $(PROFILE)
	@mkdir -p releases/$(VERSION)
	@if [ ! -f $(INPUT) ] && [ -f $(CJS_EXTRACTED) ]; then \
		echo "Using extracted: $(CJS_EXTRACTED)"; \
	elif [ ! -f $(INPUT) ]; then \
		$(MAKE) download VERSION=$(VERSION); \
	fi
	@if [ ! -f $(INPUT) ] && [ ! -f $(CJS_EXTRACTED) ]; then \
		$(MAKE) extract-from-binary VERSION=$(VERSION); \
	fi
	@SRC=$(INPUT); [ ! -f "$$SRC" ] && SRC=$(CJS_EXTRACTED); \
	if [ ! -f "$$SRC" ]; then echo "ERROR: Could not obtain cli.js for v$(VERSION)."; exit 1; fi; \
	echo "Using: $$SRC"; \
	$(call verify_bundle_sha,$$SRC) || exit 1; \
	node tools/anchor-doctor.mjs "$$SRC" $(if $(PROFILE),--profile $(PROFILE),) || true; \
	$(NODE) $(PATCH_TOOL) "$$SRC" $(OUTPUT) $(addprefix --patch ,$(subst $(comma), ,$(PATCH))) $(if $(PROFILE),--profile $(PROFILE),) $(if $(VERSION),--version $(VERSION),)
	@SHA256=$$(sha256sum $(OUTPUT) | awk '{print $$1}'); \
	echo "$$SHA256  cli.v$(VERSION).patched.mjs" > releases/$(VERSION)/cli.v$(VERSION).patched.mjs.sha256; \
	SIZE=$$(wc -c < $(OUTPUT) | tr -d ' '); \
	SIZE_MB=$$(awk "BEGIN {printf \"%.1f\", $$SIZE/1048576}"); \
	BUILD_TS=$$(date -u +"%Y-%m-%dT%H:%M:%SZ"); \
	node -e " \
	  const fs = require('fs'); \
	  const patches = '$(PATCH)'.split(',').map(s=>s.trim()); \
	  let capBypass = false; \
	  try { capBypass = !!JSON.parse(fs.readFileSync('$(OUTPUT)' + '.capgate.json', 'utf8')).capabilitiesGateBypassed; } catch {} \
	  const manifest = { \
	    version: '$(VERSION)', \
	    build_timestamp: process.env.BUILD_TS, \
	    sha256: process.env.SHA256, \
	    file_size_bytes: parseInt(process.env.SIZE, 10), \
	    patches, \
	    capabilitiesGateBypassed: capBypass, \
	    node_required: '>=18.0.0' \
	  }; \
	  fs.writeFileSync('releases/$(VERSION)/cli.v$(VERSION).manifest.json', JSON.stringify(manifest, null, 2) + '\\n'); \
	" BUILD_TS=$$BUILD_TS SHA256=$$SHA256 SIZE=$$SIZE; \
	echo "Artifacts: $(OUTPUT) ($$SIZE_MB MB, sha256:$$(echo $$SHA256 | cut -c1-12))"

patch-list: ## List available patches
	@$(NODE) $(PATCH_TOOL) --list

# `NAME` is a common environment variable (set by some shells/distros). Ignore
# an environment-origin value so `make new-patch` with no NAME shows usage rather
# than scaffolding a patch named after a stray env var. A command-line or
# Makefile/.env assignment (origin "command line"/"file") is respected.
ifeq ($(origin NAME),environment)
override NAME :=
endif

new-patch: ## Scaffold a new patch file: make new-patch NAME=my_feature [CATEGORY=extension|core] [KIND=prefix|free|postfix|transpiler|splice|flag]
	@test -n "$(NAME)" || (echo "usage: make new-patch NAME=my_feature [CATEGORY=extension|core] [KIND=prefix|free|postfix|transpiler|splice|flag] [FORCE=1]" && exit 2)
	@node bin/scaffold-patch.mjs "$(NAME)" \
		$(if $(CATEGORY),--category=$(CATEGORY),) \
		$(if $(KIND),--kind=$(KIND),) \
		$(if $(FORCE),--force,)

doctor: ## Check anchor health against installed cli.js (read-only): make doctor [VERSION=x.y.z] [PROFILE=name] [INPUT=cli.js]
	@SRC=$(INPUT); [ ! -f "$$SRC" ] && SRC=$(CJS_EXTRACTED); \
	if [ ! -f "$$SRC" ]; then echo "ERROR: Could not find cli.js (set INPUT= or run extract-from-binary VERSION=$(VERSION))"; exit 1; fi; \
	$(NODE) $(PATCH_TOOL) doctor "$$SRC" $(if $(PROFILE),--profile $(PROFILE),)

# Re-anchor drifted patches: reads storage/outputs/anchor-drift.jsonl, proposes (or
# with --write applies) updated literal anchors in runner/anchors.mjs so that patches
# which lost their anchor after a CC version bump are automatically re-grounded.
heal: ## Re-anchor drifted patches from drift log (dry-run by default): make heal [WRITE=1] [DRIFT=path] [ANCHORS=path]
	$(NODE) $(PATCH_TOOL) heal \
		$(if $(WRITE),--write,) \
		$(if $(DRIFT),--drift $(DRIFT),) \
		$(if $(ANCHORS),--anchors $(ANCHORS),)

print-patch: ## Print the active PATCH list (consumed by downstream callers)
	@echo "$(PATCH)"

anchor-catalog: ## Build anchor catalog from tweakcc system prompts: make anchor-catalog [BUNDLE=path] [FILTER=agent-prompt-*]
	@$(NODE) tools/tweakcc-anchors.mjs $(if $(BUNDLE),--bundle $(BUNDLE),) $(if $(FILTER),--filter "$(FILTER)",)

anchor-catalog-missing: ## Show only prompts NOT found in the bundle
	@$(NODE) tools/tweakcc-anchors.mjs $(if $(BUNDLE),--bundle $(BUNDLE),) --missing

anchor-catalog-changed: ## Show only prompts whose hash drifted (changed between CC versions)
	@$(NODE) tools/tweakcc-anchors.mjs $(if $(BUNDLE),--bundle $(BUNDLE),) --changed

anchor-report: ## Show each patch's anchor resolution tier (literal/refmap/regex/fuzzy/none): make anchor-report [ENABLED=1]
	@$(NODE) scripts/anchor-report.mjs $(if $(ENABLED),--enabled,)

refmap: ## Build refmap for an upstream version: make refmap VERSION=x.y.z [BUNDLE=path]
	@test -n "$(VERSION)" || (echo "Error: VERSION required" && exit 1)
	@SRC="$(BUNDLE)"; [ -z "$$SRC" ] && SRC="storage/archives/claude-code-v$(VERSION)/cli.js"; \
	[ ! -f "$$SRC" ] && SRC="storage/archives/claude-code-v$(VERSION)/cli.v$(VERSION).cjs"; \
	[ ! -f "$$SRC" ] && SRC="$(CJS_EXTRACTED)"; \
	if [ ! -f "$$SRC" ]; then \
	  $(MAKE) download VERSION=$(VERSION); \
	  SRC="storage/archives/claude-code-v$(VERSION)/cli.js"; \
	  [ ! -f "$$SRC" ] && SRC="storage/archives/claude-code-v$(VERSION)/cli.v$(VERSION).cjs"; \
	fi; \
	if [ ! -f "$$SRC" ]; then echo "ERROR: Could not obtain bundle for v$(VERSION) (tried storage/archives + extracted)"; exit 1; fi; \
	echo "Building refmap from: $$SRC"; \
	$(NODE) tools/build-refmap.mjs "$$SRC" --cc-version $(VERSION)

refmap-check: ## Verify refmaps/$(VERSION).json still matches bundle: make refmap-check VERSION=x.y.z [BUNDLE=path]
	@test -n "$(VERSION)" || (echo "Error: VERSION required" && exit 1)
	@SRC="$(BUNDLE)"; [ -z "$$SRC" ] && SRC="storage/archives/claude-code-v$(VERSION)/cli.js"; \
	[ ! -f "$$SRC" ] && SRC="storage/archives/claude-code-v$(VERSION)/cli.v$(VERSION).cjs"; \
	if [ ! -f "$$SRC" ]; then echo "ERROR: Could not find bundle for v$(VERSION) — run 'make download VERSION=$(VERSION)' first"; exit 1; fi; \
	$(NODE) tools/build-refmap.mjs "$$SRC" --cc-version $(VERSION) --check

repatch: ## Rebuild patched CLI (auto-downloads if needed): make repatch [VERSION=x.y.z]
	@test -n "$(VERSION)" || (echo "Error: VERSION required" && exit 1)
	@mkdir -p releases/$(VERSION)
	@if [ ! -f storage/archives/claude-code-v$(VERSION)/cli.js ] && [ ! -f $(CJS_EXTRACTED) ]; then \
		$(MAKE) download VERSION=$(VERSION); \
	fi
	@if [ ! -f storage/archives/claude-code-v$(VERSION)/cli.js ] && [ ! -f $(CJS_EXTRACTED) ]; then \
		$(MAKE) extract-from-binary VERSION=$(VERSION); \
	fi
	@SRC=storage/archives/claude-code-v$(VERSION)/cli.js; [ ! -f "$$SRC" ] && SRC=$(CJS_EXTRACTED); \
	if [ ! -f "$$SRC" ]; then echo "ERROR: Could not obtain cli.js for v$(VERSION)."; exit 1; fi; \
	echo "Using: $$SRC"; \
	$(call verify_bundle_sha,$$SRC) || exit 1; \
	rm -f $(OUTPUT); \
	$(NODE) $(PATCH_TOOL) "$$SRC" $(OUTPUT) $(addprefix --patch ,$(subst $(comma), ,$(PATCH)))

release: repatch ## Package patched CLI as a versioned release artifact: make release [VERSION=x.y.z]
	@test -n "$(VERSION)" || (echo "Error: VERSION required" && exit 1)
	@test -f $(OUTPUT) || (echo "Error: $(OUTPUT) not found" && exit 1)
	@SHA256=$$(sha256sum $(OUTPUT) | awk '{print $$1}'); \
	echo "$$SHA256  cli.v$(VERSION).patched.mjs" > releases/$(VERSION)/cli.v$(VERSION).patched.mjs.sha256; \
	SIZE=$$(wc -c < $(OUTPUT) | tr -d ' '); \
	SIZE_MB=$$(awk "BEGIN {printf \"%.1f\", $$SIZE/1048576}"); \
	BUILD_TS=$$(date -u +"%Y-%m-%dT%H:%M:%SZ"); \
	node -e " \
	  const fs = require('fs'); \
	  const patches = '$(PATCH)'.split(',').map(s=>s.trim()); \
	  let capBypass = false; \
	  try { capBypass = !!JSON.parse(fs.readFileSync('$(OUTPUT)' + '.capgate.json', 'utf8')).capabilitiesGateBypassed; } catch {} \
	  const manifest = { \
	    version: '$(VERSION)', \
	    build_timestamp: process.env.BUILD_TS, \
	    sha256: process.env.SHA256, \
	    file_size_bytes: parseInt(process.env.SIZE, 10), \
	    patches, \
	    capabilitiesGateBypassed: capBypass, \
	    node_required: '>=18.0.0' \
	  }; \
	  fs.writeFileSync('releases/$(VERSION)/cli.v$(VERSION).manifest.json', JSON.stringify(manifest, null, 2) + '\\n'); \
	" BUILD_TS=$$BUILD_TS SHA256=$$SHA256 SIZE=$$SIZE; \
	echo "Released: $(OUTPUT) ($$SIZE_MB MB, sha256:$$(echo $$SHA256 | cut -c1-12))"

test-patches: ## Run patch unit tests (apply + verify + runtime): make test-patches [VERSION=x.y.z]
	node --test tests/patch-verification.test.mjs

patch-coverage: ## Apply + smoke-run + cross-reference patch coverage: make patch-coverage [VERSION=x.y.z] [SMOKE='node out.js --version']
	@test -n "$(VERSION)" || (echo "Error: VERSION required" && exit 1)
	$(MAKE) patch-claude-code VERSION=$(VERSION)
	@echo "[patch-coverage] running smoke session..."
	@$(NODE) bin/patch-cli.mjs coverage $(OUTPUT) --cc-version $(VERSION) $(if $(SMOKE),--smoke "$(SMOKE)",)

start: ## Run the patched CLI, building first if needed: make start [VERSION=x.y.z] [CLI_ARGS='--help']
	@if [ ! -d node_modules/react ]; then \
		echo "[start] react not found — running npm install..."; \
		npm install --silent; \
	fi
	@if [ ! -f $(OUTPUT) ]; then \
		echo "$(OUTPUT) not found — building..."; \
		$(MAKE) patch-claude-code VERSION=$(VERSION); \
	fi
	node $(OUTPUT) $(CLI_ARGS)

run-extracted: ## Run the extracted (unpatched) CLI directly: make run-extracted [VERSION=x.y.z]
	@test -f $(CJS_EXTRACTED) || (echo "Error: $(CJS_EXTRACTED) not found. Run 'make extract-from-binary VERSION=$(VERSION)' first" && exit 1)
	node $(CJS_EXTRACTED) $(CLI_ARGS)

NATIVE_PATCHED_JS  ?= storage/outputs/$(VERSION)/cli.patched.js
NATIVE_OUTPUT      ?= releases/$(VERSION)/claude

patch-claude-code-native: ## Patch native binary: extract + patch + repack
	@test -n "$(VERSION)" || (echo "Error: VERSION required" && exit 1)
	@mkdir -p releases/$(VERSION) storage/outputs/$(VERSION)
	$(MAKE) extract-from-binary VERSION=$(VERSION)
	@SRC=$(CJS_EXTRACTED); \
	if [ ! -f "$$SRC" ]; then echo "ERROR: $(CJS_EXTRACTED) not found after extract step."; exit 1; fi; \
	$(call verify_bundle_sha,$$SRC) || exit 1; \
	echo "Patching: $$SRC → $(NATIVE_PATCHED_JS)"; \
	$(NODE) $(PATCH_TOOL) "$$SRC" $(NATIVE_PATCHED_JS) $(addprefix --patch ,$(subst $(comma), ,$(PATCH)))
	@test -f $(NATIVE_PATCHED_JS) || (echo "Error: patch step did not produce $(NATIVE_PATCHED_JS)" && exit 1)
	@ORIG_BIN=storage/archives/claude-code-v$(VERSION)/bin/claude.exe; \
	echo "Repacking: $$ORIG_BIN + $(NATIVE_PATCHED_JS) → $(NATIVE_OUTPUT)"; \
	$(NODE) bin/repack-bundle.mjs "$$ORIG_BIN" $(NATIVE_PATCHED_JS) $(NATIVE_OUTPUT)
	@chmod 0755 $(NATIVE_OUTPUT)
	@echo ""
	@echo "Native binary ready: $(NATIVE_OUTPUT)"
	@echo "To use it:  alias claude='\''$(CURDIR)/$(NATIVE_OUTPUT)'\''"

clean: ## Wipe all build outputs; downloaded archives in storage/archives/ are preserved
	rm -rf storage/outputs/
	rm -rf releases/
	rm -rf tools/reconstructor/node_modules
	rm -f cli.beautified.js /tmp/ccpatch-stderr.log
	find . -name "*:Zone.Identifier" -type f -delete
	@echo "[clean] done — storage/archives/ and storage/diagnostics/ preserved"

clean-patched: ## Remove patched files for current VERSION only: make clean-patched [VERSION=x.y.z]
	rm -rf releases/$(VERSION)
	rm -f $(CJS_EXTRACTED)
	rm -f cli.beautified.js /tmp/ccpatch-stderr.log
	@echo "[clean-patched] v$(VERSION) cleaned"

clean-identifiers: ## Remove all *Zone.Identifier files
	find . -name "*:Zone.Identifier" -type f -delete

clean-all: clean ## Full reset including downloaded archives (requires re-download afterwards)
	rm -rf storage/archives/
	@echo "[clean-all] done"
