# Contributing to ccpatch

Thanks for considering a patch. ccpatch injects scripts into Claude Code's `cli.js` to reach behavior that MCP and external wrappers cannot touch — internal feature flags, the tool list before it reaches the API, user input before the harness processes it, and module-scoped state in the agent loop.

This document covers the patch contract, how to add a new one, and what gets merged vs. flagged for discussion.

---

## The patch contract

Every patch is a single `.mjs` file under `core/` or `extensions/` that default-exports an object with three load-bearing parts:

1. **Anchor** — how the patch locates its injection or rewrite site. Either a stable string literal, a regex against the minified bundle, or an AST anchor resolved via `runner/ast-anchor.mjs` (`findFunctionByLiteral`, windowed Acorn parse).
2. **Transform** — an `apply(code, opts) => string` function that returns the modified bundle. Must be idempotent: re-applying must be a no-op (typically guarded by a sentinel string the patch itself injects).
3. **Invariant test** — a `verify` block. The runner asserts it immediately after `apply()` returns and fails the patch if any assertion doesn't hold.

The `verify` block is **required** for every patch. It must contain at least one of:

- `verify.present` — `string | string[]` substring(s) that MUST exist post-apply.
- `verify.absent` — `string | string[]` substring(s) that MUST NOT exist post-apply. Catches no-op apply and double-apply by asserting the pre-patch form is gone.
- `verify.count` — `number | { present?: number, absent?: number }` exact occurrence totals. Use this when you patched N specific sites and want to guarantee none were missed and none were over-rewritten. Shorthand: a bare number means `present` count.

A patch without a `verify` block is rejected at load time before any apply runs — there is no opt-out. `verifyExempt` is no longer supported; provide a real assertion.

Pick the strongest verify you can derive by reading your own `apply()`. A `present`-only verify is "weak" — `ccpatch doctor` reports it as `UNVERIFIED` because a wrong-location apply could leave the sentinel matching an unrelated string elsewhere in the bundle. In `--strict` mode, `UNVERIFIED` is treated as failure.

Optional manifest fields you'll see in real patches: `category`, `phase` (`pre | main | post`), `dependsOn`, `env`, `tags`, `required`, `preload` + `preloadCode`. See `runner/manifest.mjs` for the full schema.

---

## Add a new patch

### 1. Find your anchor

Reconstruct the bundle for the version you're targeting and read it:

```
make reconstruct VERSION=2.1.148
```

This drops a beautified tree under `storage/outputs/reconstructed-v2.1.148/`. Identify the smallest stable string near where you want to act. Good anchors are:

- Feature flag keys (e.g. `"tengu_kairos_cron_durable"`).
- Distinct error messages.
- Unique combinations of named parameters (e.g. five argument names co-located in one `Promise.all`).

Avoid anchoring on minified identifiers — they rotate every release.

If your anchor is version-sensitive, register it in `runner/anchors.mjs` so future drift only needs a one-file update.

### 2. Decide: inline patch or shim-as-patch?

- **Inline** when the change is a few lines of text replacement. Example: `extensions/input_bar_color.mjs` is 22 lines, just rewrites `promptBorder:"ansi:white"` to `promptBorder:"ansi:green"`.
- **Shim-as-patch** when there's real logic. Put it in a `.mjs` file the patch reads as a template string and injects at the anchor. Example: `core/fetch_interceptor.mjs` keeps a multi-hundred-line `hook` string at module scope so it can also be exposed as `preloadCode`. `core/react_singleton.mjs` delegates entirely to `runner/shims/react-singleton.mjs`.

The shim approach keeps the contributor experience close to writing normal JavaScript and keeps the diff in PRs reviewable.

### 3. Write the patch file

Minimal skeleton:

```js
// extensions/my_patch.mjs
export default {
  category: 'feature',
  description: 'Short, one-line description shown in build output.',
  verify: { present: '__ccpMyPatchExposed_v1' },
  apply: (code) => {
    if (code.includes('__ccpMyPatchExposed_v1')) return code; // idempotent
    const anchor = /someStableLiteral/;
    if (!anchor.test(code)) {
      console.warn('  [!] my_patch: anchor not found');
      return code;
    }
    return code.replace(anchor, /* injection */);
  },
};
```

For AST-anchored patches, prefer `findFunctionByLiteral(code, "stable_string")` over hand-rolled brace counting.

### 4. Register in `ccpatch.yml`

Add a line under the appropriate section. Default to `false` for extensions; only `core/` patches default to `true`. Use the long form when the patch reads env vars:

```yaml
my_patch:
  enabled: false
  env: [CC_MY_PATCH_FOO]
```

### 5. Add a verification test

Open `tests/patch-verification.test.mjs` and add a case. The suite runs three layers per patch: `apply()` must change the input, `verify.present` must hold on the output, and (for injected globals) the IIFE must eval cleanly in a vm sandbox.

Run:

```
make test-patches
```

---

## Patch kinds — prefix / postfix / transpiler

By default a patch is a free-form `apply(code, opts) => string`. That's the maximum-power escape hatch and remains fully supported (`kind: 'free'`, or simply omit `kind`).

For the common case of "do *one* small thing to *one* function", ccpatch also supports three declarative *kinds*, inspired by Harmony (.NET). These narrow the surface area, are easier to review, and compose better than ad-hoc regex.

The target function is located via `target.function`:

- `{ literal: 'STR' }` — find the function whose body contains the quoted string `"STR"`.
- `{ body: 'SUBSTR' }` — find the function whose body contains `SUBSTR` verbatim (use this when the anchor is a property access like `process.env.FOO`, not a string literal).
- `'name'` or `{ name: 'name' }` — find `function name(...) { ... }` by source-level name (rarely useful in minified bundles).

