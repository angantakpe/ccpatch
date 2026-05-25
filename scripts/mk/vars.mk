# ── Shared Variables ──────────────────────────────────────────────────────────

BASE_VERSION    ?= 2.1.88

# Auto-detect version from the installed claude binary.
# Falls back to latest from npm (cached 1h) so `make patch-claude-code` always
# targets a real version even when claude is not locally installed.
_LIVE_VERSION   := $(shell which claude 2>/dev/null | xargs readlink -f 2>/dev/null | xargs -I{} {} --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
ifeq ($(_LIVE_VERSION),)
  _FALLBACK_VERSION := $(shell ./tools/resolve-latest.sh @anthropic-ai/claude-code 2>/dev/null)
else
  _FALLBACK_VERSION := $(_LIVE_VERSION)
endif
VERSION         ?= $(_FALLBACK_VERSION)

ifeq ($(VERSION),latest)
  override VERSION := $(shell ./tools/resolve-latest.sh @anthropic-ai/claude-code)
endif

NODE            := node --max-old-space-size=4096
comma           := ,

BASE_BUNDLE     := storage/archives/claude-code-v$(BASE_VERSION)/cli.js
BASE_SOURCE     := storage/archives/claude-code-source-v$(BASE_VERSION)/src
BASE_SOURCEMAP  := storage/archives/claude-code-source-build/source/cli.js.map
TARGET_BUNDLE   := storage/archives/claude-code-v$(VERSION)/cli.js
OUTPUT_DIR      := storage/outputs/reconstructed-v$(VERSION)

RE_TOOL         := tools/reconstructor/main.mjs
TEST_BUILD      := tools/reconstructor/test-build.mjs
BEAUTIFY_TOOL   := tools/reconstructor/beautify.mjs
PATCH_TOOL      := bin/patch-cli.mjs
BUILD_DIST      := $(OUTPUT_DIR)/dist/cli.js

# ── PATCH — default is YAML-driven ───────────────────────────────────────────
# By default the patcher reads ccpatch.yml and applies only enabled patches.
# Override with an explicit comma-separated list to bypass the YAML entirely.
#
#   make patch-claude-code                    # YAML-driven (reads ccpatch.yml)
#   make patch-claude-code PATCH=all          # same — explicit all
#   make patch-claude-code PATCH=debug,model  # specific patches only
#
# NOTE: Do not export PATCH from your shell — pass it as a make argument.
PATCH ?= all

INPUT           ?= storage/archives/claude-code-v$(VERSION)/cli.js
OUTPUT          ?= releases/$(VERSION)/cli.v$(VERSION).patched.mjs
CJS_EXTRACTED   ?= storage/archives/claude-code-v$(VERSION)/cli.v$(VERSION).cjs

BUN_BIN         ?= storage/archives/claude-code-v$(VERSION)/bin/claude.exe
BUN_OUT         ?= storage/outputs/bun-decompile-v$(VERSION)
BUN_ARGS        ?= --version

PROMPT          ?= "Say hello as JSON"
