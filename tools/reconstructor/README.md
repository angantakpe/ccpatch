# bundle-reconstructor — Règle de Trois

> **Status: OPTIONAL offline reverse-engineering aid. NOT part of the core
> patch pipeline.**
>
> Nothing in `bin/`, `runner/`, `core/`, or `extensions/` imports anything
> under `tools/reconstructor/`. The production build
> (`make patch-claude-code` → `bin/patch-cli.mjs` → `runner/`) obtains its
> input bundle by downloading the npm tarball or extracting from a Bun binary
> (`bin/extract-from-binary.mjs`, which uses
> `tools/bun-decompiler/decompile.mjs`) and patches `cli.js` directly — it
> never invokes this tool. The only in-repo consumers are the offline make
> targets in `scripts/mk/cli.mk` (`reconstruct`, `build`, `smoke`, `test`,
> `bun-reconstruct`, `coverage`, `beautify`) and the
> `tools/bench-align.mjs` microbenchmark. You can delete this directory and
> `make patch-claude-code` still works.

## What it does

Reconstructs readable Claude Code TypeScript-ish source from a **new**
minified `cli.js` bundle, using a **known** bundle↔source↔sourcemap triple as
the Rosetta Stone (the "règle de trois"): if you know how base bundle B maps
to base source S, and you can align target bundle B' to B, you can project a
candidate source S' for the target.

This exists to help **align ccpatch anchors against new Claude Code
releases** — when a release rotates minified identifiers or moves code, a
reconstructed view of the new bundle makes it much faster to find where an
anchor's stable string literal went. It is a research/maintenance aid, not a
build step.

## Pipeline

1. **sourcemap** (`lib/sourcemap-parser.mjs`, `lib/vlq.mjs`) — parse the base
   version's `cli.js.map` into a position index.
2. **analyze** (`lib/bundle-analyzer.mjs`) — tokenize both bundles (acorn),
   extract string literals, detect esbuild module boundaries
   (`var X = WRAPPER((exports, module) => {...})` / lazy `WRAPPER(() => {...})`).
3. **segment** (`lib/module-segmenter.mjs`) — split each bundle into module
   chunks with their string literals.
4. **align** (`lib/aligner.mjs`, `lib/string-indexer.mjs`,
   `lib/fingerprinter.mjs`, `lib/normalizer.mjs`) — match target chunks to
   base chunks by anchor strings, fingerprints, structure, and position.
5. **reconstruct** (`lib/reconstructor.mjs`) — project the base source onto
   the aligned target chunks; emit per-file output plus a coverage report
   (`lib/coverage-reporter.mjs`).

## Usage

Via make (paths and versions resolved for you — see `scripts/mk/vars.mk`):

```sh
make reconstruct VERSION=x.y.z   # npm-tarball bundles
make bun-reconstruct VERSION=x.y.z   # Bun-binary releases (decompile first)
make build VERSION=x.y.z         # test-build the reconstructed source
make smoke VERSION=x.y.z         # build + run `cli.js --help`
make coverage VERSION=x.y.z      # show the reconstruction coverage report
```

Or directly:

```sh
node tools/reconstructor/main.mjs \
  --base-bundle     storage/archives/claude-code-v2.1.88/cli.js \
  --base-source     storage/archives/claude-code-source-v2.1.88/src \
  --base-sourcemap  storage/archives/claude-code-source-build/source/cli.js.map \
  --target-bundle   storage/archives/claude-code-v2.1.89/cli.js \
  --output          storage/outputs/cc-v2.1.89
```

All inputs live under `storage/` (gitignored — bundles and Anthropic source
are never committed; see repo rule 7 in `.claude/rules/hook-patches.md`).
`test-build.mjs` additionally requires the
`storage/archives/claude-code-source-build` workspace; neither it nor
`main.mjs` can run without those local archives.

## Relationship to tools/bun-decompiler

Distinct concerns, no shared parsing code:

- `tools/bun-decompiler/decompile.mjs` owns **Bun standalone-binary** module
  extraction (walking `/$bunfs/root/<path>\0` markers in a compiled binary).
  Its `parseModules` is the canonical implementation, imported by
  `bin/extract-from-binary.mjs` and `runner/dissect.mjs`.
- This tool consumes a **plain-text JS bundle** (esbuild output) — by the time
  it runs, any Bun binary has already been decompiled to `cli.js` text
  (`make bun-reconstruct` sequences `bun-decompile` first). It contains no Bun
  module-marker parsing.

## Workspace note

`tools/reconstructor` is listed in the root `package.json` `workspaces` only
so `npm install` provisions its dependencies (acorn, prettier, lebab, …).
That does not wire it into the patch pipeline.