### `kind: 'prefix'` — inject at function entry

```js
export default {
  description: 'short-circuit alwaysThinkingEnabled() when CC_THINKING is set',
  verify: { present: 'CC_THINKING' },

  kind: 'prefix',
  target: { function: { body: 'process.env.MAX_THINKING_TOKENS' } },
  code: 'if(process.env.CC_THINKING)return!0;',
};
```

The string in `code` is spliced verbatim immediately after the function's opening `{`.

### `kind: 'postfix'` — wrap every `return`

```js
export default {
  description: 'force tool dispatch to succeed in dry-run mode',
  verify: { present: '__r' },

  kind: 'postfix',
  target: { function: { literal: 'tool dispatch' } },
  code: 'if(process.env.CC_DRY_RUN)__r={ok:true}',
};
```

Each `return X;` inside the target becomes `return (function(__r){ INJECTED; return __r; })(X);` — your injected code reads or mutates `__r`. Void `return;` becomes `{ INJECTED; return; }`. Returns inside *nested* functions/arrows are not touched.

### `kind: 'transpiler'` — full source-text rewrite, scoped to one function

```js
export default {
  description: 'rewrite the cache key derivation',
  verify: { present: 'sha256' },

  kind: 'transpiler',
  target: { function: { literal: 'cacheKey' } },
  transform: (fnBody, opts) => fnBody.replace('md5', 'sha256'),
};
```

This is the escape hatch — same power as `apply()`, but limited to the bytes of one function. Use it when prefix/postfix don't fit but you still want to keep the rest of the bundle off-limits.

### Notes

- `kind: 'free'` (i.e. `apply(code, opts)`) is **still fully supported** and remains the right choice for cross-cutting transformations.
- Mixing a non-free `kind` with a user-supplied `apply()` is a manifest error — the runner synthesizes `apply` from the declarative fields.
- The synthesized `apply` returns the input unchanged when the target can't be found. Pair the patch with a strong `verify` (use `count` or both `present` *and* `absent`) so a missed anchor surfaces as a verify failure rather than silent drift.

### Codemod: free-form → declarative

About 80% of patches under `extensions/` use the free-form `apply()` escape hatch even when their behavior maps cleanly onto `prefix` / `postfix` / `transpiler`. To find candidates and convert one mechanically:

```bash
# Print a one-line warning per build listing free-form patches that look declarative.
node scripts/check-declarative.mjs

# Convert a single patch in place (Pattern A only — single-function override).
node scripts/codemod-declarative.mjs <patch-name>            # dry-run, prints diff
node scripts/codemod-declarative.mjs <patch-name> --write    # apply
```

**Scope (`codemod-declarative.mjs`):** narrow on purpose. It only rewrites patches whose `apply()` calls `findFunctionByLiteral(code, resolveAnchorLiteral('NAME'))` once and replaces the whole function body with `return !0`. Multi-anchor patches, regex sweeps over the bundle, and patches with side-effect logging stay free-form — convert by hand.

**What the codemod emits:** `kind: 'transpiler'` (not `'prefix'`) because the original drops the entire function body; `transpiler` is the faithful translation. If the override is purely "force-enable", `prefix` with `code: 'return !0;'` is smaller — that optimization is a follow-up.

**Author types (`types/patch.d.ts`):** add a JSDoc directive at the top of your patch file to get editor hints:

```js
/** @type {import('../types/patch').Patch} */
export default { … };
```

The type file is hand-mirrored from `runner/manifest.mjs`. `npm run gen:types` re-runs `scripts/gen-types.mjs` which extracts the validator's `CAPABILITIES` / `KINDS` / `AT_KINDS` / `PHASES` / `CATEGORIES` / `APPLY_MODES` arrays and fails CI if the type unions in `types/patch.d.ts` drift. `npm run gen:types -- --write` rewrites the unions in place.

---

## Overlay loader — shims-as-files, one hook

Most patches inject their shim code directly into the bundle at their own anchor. That works, but every patch is one more anchor that can drift across upstream versions. The **overlay loader** is a Magisk-style "overlay, don't mutate" alternative:

- **One anchor**, owned by `core/overlay_loader.mjs`, that injects a single `require('./ccpatch-overlay.mjs')` into the patched bundle.
- **One sibling file** generated by `runner/overlay-builder.mjs` and written next to the patched bundle as `ccpatch-overlay.mjs`.
- Each opt-in patch declares `overlay: { register, code }`; the builder collects all such blocks into the sibling file and wires them through the existing `__ccpProvide` / `__ccpRequire` registry (see `core/contracts.mjs`).

### How to opt a patch in

```js
// extensions/my_feature.mjs
export default {
  description: 'My feature',
  verify: { present: '#!/usr/bin/env node' },
  capabilities: [],
  overlay: {
    register: 'my-feature',
    code: `
      return {
        version: 1,
        doThing() { /* ... */ },
      };
    `,
  },
  // apply() can be a no-op when the patch lives entirely in the overlay.
  apply: (code) => code,
};
```

Consumers reach the registered value via the normal contract:

```js
const feature = globalThis.__ccpRequire('my-feature', { consumer: 'caller' });
feature.doThing();
```

If the patch still needs a tiny in-bundle hook (for example to call `__ccpRequire(...)` at a specific call site), keep that hook in `apply()`. The overlay mechanism only provides the *registration channel* — in-bundle wiring is still per-patch.

### Trade-offs

