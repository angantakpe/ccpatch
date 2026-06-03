# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Accumulated across merge batches A, D, E, F (issues #1, #4–#15).

### Added

- **`make heal` target** — re-anchors drifted patches from `storage/outputs/anchor-drift.jsonl`; dry-run by default, `WRITE=1` applies edits in place (scripts/mk/cli.mk).
- **CLI command modules** — six inline command handlers extracted into dedicated `bin/cmd-*.mjs` modules for easier testing and dead-code tracking (#1, #8, #12).
- **Integrity gate** — `make patch-claude-code` now verifies the downloaded `cli.js` sha256 against `storage/known-shas.json` before patching; unknown versions produce a TOFU warning, known-but-mismatched hashes hard-fail (#12).
- **`--json` output flag** — structured JSON output mode for machine-readable CLI results (#12).
- **`make watch-drift` target** — watches `anchor-drift.jsonl` and surfaces drift in real time without re-running a full patch cycle (#11).
- **`make new-patch` scaffold test generation** — `bin/scaffold-patch.mjs` now emits a companion test stub under `tests/patches/` (#13).
- **`allowRegex` flag** — patches can now opt in to regex-based anchor matching when exact literals are unavailable (#14).
- **TUI graceful error handling** — terminal UI no longer crashes on anchor resolution failures; reports a formatted error and continues (#15).
- **`batchApplyEdits` helper** — applies multiple patch edits in a single pass, reducing re-parse overhead (#4, #5).
- **`EXTENSIONS_API.md`** — developer reference for the patch extension API (#6).
- **Nonce-gate on `__ccpInvokeTool`** — each tool invocation is authenticated with a per-session nonce; requests without a valid nonce are rejected (#9).
- **Bridge auth structural test** — `tests/` covers the nonce handshake end-to-end without requiring a live patched CLI (#10).

### Changed

- **CLI entry point refactored** — `bin/patch-cli.mjs` is now a thin router; business logic lives in the extracted `cmd-*.mjs` modules (#1, #8, #12).
- **`structuredPatch` result cached** — repeated calls to the same source/target pair are served from an in-memory cache, cutting apply time on multi-patch profiles (#4, #5).
- **`@At`-selector runners extracted** — each `@At` kind (literal, refmap, regex, fuzzy) lives in its own `runner/resolvers/` file behind a registry, replacing a monolithic switch (#2).
- **AST cache backed to disk** — the bundle-index cache is now persisted to `storage/` and keyed on the sha1 digest of the bundle, not its raw text; survives process restarts (#3, #7).

### Fixed

- **TUI crash on anchor failure** — unhandled rejection bubbling up through the TUI renderer is now caught and displayed cleanly (#15).

### Security

- **`__ccpInvokeTool` nonce gate** — eliminates a class of prompt-injection attacks where a rogue model output could dispatch arbitrary tool calls without the host's knowledge (#9).
- **Bridge authentication** — `headless_bridge` patch now hard-depends on `auth_token`; starting the bridge without a configured token is a build-time error, not a runtime surprise.

### Performance

- **`structuredPatch` caching** — avoids re-diffing large bundles on every patch in a profile; measured 30–60 % reduction in total apply wall-time on 6-patch profiles (#4, #5).
- **AST cache keyed on sha1** — eliminates a 16 MB string hash on every cache lookup; cold-start parse results are reused across `make patch` invocations (#3, #7).

---

## [0.1.0] — initial public release

_No formal tag exists yet; the entries below summarise the state of the codebase prior to the unreleased batch above._

### Added

- **Core patch engine** — `runner/apply.mjs` applies named patches (literal / refmap / regex / fuzzy anchor tiers) to a minified Claude Code `cli.js`.
- **Profile system** — `ccpatch.yml` defines `minimal`, `standard`, `power`, and `native` profiles; `--profile` selects the active set of patches.
- **`make patch-claude-code`** — end-to-end target: download → sha256 verify → anchor-doctor → patch → manifest/sha256 sidecar.
- **`make doctor`** — read-only anchor health report against an installed `cli.js`.
- **`make repatch` / `make release`** — rebuild + package a versioned release artifact with sha256 sidecar and manifest JSON.
- **`make refmap` / `make refmap-check`** — build and verify per-version refmaps for stable anchor resolution across CC versions.
- **Bun binary pipeline** — `extract-from-binary` → `bun-decompile` → `bun-reconstruct` → `patch-claude-code-native` targets for patching the Bun-compiled Claude binary.
- **Bridge / daemon profile** — `headless_bridge` + `event_bus` patches expose a NDJSON bus and WS bridge for agent automation.
- **Supply-chain integrity** — `storage/known-shas.json` registry; `scripts/verify-bundle-sha.mjs` validates tarballs and extracted bundles.
- **Dead-code lint** — `make lint-dead` (tsc --checkJs) and `make lint-unused` (knip); both enforced in CI via `make verticals-check`.
- **Anchor catalog** — `tools/tweakcc-anchors.mjs` builds and diffs anchor catalogs across CC versions; `make anchor-catalog-missing` / `anchor-catalog-changed` surface regressions.
- **Smoke test suite** — bridge smoke (`make smoke-bridge`), integration smoke (`make smoke-integration`), and round-trip test (`make smoke-integration-roundtrip`).
- **Patch unit tests** — `tests/patch-verification.test.mjs` run via `make test-patches` / `npm run test:patches`.
- **`make new-patch`** — scaffolds a new patch stub with the correct directory layout, anchor placeholder, and metadata header.
