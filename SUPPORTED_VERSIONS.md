# Supported Claude Code versions

ccpatch tracks upstream Claude Code closely. Each `main` revision is
verified against the **last three published stable versions** in CI
(see [`.github/workflows/version-matrix.yml`](.github/workflows/version-matrix.yml)),
and against `@latest` nightly (see
[`.github/workflows/drift-check.yml`](.github/workflows/drift-check.yml)).

A version is only considered **supported** once `refmaps/<version>.json`
is committed. Refmaps are the anchor tier that absorbs minified-identifier
rotation, so generating one is a mandatory release step, not optional
augmentation: the nightly drift sweep fails when `@latest` has no refmap,
and the PR version matrix warns per missing version. Generate one with:

```
node bin/patch-cli.mjs refmap <path/to/cli.js> --cc-version <X.Y.Z> \
  --out refmaps/<X.Y.Z>.json
```

## Verifying your bundle

Before reporting a patch issue, confirm you're patching an unmodified
upstream bundle. ccpatch's anchor doctor prints the sha256 on every run;
you can also compute it manually:

```
shasum -a 256 $(npm root -g)/@anthropic-ai/claude-code/cli.js
```

If your hash doesn't match a row below and your version is otherwise
recent, the bundle may have been modified locally (e.g. by another
patcher). Re-install with `npm i -g @anthropic-ai/claude-code@<version>`
and try again.

## Known bundle hashes

These are the bundles ccpatch has been run against in this repository's
history. Hashes are for the **unmodified** upstream JS bundle as
distributed via npm or extracted from the Bun-native binary.

| Version  | sha256                                                             | Size (bytes) | Source        |
| -------- | ------------------------------------------------------------------ | ------------ | ------------- |
| 2.1.150  | `46848f48de3ab84379e3d6587731871024fe265a524286e71010be54bfe1da44` | 15,307,733   | npm (`cli.cjs`) |
| 2.1.148  | `e810d9fbf8541c623a3b4cf8d987f7774f0e949a709e53a7d949eaf0a8e7a581` | 15,164,424   | npm (`cli.cjs`) |

Newer versions are added as drift-check or the version-matrix encounter
them. Older versions are best-effort — patches may still work but are
not gated in CI.

## Native (Bun-compiled) binaries

When Claude Code ships as a Bun-native binary, ccpatch extracts the
embedded JS via `make extract-from-binary VERSION=<x.y.z>`. The
extracted JS is what gets hashed and patched; the surrounding native
container is then re-emitted with `node-lief`.