- **Pro:** N anchors collapse to 1. The bulk of patch logic lives in plain JS files instead of bundle anchors that can drift.
- **Pro:** Idempotent — re-applying the overlay loader is a no-op.
- **Con:** The patched bundle is no longer a single self-contained file. Shipping it requires copying `ccpatch-overlay.mjs` alongside.
- **Con:** Load failure of the overlay file logs to stderr but does not abort the bundle (by design — overlay is opt-in per patch and missing the file should not brick boot).

A working example with `apply()` as a no-op lives in `extensions/_overlay_example.mjs` (disabled by default).

### Validation rules

The manifest validator (`runner/manifest.mjs`) enforces:

- `overlay` is optional.
- When present, both `overlay.register` and `overlay.code` must be non-empty strings.
- The runner's overlay builder skips patches whose `overlay` field is missing or malformed; combine with a strict `verify` block to surface mistakes.

### Dev mode — hot-reload shims

Editing a shim normally requires re-running `ccpatch apply` and restarting Claude Code. In **dev mode**, `ccpatch-overlay.mjs` becomes a thin loader that re-requires each shim from a sibling `ccpatch-overlay-shims/` directory on every `__ccpRequire(name)[prop]` access — Xposed/LSPosed-style hot-reload.

Opt in with either:

```bash
ccpatch apply <bundle> <output> --dev
# or
CCPATCH_DEV=1 ccpatch apply <bundle> <output>
```

The emitted layout becomes:

```
patched-bundle/
  cli.patched.js
  ccpatch-overlay.mjs            ← thin loader (Proxy per patch)
  ccpatch-overlay-shims/
    cost_tracker.cjs             ← real shim — edit me
    expose_tool_dispatch.cjs
```

**Constraint:** in dev mode the patch's `overlay.code` is written verbatim into a `.cjs` file. It must therefore be a valid CommonJS **module body** that ends with `module.exports = { ... }` — *not* a function body with `return { ... }`. The non-dev (production) path still wraps `code` in an IIFE and uses its return value, so for portability prefer authoring shims as:

```js
overlay: {
  register: 'cost-tracker',
  code: `
    function track(usage) { /* ... */ }
    module.exports = { track };
    // The non-dev IIFE path also accepts this: a bare `module.exports = { ... }`
    // statement is valid inside the wrapper too (returns undefined; the registry
    // value will be the module.exports object instead).
  `,
}
```

For continuous iteration use the watch loop:

```bash
ccpatch watch <bundle> <output>
```

It runs apply once with `--dev`, then watches `core/*.mjs` and `extensions/*.mjs`. Any change triggers a debounced re-emit of `ccpatch-overlay.mjs` + shim files (default debounce 200ms; override with `--debounce <ms>`). The patched bundle is **not** re-patched — only the overlay sidecar is rewritten. A dev-mode bundle is byte-identical to a prod-mode bundle; flip back to prod by re-running `ccpatch apply` without `--dev`.

---

## Per-upstream-version patch directories

