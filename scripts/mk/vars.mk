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

# ── PROFILE — curated patch set selector ─────────────────────────────────────
# `make patch-claude-code` defaults to the `standard` profile (bug fixes +
# quality-of-life features). Profiles are defined in ccpatch.yml under
# `profiles:` and resolved by runner/manifest.mjs resolveProfile().
#
#   make patch-claude-code                    # standard profile (default)
#   make patch-claude-code PROFILE=minimal    # bug fixes + minimum infra
#   make patch-claude-code PROFILE=power       # every patch listed in ccpatch.yml
#   make patch-claude-code PROFILE=            # no profile — falls back to ccpatch.yml enabled flags
#
# PROFILE applies only in YAML mode (PATCH unset or PATCH=all). An explicit
# PATCH=name1,name2 list bypasses both the profile and the YAML.
PROFILE ?= standard

INPUT           ?= storage/archives/claude-code-v$(VERSION)/cli.js
OUTPUT          ?= releases/$(VERSION)/cli.v$(VERSION).patched.mjs
CJS_EXTRACTED   ?= storage/archives/claude-code-v$(VERSION)/cli.v$(VERSION).cjs

BUN_BIN         ?= storage/archives/claude-code-v$(VERSION)/bin/claude.exe
BUN_OUT         ?= storage/outputs/bun-decompile-v$(VERSION)
BUN_ARGS        ?= --version

PROMPT          ?= "Say hello as JSON"

# ── Headless bridge — used by `make start` / `make gateway` ─────────────────
# `make start` opens the headless_bridge control socket automatically (needs
# a daemon-profile build — see the `start` target) so `make gateway` in a
# second terminal can find it without manually generating/copy-pasting a
# token. Both default to repo-local paths so nothing needs sharing by hand;
# override CC_BRIDGE_ADDR/CC_BRIDGE_TOKEN_FILE to point elsewhere.
CC_BRIDGE_SOCK       ?= $(CURDIR)/storage/ccpatch-bridge.sock
CC_BRIDGE_ADDR       ?= unix:$(CC_BRIDGE_SOCK)
CC_BRIDGE_TOKEN_FILE ?= $(CURDIR)/storage/.bridge-token
# `make gateway`'s adapter — override with GATEWAY_ADAPTERS=telegram (needs
# TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_CHAT_IDS; see packages/gateway/README.md).
GATEWAY_ADAPTERS     ?= stdio

# ── VERBOSE — two-tier build output ──────────────────────────────────────────
# The build is COMPACT by default: phase headers, one ✨ line per patch, the
# summary box, and any warnings. Per-patch / per-shim sub-chatter (anchor
# matches, feature-unhide enumerations, shim notes) is hidden.
#
#   make patch-claude-code            # compact (default)
#   make patch-claude-code VERBOSE=1  # full detail (doctor table + every patch line)
#
# VERBOSE=1 exports CCPATCH_LOG_LEVEL=debug for the whole recipe so BOTH the
# doctor pre-pass (a separate process) and the patch CLI agree, and passes the
# friendly --verbose flag to the patch CLI.
ifdef VERBOSE
  export CCPATCH_LOG_LEVEL := debug
  CCP_VERBOSE_FLAG := --verbose
else
  CCP_VERBOSE_FLAG :=
endif