When a patch needs a *different implementation* for a different Claude Code version (not just a different anchor regex — that's `runner/anchors.mjs`), use a per-version override directory:

```
core/
  bun_shim.mjs                 # default / fallback
  bun_shim/
    2.1.148.mjs                    # used when bundle is exactly 2.1.148
    >=2.1.150.mjs                  # used when bundle is >= 2.1.150
    >=2.1.150,<2.2.0.mjs           # half-open range
```

This is **opt-in**. Existing flat patches keep working unchanged. The loader uses the variant directory only when one exists alongside the default file (or instead of it).

### Resolution rules

For each patch `<name>` in `core/` or `extensions/`:

1. If `<name>/` exists, scan it for files whose stems are one of:
   - exact: `2.1.148.mjs`
   - range: `>=2.1.150.mjs`, `<2.2.0.mjs`, `>=2.1.150,<2.2.0.mjs`
2. Select the most specific match for the target bundle version:
   - **Exact** match always wins.
   - Otherwise the **narrowest** matching range (highest lower bound; ties broken by lowest upper bound).
3. Fall back to `<name>.mjs`.
4. If neither a default nor a matching variant exists, the build fails with a clear load error.

Any file in a version dir whose stem isn't a parseable version or range is a fatal load error — don't park unrelated files in there.

### testedAgainst (required on variants)

Every per-version variant file must declare a `testedAgainst` field whose value matches its filename stem:

```js
// core/bun_shim/2.1.148.mjs
export default {
  description: '...',
  testedAgainst: ['2.1.148'],
  verify: { ... },
  apply: (code) => { ... },
};
```

Mismatch between the filename stem and `testedAgainst` is a fatal manifest error. `testedAgainst` is optional on default files but recommended.

### Inspecting variants

```
ccpatch versions                          # list variant dirs and would-be picks
ccpatch versions --target-version 2.1.150 # simulate for a specific version
```

The patch-results JSON (`storage/outputs/patch-results-v<X>.json`) records `resolvedVariant` per patch so post-mortems can tell which file actually ran.

---

## Refmaps — automated anchor resolution

A refmap is a JSON sidecar (`refmaps/<ccVersion>.json`) that maps each anchor
ID from `runner/anchors.mjs` to the *current* minified function name and byte
offset in a specific upstream bundle. It's the automated counterpart of the
per-version regex overrides you can hand-write in `runner/anchors.mjs`.

```json
{
  "ccVersion": "2.1.148",
  "generatedAt": "2026-05-22T10:30:00Z",
  "bundleSha256": "…",
  "anchors": {
    "isDurableCronEnabled": { "fn": "Wj7", "offset": 8412091 },
    "isLoopDynamicEnabled":  { "fn": "yK2", "offset": 8389044 }
  },
  "misses": []
}
```

### When to regenerate

Whenever a new Claude Code release lands and you've reconstructed its bundle
(`make reconstruct VERSION=<x.y.z>`), regenerate the refmap so anchors with
only a `default` regex still resolve cleanly on the new minifier output:

```
node tools/build-refmap.mjs releases/<x.y.z>/cli.v<x.y.z>.cjs \
  --cc-version <x.y.z>
# or, equivalently:
ccpatch refmap releases/<x.y.z>/cli.v<x.y.z>.cjs --cc-version <x.y.z>
```

Refmaps live under `refmaps/` keyed by ccVersion. Check them in so
contributors don't need a local reconstruct to get correct anchor resolution
for shipped releases.

### CI drift detection

Use `--check` to fail CI when the on-disk refmap is stale:

```
ccpatch refmap releases/<x.y.z>/cli.v<x.y.z>.cjs --cc-version <x.y.z> --check
```

Exit code 0 = on-disk matches a fresh generation; 1 = drift, regenerate.

### How refmaps interact with `runner/anchors.mjs`

`resolveAnchor(id, version)` resolves an anchor pattern in this order:

1. **Version-pinned regex entry** in `runner/anchors.mjs`
   (`anchors[id][version]`) — wins outright. Use this for anchors whose
   *shape* (not just function name) differs in a specific release.
2. **Refmap entry** at `refmaps/<version>.json` — synthesises a
   `function <fn>` regex from the resolved symbol. Use this for the common
   case: same shape, different minified name.
3. **Default regex** (`anchors[id].default`) — final fallback. Sufficient
   when no version-specific drift has been observed yet.

Only anchors that declare a stable string `literal` are eligible for refmap
generation; anchors without a `literal` are listed under `misses` in the
generated JSON so you can see what was skipped.

### Refmaps vs per-version patch directories

These are **complementary**:

- **Per-version patch directories** (`core/<name>/<version>.mjs`) ship a
  different implementation per release — for when the patch body itself must
  change.
- **Refmaps** ship the *same* patch code but resolve a different minified
  symbol per release — for when only the function name changes.

If a release breaks anchor resolution but the patch logic still applies,
regenerating the refmap is usually enough. If the patch logic needs to
change, reach for per-version patch directories.

---

## Anchor drift troubleshooting

When a patch produces no changes, the runner does two things:

1. Logs `[!] Patch "<name>" produced no changes. (check anchors)` and any fuzzy candidates with similarity scores.
2. Appends a structured entry to `storage/outputs/anchor-drift.jsonl` tagged with the patch name and version, including up to three near-miss candidates.

The fuzzy matcher (`runner/anchors.mjs::fuzzyMatch`) extracts the stable string literals from the failing pattern, scans the bundle for them, and ranks 200-char windows by token overlap. The top candidate is usually within a handful of bytes of the real new anchor.

`ccpatch doctor <cli.cjs>` surfaces these in a one-line-per-patch report. Status codes:

- `OK` — anchor matched and `verify` passed.
- `DRIFT` — verify passed but the anchor needed a fuzzy fallback (review the candidate).
- `UNVERIFIED` — verify only contains `present` with no `absent`/`count`. Warning, not failure. Promote with `--strict`.
- `MISSING` — anchor not found, or verify failed.

Doctor exits 1 if any patch is `MISSING`. With `--strict` (or `CCPATCH_STRICT=1`), it also exits 1 when any patch is `UNVERIFIED`.

---

## Priority and overlap detection

Two patches that target the same anchor or the same byte range will silently
fight unless you give the runner enough information to order and audit them.
ccpatch exposes two manifest fields for that.

### `priority` — ordering peers within a phase

```js
export default {
  description: 'extends tool dispatch',
  phase: 'main',
  priority: 500,       // lower runs first (default: 1000)
  // ...
};
```

`priority` is an optional integer. Within a single phase, the runner sorts:

1. **`phase`** (`pre` → `main` → `post`)
2. **`dependsOn`** — a patch never precedes a patch it (transitively) depends on
3. **`priority`** ascending
4. Topo position (stable fallback)

`dependsOn` is authoritative: if `B` depends on `A`, `A` runs first regardless
of `priority`. `priority` only orders peers that have no dependency
relationship. Use it sparingly — most pairs should be declared via `dependsOn`,
which is self-documenting. `priority` is for **ordering hints among independent
patches** (e.g. "this prompt-shaping patch should run before any other prompt
mutator").

Validation: `priority` must be a finite integer. Floats and strings are
rejected at manifest validation time.

### `allowOverlapWith` — acknowledging an overlap

After every phase, the runner detects pairs `(A, B)` where:

- **`at-vs-at`** — both declare `at` selectors and their resolved sites
  intersect.
- **`at-vs-diff`** — `B`'s resolved `at` sites land inside the byte range that
  `A`'s `apply()` actually mutated (line resolution; see caveats).
- **`diff-vs-diff`** — both patches' diff spans intersect.

Each conflict is logged and appended to
`storage/outputs/patch-conflicts.jsonl` as one record per pair:

```json
{ "ts": "...", "phase": "main", "a": "patchA", "b": "patchB",
  "overlap": { "kind": "at-vs-diff", "rangeA": [123, 456], "rangeB": [400, 500] },
  "allowed": false }
```

**Overlap is a smell, not always a bug.** Two patches editing nearby lines can
still produce the right result. But when two patches touch the same byte
range, the *order* matters and `last-writer-wins` is silently fragile.

In **strict mode** (`--strict` or `CCPATCH_STRICT=1`), every unacknowledged
overlap is a fatal error. Acknowledge the pair by declaring `allowOverlapWith`
on at least one side:

```js
export default {
  name: 'expose_tool_dispatch',
  allowOverlapWith: ['expose_agent_tool'],
  // ...
};
```

The allowlist is the escape hatch: using it forces the author to name the
specific peer, which forces a quick review of why the overlap is intentional.
Wildcards aren't supported on purpose.

Validation: `allowOverlapWith` must be an array of non-empty strings. Each
string is a peer patch name (filename stem).

### Caveats and limitations

- **Line-resolution diff spans.** The runner computes "what byte range did
  this patch touch" from the unified diff hunks the reverse-diff sidecar
  already produces. That means each hunk yields one range spanning whole
  lines. A small edit on a long line will be reported as a wider range than
  the actual mutation, so the overlap detector can produce false positives on
  large single-line bundles (i.e. minified code on a single line). When you
  see a false positive, the right fix is to acknowledge it via
  `allowOverlapWith`, then file an issue to refine the detector.

- **Cross-patch coordinate drift.** Each patch sees a different code state
  (the post-previous-patch buffer). Comparing `A.diffSpan` (in A's preCode)
  to `B.atSite` (in B's preCode = post-A) is approximate — offsets shift by
  the net delta A introduced. The detector is intentionally a "smell"
  rather than a proof.

- **Single-phase only.** Overlap detection runs per phase. A `pre`-phase
  patch overlapping a `main`-phase patch is intentional by design (phases
  exist to sequence such pairs) and is not flagged.

---

## Fallback diffs — best-effort when anchors drift

Inspired by [`patch-package`](https://github.com/ds300/patch-package), every patch may ship an optional **stored unified diff** the runner consults when the structured `apply()` produces no change (a likely anchor drift). The fallback is a stop-gap so a single drifted patch doesn't break the whole build — it is **not** a substitute for re-anchoring once upstream actually changes.

### Manifest field

```js
export const fallbackDiff = {
  // patch-package-style unified diff captured against a known bundle version.
  patch: `--- a/cli.js
+++ b/cli.js
@@ -1,3 +1,4 @@
 ...`,
  // CC version this diff was captured against (informational; logged on use).
  capturedAgainst: '2.1.148',
  // Fuzz context (lines on each side that may mismatch). Default 3.
  fuzz: 3,
};
```

Validation:

- `patch: string` required.
- `capturedAgainst: string` required.
- `fuzz: number ≥ 0` optional (default `3`). Forwarded as `fuzzFactor` to `diff.applyPatch`.

### Runtime behavior

1. `apply()` runs as today.
2. If the result equals the input (no change) **and** `fallbackDiff` is present, the runner calls `applyPatch(code, fallbackDiff.patch, { fuzzFactor })`.
3. Success: logs `[fallback] <name>: stored-diff applied (fuzz=N, capturedAgainst=…)` and proceeds with `verify`.
4. Failure: drops back to the existing hard-drift path (warning + `storage/outputs/anchor-drift.jsonl`).

Skip the fallback entirely with `--no-fallback` (or programmatically via `patchOptions.disableFallback = true`).

### Capturing a fallback diff

When you ship a patch that targets a fragile minified site, freeze the patched bytes against the unpatched bundle:

```sh
ccpatch fallback-capture path/to/patched-cli.js \
  --against path/to/unpatched-cli.js \
  --patch my_patch_name > /tmp/my_patch.fallback.diff
```

Paste the diff into your patch module's `fallbackDiff.patch` field and set `capturedAgainst` to the CC version you captured against. The CLI is one-shot — it does not auto-edit your patch file.

### Warning

A fallback diff that keeps applying release after release is a smell, not a feature. It means the patch's structured anchor is no longer in sync with reality. When you see `[fallback]` in a build log, treat it like a TODO: open the bundle, find the new anchor, and update the patch so `apply()` succeeds again.

---

## Patch lifecycle hooks

Three optional exports let a patch react to its own apply lifecycle. They are inspired by BepInEx / Fabric and run inside `applyNamedPatches` around the normal apply step.

```js
export async function onBeforeApply(ctx) { /* mutate ctx.opts or ctx.code */ }
export async function onAfterApply(ctx)  { /* mutate ctx.appliedCode */ }
export async function onVerifyFail(ctx)  { /* return string → retry verify */ }
```

`ctx` is a single per-patch object reused across all hook fires. Fields:

| Field             | When set            | Notes                                                     |
| ----------------- | ------------------- | --------------------------------------------------------- |
| `name`            | always              | Patch name (filename stem).                               |
| `phase`           | always              | `pre` / `main` / `post`.                                  |
| `code`            | onBeforeApply       | Input code into `apply()`. Mutable.                       |
| `appliedCode`     | onAfterApply, onVerifyFail | Output of `apply()` (or fallback). Mutable on onAfterApply. |
| `opts`            | always              | Shallow copy of patchOptions for this patch. Mutable on onBeforeApply. |
| `verify.issues`   | onVerifyFail        | Array of failure descriptions from `checkVerify`.        |
| `attempt`         | always              | `1` on first apply, `2` on the post-onVerifyFail retry.  |
| `logger`          | always              | The runner's logger.                                      |

**Retry contract.** `onVerifyFail` may return a string. If it does, the runner runs `checkVerify` once more against that string. **One retry, ever.** If verify still fails (or the hook returned anything other than a string), the original failure stands and the patch fails per its strictness mode.

**Errors.** A hook that throws is logged as `[hook] <name>.<hookName>` and is treated as the corresponding failure (apply throw / verify fail). Hooks are not swallowed silently.

**Telemetry.** Every hook fire writes one JSONL line to `storage/outputs/patch-lifecycle.jsonl`:

```json
{ "ts": "2026-05-22T...", "patch": "message_normalizer",
  "hook": "onAfterApply", "attempt": 1, "phase": "main",
  "byteDelta": 412, "durationMs": 5 }
```

Hooks that throw still produce an entry with an `error` field. See `core/message_normalizer.mjs` for a real-world `onAfterApply` self-check.

---

## Dry-run shadow mode

`--dry-run` runs the full apply pipeline into memory and then compares the
unpatched and patched bundles along four dimensions that `verify.present`
on its own cannot catch:

- **bytes** — patched bundle is byte-identical to the input (no patch did
  anything).
- **verify** — a `verify.present` sentinel already exists in the unpatched
  bundle. This is the "weak verify" case: the verify block would pass even
  if the patch's `apply()` were the identity function.
- **parse** — `acorn` rejects the patched bundle but accepted the
  unpatched one. The patch broke syntax.
- **forbidden** — a substring listed in the patch's `forbiddenAfterPatch`
  manifest field appears in the patched bundle. Useful for guarding against
  stray `console.log`, `debugger`, etc.

### Example

```bash
# Just check — no file is written.
node bin/patch-cli.mjs cli.js cli.patched.js --dry-run

# Build only if shadow report has zero anomalies.
node bin/patch-cli.mjs cli.js cli.patched.js --dry-run --write-on-clean

# In CI, promote any anomaly to a non-zero exit.
node bin/patch-cli.mjs cli.js cli.patched.js --dry-run --strict --version 2.1.148
```

### Opting in to `forbiddenAfterPatch`

Add the field to any patch manifest:

```js
export const forbiddenAfterPatch = ['console.log(', 'debugger;'];
```

Validated as `string[]` by `runner/manifest.mjs`. An empty/missing field
means the shadow check skips the `forbidden` dimension for that patch.

Shadow mode catches semantic drift that `verify.present` can't: a verify
block that *looks* strict can still pass against a no-op apply if its
sentinel happens to collide with vocabulary already in the upstream
bundle. The shadow check forces the sentinel to be a *delta* between the
two bundles, not just a substring of the patched one.

---

## REPL — interactive poking of a patched bundle

Frida-style: spawn the patched bundle in a sandboxed child process, then drop
into a REPL where every expression is evaluated inside the child. Useful for
inspecting what your patch published into `__ccpRegistry`, calling exposed
APIs (`__ccpApiClient`, `__ccpToolDispatch`, ...), or experimenting with shim
shapes without writing a one-off test script.

```
ccpatch repl <patched-bundle.mjs>
```

Only `.mjs`/`.js`/`.cjs` bundles are supported in v1 — Bun-compiled binaries
are out of scope. The child enforces a 5-second per-eval timeout; if your
expression exceeds it, the child is killed and respawned automatically.

Meta-commands (prefix with `:`):
- `:list` — print the contents of `globalThis.__ccpInspectContracts()` (or
  the keys of `__ccpRegistry` if the contracts kernel isn't loaded).
- `:reload` — kill and respawn the child. The patched bundle re-runs from
  scratch, so any state mutated during the session is discarded.
- `:quit` (`:q`) — exit.

Example session:

```
$ ccpatch repl storage/outputs/2.1.148/cli.patched.js
__ccpRegistry: 3 entries
  apiClient                producer=expose_api_client v1 type=object shape=[messages.stream]
  agentTool                producer=expose_agent_tool v1 type=object shape=[_capture]
  toolDispatch             producer=expose_tool_dispatch v2 type=function
ccp> globalThis.__ccpRequire('apiClient', { consumer: 'repl' }).constructor.name
"Anthropic"
ccp> :list
[ { name: "apiClient", version: 1, producer: "expose_api_client", shape: ["messages.stream"] }, ... ]
ccp> :quit
```

---

## PR checklist

- [ ] One patch per PR, or a tight cluster (e.g. a core fix plus its dependent extension).
- [ ] Manifest fields complete: `description`, `verify`, `category` where applicable.
- [ ] `apply()` is idempotent (guard with a sentinel string).
- [ ] No anchor drift on the current `VERSION` from npm: `make patch-claude-code` succeeds.
- [ ] `make test-patches` passes.
- [ ] If the patch introduces a new exposed global, it follows the `__ccp*` naming convention and is documented in the patch's header comment.
- [ ] If the patch reads env vars, they're listed in `manifest.env` and in the `ccpatch.yml` long form.
- [ ] If the patch is version-sensitive, an entry is added to `runner/anchors.mjs`.

---

## Reversible patches

Every successful `node bin/patch-cli.mjs <input> <output>` run also writes a
reverse-diff sidecar to `<output>.ccp-revert.json`. The sidecar lets you
restore the original bundle without re-extracting from the upstream package.

Sidecar shape:

```json
{
  "version": 1,
  "timestamp": "2026-01-15T12:34:56.000Z",
  "ccVersion": "2.1.148",
  "inputSha256": "…",
  "outputSha256": "…",
  "patches": [
    { "name": "<patch>", "reverseDiff": "<unified diff>", "preSha256": "…", "postSha256": "…" }
  ]
}
```

- Each entry's `reverseDiff` is a unified diff produced by `diff.createPatch`
  that, applied to the post-state, returns the pre-state for that patch only.
- No-change applies are omitted (they would contribute an empty diff).
- The sidecar is captured by the runner — patches themselves are unchanged.

Two CLI commands consume the sidecar:

```
node bin/patch-cli.mjs revert  <patched.js> [--output <restored.js>]
node bin/patch-cli.mjs diff    <patched.js>
```

`revert` applies the reverse diffs in reverse order and asserts the final
sha256 matches `inputSha256`. `diff` prints per-patch added/removed line
counts. Both commands only support `.mjs`/`.js`/`.cjs` targets in v1 — Bun
binary repack reversal is out of scope.

---

## Governance: what gets merged

**Accepted without much discussion:**

- Bug fixes for issues reproducible against the upstream bundle.
- Quality-of-life patches that are clearly opt-in and don't change semantics for users who leave them off.
- Patches that expose existing internals via `__ccp*` globals for tooling, without altering CLI behavior.
- Observability patches that record locally and ship nothing off-machine by default.

**Flagged for discussion before merge:**

- Patches that change which model is called or alter routing.
- Patches that touch billing-adjacent surfaces (cost reporting that overrides upstream, rate-limit bypass that affects accounting).
- Patches that unlock unreleased or server-gated features when there's reason to believe Anthropic intends them to remain gated.
- Patches that send data off-machine by default (e.g. webhook destinations) — these must be strictly opt-in via env var.

The bar for the second list isn't "no" — it's "open an issue first so we can discuss scope and defaults." The goal is for ccpatch to remain a tool a user can hand to a colleague without explaining a list of footguns.

## @At selectors — declarative anchor vocabulary

Patches may declare an `at` manifest field that names *where* in the bundle they
want to attach, decoupled from *what* they inject. The runner resolves the
selector once (using stable string literals and Acorn over windowed ranges, not
the whole 16 MB bundle), then passes the resolved byte ranges to your `apply()`
via `opts.atSites`. Helper splicers live in `runner/at-selector.mjs`.

A patch that declares `at` MUST still export `apply()` — the helper consumes
the sites; the runner does not splice for you.

### `HEAD` — attach at function entry

```js
import { injectAtHead } from '../runner/at-selector.mjs';

export default {
  description: 'log every call to fooFn',
  verify: { present: '__fooEntry' },
  at: {
    kind: 'HEAD',
    target: { function: { literal: 'tengu_kairos_cron_durable' } },
    //         or       { function: 'fooFn' }
  },
  apply(code, opts) {
    return injectAtHead(code, opts.atSites[0], 'console.log("__fooEntry");');
  },
};
```

### `RETURN` — wrap every return

```js
import { injectAtReturn } from '../runner/at-selector.mjs';

export default {
  description: 'force fooFn to always return true',
  verify: { present: '!0/*forced*/' },
  at: { kind: 'RETURN', target: { function: 'fooFn' } },
  apply(code, opts) {
    return injectAtReturn(code, opts.atSites, (expr) => `!0/*forced*/`);
  },
};
```

For void returns (`return;`), pass `{ voidFragment: '...' }` as the third arg.

### `INVOKE` — wrap a call site

```js
import { injectAround } from '../runner/at-selector.mjs';

export default {
  description: 'instrument 2nd call to dispatch() inside host()',
  verify: { present: '__pre()' },
  at: {
    kind: 'INVOKE',
    target: { call: 'dispatch', occurrence: 2, in: 'host' },
  },
  apply(code, opts) {
    return injectAround(code, opts.atSites[0], '__pre()', '__post()');
  },
};
```

Omit `occurrence` to wrap every call. Omit `in` to scan the whole bundle.

### `BEFORE` / `AFTER` — relative to a string literal

```js
import { injectAt } from '../runner/at-selector.mjs';

export default {
  description: 'inject banner right after the shebang line',
  verify: { present: '__ccpBanner' },
  at: { kind: 'AFTER', target: { literal: '#!/usr/bin/env node' } },
  apply(code, opts) {
    return injectAt(code, opts.atSites[0], '\n// __ccpBanner');
  },
};
```

Use `occurrence` (1-indexed) to pick the Nth match. Resolution failure returns
fuzzy-match candidates from `anchors.fuzzyMatch`, which the runner logs.

### When NOT to use `at`

- One-off `String.replace` against a unique literal is fine; don't reach for
  `at` when there's nothing to declare.
- Patches that rewrite an entire function (e.g. `durable_cron`) can still
  declare `at` for documentation and drift-detection value, but the apply()
  body may keep doing its existing work.

## Third-party patch modules

Patches don't have to live in this repo. A *module* is a small package that
ships one or more patches plus a manifest. Users install modules into the
project-local `modules/` directory and reference them in `ccpatch.yml` the
same way they do built-in patches.

### Module layout

```
my-patches/
  ccpatch-module.json     # manifest
  patches/
    foo.mjs               # standard ccpatch patch (same contract as core/)
    bar.mjs
```

`ccpatch-module.json`:

```json
{
  "name": "@author/my-patches",
  "version": "1.2.0",
  "author": "name <email>",
  "description": "What these patches do.",
  "updateChannel": "https://example.com/ccpatch-modules/my-patches/manifest.json",
  "signature": null,
  "minCcpatch": "0.1.0",
  "patches": ["foo", "bar"]
}
```

- `name` is shown to users and namespaces the patches. Slashes are allowed
  (npm-style scopes like `@author/pkg`); the directory on disk uses `__` in
  place of `/`.
- `patches` lists the file stems (without `.mjs`) shipped under `patches/`.
- `signature`, if set, is the sha256 of the `patches/` tree computed by
  `hashPatchesTree` (sorted file walk, content-only, ignores non-`.mjs`).
- `updateChannel` is optional. If set, it must serve JSON of the form
  `{ "version": "1.3.0", "url": "https://.../my-patches-1.3.0.tgz",
     "signature": "<sha256>" }`.

### Loading & naming

Module patches load alongside `core/` and `extensions/`. The loader exposes
each module patch as `<module-name>/<stem>`. Reference them in `ccpatch.yml`
under `patches:` like any built-in:

```yaml
patches:
  '@author/my-patches/foo': true
  '@author/my-patches/bar': false
```

Slash-namespaced patch names are *only* accepted for module patches — built-in
patch names cannot contain `/`.

### CLI

```bash
# Install from a local path (development workflow)
ccpatch module install ../my-patches

# Install from an HTTP(S) tarball
ccpatch module install https://example.com/my-patches-1.2.0.tgz

# Strict capability gate — required when the module declares high-risk
# capabilities (network/tools/exec/telemetry). See THREAT_MODEL.md.
ccpatch module install ./my-patches --strict --allow-capabilities=network,telemetry

# Inspect & manage
ccpatch module list
ccpatch module verify @author/my-patches
ccpatch module update  @author/my-patches
ccpatch module remove  @author/my-patches
```

Git URLs are out of scope in v1; clone manually and point `install` at the
local checkout.

### Security caveats

- **Unsigned modules load but warn.** When `signature` is missing, the install
  command logs an `UNSIGNED` notice. The hash printed by `module verify` lets
  a user pin a known-good checksum out-of-band before enabling the module.
- **Capabilities are self-declared.** The same `capabilities` array used by
  core patches is honoured for module patches and feeds into the existing
  `--allow-capabilities` gate at apply time and at install time.
- **Imports happen in-process.** `module install` imports each patch to read
  its declared capabilities. This is *disclosure*, not sandboxing — auditing
  the source under `modules/<name>/patches/` before enabling the module is
  the actual trust boundary.
- **Update channels are not signed by ccpatch.** A compromised update endpoint
  can replace the tarball. Pin a known signature locally if that matters.

### Verifying signatures

The signature in `ccpatch-module.json` is a hex sha256 over the sorted
`patches/` tree (file content only — non-`.mjs` files are excluded). Compute
it with:

```bash
node -e "import('./runner/modules.mjs').then(m => console.log(m.hashPatchesTree('my-patches/patches')))"
```

Paste the digest into the manifest's `signature` field, then `ccpatch module
verify` will report `OK` after install. A tampered patch file makes the
verifier exit non-zero.

## Coverage — apply-time + runtime instrumentation

A patch can apply cleanly (anchor resolves, `verify` block passes) and still
be dead code at runtime: the surrounding branch is feature-flagged off, the
upstream code path was removed, or the injection landed in a function nobody
calls in this CC version. Build-time verification cannot tell you any of that.

ccpatch ships two-sided coverage, inspired by DynamoRIO/Pin:

1. **Apply-time coverage** is captured automatically. After every
   `applyNamedPatches` run, the runner writes
   `storage/outputs/coverage-apply-v<ccVersion>.json` recording
   `{ phase, applied, status, diffSpans, coverageMarker?, reason? }` per
   patch — the same data the existing per-version `patch-results-*.json`
   exposes, plus the marker name.

2. **Runtime coverage** is opt-in. A patch sets `coverageMarker: 'my-name'`
   in its manifest, and the runner injects a
   `(globalThis.__ccpCovHit && globalThis.__ccpCovHit('my-name'));` call into
   the patched code at the first inserted line of the diff (or, when an `@At`
   selector is present, at the resolved site). The `coverage_kernel` patch
   maintains `globalThis.__ccpCoverage` and dumps it on `SIGTERM` and on
   `exit` as a `__CCP_COV__<json>` line on stdout.

`ccpatch coverage <patched-bundle> [--smoke <cmd>] [--out report.json]` runs
the bundle (default smoke: `node <bundle> --version`), parses the dump, and
cross-references it with the apply-time manifest:

```
Patch                  Applied  Hit   Status
cost_tracker           yes      yes   LIVE
durable_cron           yes      no    DEAD
plan_mode_interview    no       -     SKIPPED
```

- `LIVE` — applied AND instrumented marker fired at runtime.
- `DEAD` — applied but the instrumented marker never fired. The patch's
  injected code is unreachable in this CC version. **This is a signal to
  delete or revisit the patch, not always a bug** — a feature flag may be
  off, or upstream may have rotated away from the anchored code path. Use
  the `revisit` marker to track temporary forensic patches; use coverage to
  catch the rest.
- `SKIPPED` — patch did not apply (anchor drift, disabled, etc.) so no
  runtime check is possible.
- `UNINSTRUMENTED` — patch applied but did not declare a `coverageMarker`.
  No verdict either way.

`ccpatch coverage` exits non-zero if any `DEAD` patches are found, so CI can
fail the build on "ship it forever" rot:

```bash
make patch-coverage VERSION=2.1.148
# or:
ccpatch <input> <output> --version 2.1.148
ccpatch coverage <output> --cc-version 2.1.148 --out coverage.json
```

The instrumentation is best-effort: when the runner can't find a sensible
site (e.g. the patch replaces a whole function wholesale without leaving a
fresh inserted line), it logs `[coverage] <patch>: no instrumentation site
found, skipping` and proceeds — the patch still applies, but won't surface
in the report. A future revision can teach declarative kinds
(`prefix`/`postfix`) to emit hits unconditionally.
