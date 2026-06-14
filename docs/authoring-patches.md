# Authoring patches

This is the patch author's manual: the patch contract, how to add a new one,
the declarative kinds, the overlay loader, fallback diffs, dry-run shadow mode,
the REPL, coverage, overlap detection, and third-party modules.

For the field-by-field manifest reference see
[manifest-reference.md](./manifest-reference.md). For anchoring strategy see
[anchors.md](./anchors.md) and [finding-anchors.md](./finding-anchors.md). For
the lifecycle hooks see [lifecycle-hooks.md](./lifecycle-hooks.md).

> **Which pattern do I use?** Bundle mutation vs. boot-time code vs. shipping an
> agent — and declarative `kind` vs. a helper vs. hand-written `apply()` — are
> all answered by ONE canonical decision tree:
> **[patch-decision-tree.md](./patch-decision-tree.md)**. Read it before
> reaching for `apply()`.

> **Writing your first patch?** You only need the first three sections —
> **The patch contract**, **Add a new patch**, and **Patch kinds** (run
> `make new-patch NAME=…` to scaffold one). Skip everything below
> *Overlay loader* (overlays, fallback diffs, shadow mode, REPL, coverage,
> third-party modules) until you actually need it. This mirrors the layered
> on-ramp in the [README](../README.md#which-entry-point-should-i-use).

---

## The patch contract

Every patch is a single `.mjs` file under `core/` or `extensions/` that
default-exports an object with three load-bearing parts:

1. **Anchor** — how the patch locates its injection or rewrite site. Either a
   stable string literal, a regex against the minified bundle, or an AST anchor
   resolved via `runner/ast-anchor.mjs` (`findFunctionByLiteral`, windowed Acorn
   parse).
2. **Transform** — an `apply(code, opts) => string` function that returns the
   modified bundle. Must be idempotent: re-applying must be a no-op (typically
   guarded by a sentinel string the patch itself injects).
3. **Invariant test** — a `verify` block. The runner asserts it immediately
   after `apply()` returns and fails the patch if any assertion doesn't hold.

The `verify` block is **required** for every patch. It must contain at least one
of `verify.present`, `verify.absent`, or `verify.count` — see the
[VerifyBlock reference](./manifest-reference.md#verify-verifyblock) for exact
semantics. A patch without a `verify` block is rejected at load time before any
apply runs — there is no opt-out. `verifyExempt` is no longer supported; provide
a real assertion.

Pick the strongest verify you can derive by reading your own `apply()`. A
`present`-only verify is "weak" — `ccpatch doctor` reports it as `UNVERIFIED`
because a wrong-location apply could leave the sentinel matching an unrelated
string elsewhere in the bundle. In `--strict` mode, `UNVERIFIED` is treated as
failure.

Optional manifest fields you'll see in real patches: `category`, `phase`
(`pre | main | post`), `dependsOn`, `env`, `tags`, `required`, `preload` +
`preloadCode`. See [manifest-reference.md](./manifest-reference.md) for the full
schema (the source of truth is `runner/manifest-schema.mjs`).

**Boot-time code** is a special case: a patch that needs code to run before the
bundle body declares `bootInject: { code, order, sentinel? }` instead of writing
its own shebang/CJS-IIFE splice in `apply()`. The runner's boot registry
(`runner/boot-registry.mjs`) collects all enabled patches' blocks and performs
exactly ONE insertion at the canonical boot anchor, sorted by `order` (gaps of
10; see the reserved slots in EXTENSIONS_API.md). Boot-only patches may omit
`apply()` entirely; idempotency comes from the sentinel (defaults to the first
`verify.present` literal).

---

## Add a new patch

### 0. Scaffold the file (recommended)

The fastest start is the scaffolder (`bin/scaffold-patch.mjs`), which emits a
canonical, manifest-valid patch file — `// @ts-check` + the `@type {Patch}`
JSDoc, a sentinel-backed `verify`, and a clearly-marked `TODO` anchor — and
appends a fixture stub to `tests/fixtures/registry.mjs` so the patch is wired
into the verification suite from the start:

```
make new-patch NAME=my_feature                         # default kind=prefix, extensions/
make new-patch NAME=hide_banner CATEGORY=core KIND=free
make new-patch NAME=unlock_thing KIND=flag             # forceFeatureFlag helper stub
```

Or call the script directly for the full flag set:

```
node bin/scaffold-patch.mjs my_logger --kind=postfix
node bin/scaffold-patch.mjs --help
```

`KIND` is one of the four declarative kinds — `prefix` (default), `postfix`,
`transpiler`, `free` (see [Patch kinds](#patch-kinds--prefix--postfix--transpiler)
below) — plus two `apply()`-helper kinds: `splice` (a boot-time IIFE via
`spliceBoot`) and `flag` (force a `tengu_*` feature flag via `forceFeatureFlag`).
`CATEGORY` selects the target tree: `extension` (default) → `extensions/`, `core`
→ `core/`.

Every template passes `validateManifest()` and the loader's verify gate
immediately, so a fresh patch loads before you've even found its anchor — it just
no-ops until you replace the `TODO_STABLE_LITERAL` placeholder. The scaffolder
does **not** edit `ccpatch.yml`; registering the patch is the manual one-liner in
step 4. Then continue with the steps below to find your anchor and write a test.

### 1. Find your anchor

Reconstruct the bundle for the version you're targeting and read it:

```
make reconstruct VERSION=2.1.148
```

This drops a beautified tree under `storage/outputs/reconstructed-v2.1.148/`.
Identify the smallest stable string near where you want to act. Good anchors
are:

- Feature flag keys (e.g. `"tengu_kairos_cron_durable"`).
- Distinct error messages.
- Unique combinations of named parameters (e.g. five argument names co-located
  in one `Promise.all`).

Avoid anchoring on minified identifiers — they rotate every release.

If your anchor is version-sensitive, register it in `runner/anchors.mjs` and
resolve it with `findFunctionByLiteral` — this is the canonical approach; see
[anchors.md](./anchors.md) for the full rationale and example.

### 2. Decide: inline patch or shim-as-patch?

- **Inline** when the change is a few lines of text replacement. Example:
  `extensions/input_bar_color.mjs` is 22 lines, just rewrites
  `promptBorder:"ansi:white"` to `promptBorder:"ansi:green"`.
- **Shim-as-patch** when there's real logic. Put it in a `.mjs` file the patch
  reads as a template string and injects at the anchor. Example:
  `core/fetch_interceptor.mjs` keeps a multi-hundred-line `hook` string at
  module scope so it can also be exposed as `preloadCode`.
  `core/react_singleton.mjs` delegates entirely to
  `runner/shims/react-singleton.mjs`.

The shim approach keeps the contributor experience close to writing normal
JavaScript and keeps the diff in PRs reviewable.

### 3. Write the patch file

If you scaffolded in step 0, the file already has this shape — search for
`TODO` and fill in the anchor and body. Minimal skeleton for reference:

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

For AST-anchored patches, prefer `findFunctionByLiteral(code, "stable_string")`
over hand-rolled brace counting.

### 4. Register in `ccpatch.yml`

Add a line under the appropriate section. Default to `false` for extensions;
only `core/` patches default to `true`. Use the long form when the patch reads
env vars:

```yaml
my_patch:
  enabled: false
  env: [CC_MY_PATCH_FOO]
```

### 5. Add a verification test

Open `tests/patch-verification.test.mjs` and add a case. The suite runs three
layers per patch: `apply()` must change the input, `verify.present` must hold on
the output, and (for injected globals) the IIFE must eval cleanly in a vm
sandbox.

Run:

```
make test-patches
```

---

## Patch kinds — prefix / postfix / transpiler

By default a patch is a free-form `apply(code, opts) => string`. That's the
maximum-power escape hatch and remains fully supported (`kind: 'free'`, or
simply omit `kind`).

For the common case of "do *one* small thing to *one* function", ccpatch also
supports three declarative *kinds*, inspired by Harmony (.NET). These narrow the
surface area, are easier to review, and compose better than ad-hoc regex.

The target function is located via `target.function`:

- `{ literal: 'STR' }` — find the function whose body contains the quoted string
  `"STR"`.
- `{ body: 'SUBSTR' }` — find the function whose body contains `SUBSTR` verbatim
  (use this when the anchor is a property access like `process.env.FOO`, not a
  string literal).
- `'name'` or `{ name: 'name' }` — find `function name(...) { ... }` by
  source-level name (rarely useful in minified bundles).

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

The string in `code` is spliced verbatim immediately after the function's
opening `{`.

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

Each `return X;` inside the target becomes
`return (function(__r){ INJECTED; return __r; })(X);` — your injected code reads
or mutates `__r`. Void `return;` becomes `{ INJECTED; return; }`. Returns inside
*nested* functions/arrows are not touched.

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

This is the escape hatch — same power as `apply()`, but limited to the bytes of
one function. Use it when prefix/postfix don't fit but you still want to keep the
rest of the bundle off-limits.

### Notes

- `kind: 'free'` (i.e. `apply(code, opts)`) is **still fully supported** and
  remains the right choice for cross-cutting transformations.
- Mixing a non-free `kind` with a user-supplied `apply()` is a manifest error —
  the runner synthesizes `apply` from the declarative fields.
- The synthesized `apply` returns the input unchanged when the target can't be
  found. Pair the patch with a strong `verify` (use `count` or both `present`
  *and* `absent`) so a missed anchor surfaces as a verify failure rather than
  silent drift.

### Codemod: free-form → declarative

About 80% of patches under `extensions/` use the free-form `apply()` escape
hatch even when their behavior maps cleanly onto `prefix` / `postfix` /
`transpiler`. To find candidates and convert one mechanically:

```bash
# Print a one-line warning per build listing free-form patches that look declarative.
node scripts/check-declarative.mjs

# Convert a single patch in place (Pattern A only — single-function override).
node scripts/codemod-declarative.mjs <patch-name>            # dry-run, prints diff
node scripts/codemod-declarative.mjs <patch-name> --write    # apply
```

**Scope (`codemod-declarative.mjs`):** narrow on purpose. It only rewrites
patches whose `apply()` calls
`findFunctionByLiteral(code, resolveAnchorLiteral('NAME'))` once and replaces the
whole function body with `return !0`. Multi-anchor patches, regex sweeps over the
bundle, and patches with side-effect logging stay free-form — convert by hand.

**What the codemod emits:** `kind: 'transpiler'` (not `'prefix'`) because the
original drops the entire function body; `transpiler` is the faithful
translation. If the override is purely "force-enable", `prefix` with
`code: 'return !0;'` is smaller — that optimization is a follow-up.

**Author types (`types/patch.d.ts`):** add a JSDoc directive at the top of your
patch file to get editor hints:

```js
/** @type {import('../types/patch').Patch} */
export default { … };
```

The type file is generated from `runner/manifest-schema.mjs`.
`npm run gen:types` re-runs `scripts/gen-types.mjs`, which walks the schema to
emit `types/patch.d.ts` (enums + `Patch` + `NormalizedPatch` + sub-shapes) and
fails CI if the committed `.d.ts` drifts. `npm run gen:types -- --write` rewrites
it in place.

---

## Overlay loader — shims-as-files, one hook

Most patches inject their shim code directly into the bundle at their own anchor.
That works, but every patch is one more anchor that can drift across upstream
versions. The **overlay loader** is a Magisk-style "overlay, don't mutate"
alternative:

- **One anchor**, owned by `core/overlay_loader.mjs`, that injects a single
  `require('./ccpatch-overlay.mjs')` into the patched bundle.
- **One sibling file** generated by `runner/overlay-builder.mjs` and written next
  to the patched bundle as `ccpatch-overlay.mjs`.
- Each opt-in patch declares `overlay: { register, code }`; the builder collects
  all such blocks into the sibling file and wires them through the existing
  `__ccpProvide` / `__ccpRequire` registry (see `core/contracts.mjs`).

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

If the patch still needs a tiny in-bundle hook (for example to call
`__ccpRequire(...)` at a specific call site), keep that hook in `apply()`. The
overlay mechanism only provides the *registration channel* — in-bundle wiring is
still per-patch.

### Trade-offs

- **Pro:** N anchors collapse to 1. The bulk of patch logic lives in plain JS
  files instead of bundle anchors that can drift.
- **Pro:** Idempotent — re-applying the overlay loader is a no-op.
- **Con:** The patched bundle is no longer a single self-contained file. Shipping
  it requires copying `ccpatch-overlay.mjs` alongside.
- **Con:** Load failure of the overlay file logs to stderr but does not abort the
  bundle (by design — overlay is opt-in per patch and missing the file should not
  brick boot).

A working example with `apply()` as a no-op lives in
`extensions/_overlay_example.mjs` (disabled by default).

### Validation rules

The manifest validator (`runner/manifest.mjs`) enforces:

- `overlay` is optional.
- When present, both `overlay.register` and `overlay.code` must be non-empty
  strings.
- The runner's overlay builder skips patches whose `overlay` field is missing or
  malformed; combine with a strict `verify` block to surface mistakes.

### Dev mode — hot-reload shims

Editing a shim normally requires re-running `ccpatch apply` and restarting Claude
Code. In **dev mode**, `ccpatch-overlay.mjs` becomes a thin loader that
re-requires each shim from a sibling `ccpatch-overlay-shims/` directory on every
`__ccpRequire(name)[prop]` access — Xposed/LSPosed-style hot-reload.

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

**Constraint:** in dev mode the patch's `overlay.code` is written verbatim into a
`.cjs` file. It must therefore be a valid CommonJS **module body** that ends with
`module.exports = { ... }` — *not* a function body with `return { ... }`. The
non-dev (production) path still wraps `code` in an IIFE and uses its return
value, so for portability prefer authoring shims as:

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

It runs apply once with `--dev`, then watches `core/*.mjs` and `extensions/*.mjs`.
Any change triggers a debounced re-emit of `ccpatch-overlay.mjs` + shim files
(default debounce 200ms; override with `--debounce <ms>`). The patched bundle is
**not** re-patched — only the overlay sidecar is rewritten. A dev-mode bundle is
byte-identical to a prod-mode bundle; flip back to prod by re-running
`ccpatch apply` without `--dev`.

---

## Fallback diffs — best-effort when anchors drift

Inspired by [`patch-package`](https://github.com/ds300/patch-package), every
patch may ship an optional **stored unified diff** the runner consults when the
structured `apply()` produces no change (a likely anchor drift). The fallback is
a stop-gap so a single drifted patch doesn't break the whole build — it is
**not** a substitute for re-anchoring once upstream actually changes.

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
- `fuzz: number ≥ 0` optional (default `3`). Forwarded as `fuzzFactor` to
  `diff.applyPatch`.

### Runtime behavior

1. `apply()` runs as today.
2. If the result equals the input (no change) **and** `fallbackDiff` is present,
   the runner calls `applyPatch(code, fallbackDiff.patch, { fuzzFactor })`.
3. Success: logs
   `[fallback] <name>: stored-diff applied (fuzz=N, capturedAgainst=…)` and
   proceeds with `verify`.
4. Failure: drops back to the existing hard-drift path (warning +
   `storage/outputs/anchor-drift.jsonl`).

Skip the fallback entirely with `--no-fallback` (or programmatically via
`patchOptions.disableFallback = true`).

### Capturing a fallback diff

When you ship a patch that targets a fragile minified site, freeze the patched
bytes against the unpatched bundle:

```sh
ccpatch fallback-capture path/to/patched-cli.js \
  --against path/to/unpatched-cli.js \
  --patch my_patch_name > /tmp/my_patch.fallback.diff
```

Paste the diff into your patch module's `fallbackDiff.patch` field and set
`capturedAgainst` to the CC version you captured against. The CLI is one-shot —
it does not auto-edit your patch file.

### Warning

A fallback diff that keeps applying release after release is a smell, not a
feature. It means the patch's structured anchor is no longer in sync with
reality. When you see `[fallback]` in a build log, treat it like a TODO: open the
bundle, find the new anchor, and update the patch so `apply()` succeeds again.

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

`dependsOn` is authoritative: if `B` depends on `A`, `A` runs first regardless of
`priority`. `priority` only orders peers that have no dependency relationship.
Use it sparingly — most pairs should be declared via `dependsOn`, which is
self-documenting. `priority` is for **ordering hints among independent patches**
(e.g. "this prompt-shaping patch should run before any other prompt mutator").

Validation: `priority` must be a finite integer. Floats and strings are rejected
at manifest validation time.

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
still produce the right result. But when two patches touch the same byte range,
the *order* matters and `last-writer-wins` is silently fragile.

In **strict mode** (`--strict` or `CCPATCH_STRICT=1`), every unacknowledged
overlap is a fatal error. Acknowledge the pair by declaring `allowOverlapWith` on
at least one side:

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

Validation: `allowOverlapWith` must be an array of non-empty strings. Each string
is a peer patch name (filename stem).

### Caveats and limitations

- **Line-resolution diff spans.** The runner computes "what byte range did this
  patch touch" from the unified diff hunks the reverse-diff sidecar already
  produces. That means each hunk yields one range spanning whole lines. A small
  edit on a long line will be reported as a wider range than the actual mutation,
  so the overlap detector can produce false positives on large single-line
  bundles (i.e. minified code on a single line). When you see a false positive,
  the right fix is to acknowledge it via `allowOverlapWith`, then file an issue to
  refine the detector.

- **Cross-patch coordinate drift.** Each patch sees a different code state (the
  post-previous-patch buffer). Comparing `A.diffSpan` (in A's preCode) to
  `B.atSite` (in B's preCode = post-A) is approximate — offsets shift by the net
  delta A introduced. The detector is intentionally a "smell" rather than a
  proof.

- **Single-phase only.** Overlap detection runs per phase. A `pre`-phase patch
  overlapping a `main`-phase patch is intentional by design (phases exist to
  sequence such pairs) and is not flagged.

---

## Dry-run shadow mode

`--dry-run` runs the full apply pipeline into memory and then compares the
unpatched and patched bundles along four dimensions that `verify.present` on its
own cannot catch:

- **bytes** — patched bundle is byte-identical to the input (no patch did
  anything).
- **verify** — a `verify.present` sentinel already exists in the unpatched
  bundle. This is the "weak verify" case: the verify block would pass even if the
  patch's `apply()` were the identity function.
- **parse** — `acorn` rejects the patched bundle but accepted the unpatched one.
  The patch broke syntax.
- **forbidden** — a substring listed in the patch's `forbiddenAfterPatch`
  manifest field appears in the patched bundle. Useful for guarding against stray
  `console.log`, `debugger`, etc.

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

Validated as `string[]` by `runner/manifest.mjs`. An empty/missing field means
the shadow check skips the `forbidden` dimension for that patch.

Shadow mode catches semantic drift that `verify.present` can't: a verify block
that *looks* strict can still pass against a no-op apply if its sentinel happens
to collide with vocabulary already in the upstream bundle. The shadow check
forces the sentinel to be a *delta* between the two bundles, not just a substring
of the patched one.

---

## REPL — interactive poking of a patched bundle

Frida-style: spawn the patched bundle in a sandboxed child process, then drop
into a REPL where every expression is evaluated inside the child. Useful for
inspecting what your patch published into `__ccpRegistry`, calling exposed APIs
(`__ccpApiClient`, `__ccpToolDispatch`, ...), or experimenting with shim shapes
without writing a one-off test script.

```
ccpatch repl <patched-bundle.mjs>
```

Only `.mjs`/`.js`/`.cjs` bundles are supported in v1 — Bun-compiled binaries are
out of scope. The child enforces a 5-second per-eval timeout; if your expression
exceeds it, the child is killed and respawned automatically.

Meta-commands (prefix with `:`):
- `:list` — print the contents of `globalThis.__ccpInspectContracts()` (or the
  keys of `__ccpRegistry` if the contracts kernel isn't loaded).
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

## Reversible patches

Every successful `node bin/patch-cli.mjs <input> <output>` run also writes a
reverse-diff sidecar to `<output>.ccp-revert.json`. The sidecar lets you restore
the original bundle without re-extracting from the upstream package.

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

- Each entry's `reverseDiff` is a unified diff produced by `diff.createPatch` that,
  applied to the post-state, returns the pre-state for that patch only.
- No-change applies are omitted (they would contribute an empty diff).
- The sidecar is captured by the runner — patches themselves are unchanged.

Two CLI commands consume the sidecar:

```
node bin/patch-cli.mjs revert  <patched.js> [--output <restored.js>]
node bin/patch-cli.mjs diff    <patched.js>
```

`revert` applies the reverse diffs in reverse order and asserts the final sha256
matches `inputSha256`. `diff` prints per-patch added/removed line counts. Both
commands only support `.mjs`/`.js`/`.cjs` targets in v1 — Bun binary repack
reversal is out of scope.

---

## Third-party patch modules

Patches don't have to live in this repo. A *module* is a small package that ships
one or more patches plus a manifest. Users install modules into the project-local
`modules/` directory and reference them in `ccpatch.yml` the same way they do
built-in patches.

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
  (npm-style scopes like `@author/pkg`); the directory on disk uses `__` in place
  of `/`.
- `patches` lists the file stems (without `.mjs`) shipped under `patches/`.
- `signature`, if set, is the **content hash** (sha256) of the `patches/` tree
  computed by `hashPatchesTree` (sorted file walk, content-only, ignores
  non-`.mjs`). It proves integrity (the tree has not changed since the digest was
  recorded), **not** authenticity (who authored it). See
  [Verifying the content hash](#verifying-the-content-hash) and
  [THREAT_MODEL.md](../THREAT_MODEL.md) for the trust model.
- `updateChannel` is optional. If set, it must serve JSON of the form
  `{ "version": "1.3.0", "url": "https://.../my-patches-1.3.0.tgz",
     "signature": "<sha256>" }`.

### Loading & naming

Module patches load alongside `core/` and `extensions/`. The loader exposes each
module patch as `<module-name>/<stem>`. Reference them in `ccpatch.yml` under
`patches:` like any built-in:

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

# Install from an HTTPS tarball, pinning the expected content hash out-of-band.
ccpatch module install https://example.com/my-patches-1.2.0.tgz \
  --expect-sha256 <hex-sha256>

# Plain http:// is refused unless you also pass --insecure (no transport
# integrity; only do this on a trusted LAN).
ccpatch module install http://localhost:8080/my-patches.tgz --insecure

# Strict capability gate — required when the module declares high-risk
# capabilities (network/tools/exec/telemetry). See THREAT_MODEL.md.
ccpatch module install ./my-patches --strict --allow-capabilities=network,telemetry

# Inspect & manage
ccpatch module list
ccpatch module verify @author/my-patches
ccpatch module update  @author/my-patches
ccpatch module remove  @author/my-patches
```

Git URLs are out of scope in v1; clone manually and point `install` at the local
checkout.

### Security caveats

- **The module "signature" is a content hash, not authenticity.** It proves the
  `patches/` tree matches a known digest — integrity — but says nothing about who
  produced it. Trust comes from pinning a known-good hash out-of-band, not from
  the field's presence.
- **Unsigned modules load but warn.** When `signature` is missing, the install
  command logs an `UNSIGNED` notice. The hash printed by `module verify` lets you
  pin a known-good checksum out-of-band before enabling the module.
- **`--expect-sha256` is the trust anchor for remote installs.** Pass the hash
  you obtained out-of-band; the installer refuses to proceed if the downloaded
  tree doesn't match.
- **`http://` requires `--insecure`.** Plain HTTP has no transport integrity, so
  the installer refuses an `http://` URL unless you explicitly opt in with
  `--insecure`. Prefer `https://` with `--expect-sha256`.
- **Capabilities are self-declared.** The same `capabilities` array used by core
  patches is honoured for module patches and feeds into the existing
  `--allow-capabilities` gate at apply time and at install time.
- **Imports happen in-process.** `module install` imports each patch to read its
  declared capabilities. This is *disclosure*, not sandboxing — auditing the
  source under `modules/<name>/patches/` before enabling the module is the actual
  trust boundary.
- **Update channels are not signed by ccpatch.** A compromised update endpoint
  can replace the tarball. Pin a known content hash locally if that matters.

### Verifying the content hash

The `signature` in `ccpatch-module.json` is a hex sha256 over the sorted
`patches/` tree (file content only — non-`.mjs` files are excluded). It is a
content hash for integrity checking, not a cryptographic authorship signature.
Compute it with:

```bash
node -e "import('./runner/modules.mjs').then(m => console.log(m.hashPatchesTree('my-patches/patches')))"
```

Paste the digest into the manifest's `signature` field, then `ccpatch module
verify` will report `OK` after install. A tampered patch file makes the verifier
exit non-zero.

---

## Coverage — apply-time + runtime instrumentation

A patch can apply cleanly (anchor resolves, `verify` block passes) and still be
dead code at runtime: the surrounding branch is feature-flagged off, the upstream
code path was removed, or the injection landed in a function nobody calls in this
CC version. Build-time verification cannot tell you any of that.

ccpatch ships two-sided coverage, inspired by DynamoRIO/Pin:

1. **Apply-time coverage** is captured automatically. After every
   `applyNamedPatches` run, the runner writes
   `storage/outputs/coverage-apply-v<ccVersion>.json` recording
   `{ phase, applied, status, diffSpans, coverageMarker?, reason? }` per patch —
   the same data the existing per-version `patch-results-*.json` exposes, plus the
   marker name.

2. **Runtime coverage** is opt-in. A patch sets `coverageMarker: 'my-name'` in its
   manifest, and the runner injects a
   `(globalThis.__ccpCovHit && globalThis.__ccpCovHit('my-name'));` call into the
   patched code at the first inserted line of the diff (or, when an `@At` selector
   is present, at the resolved site). The `coverage_kernel` patch maintains
   `globalThis.__ccpCoverage` and dumps it on `SIGTERM` and on `exit` as a
   `__CCP_COV__<json>` line on stdout.

`ccpatch coverage <patched-bundle> [--smoke <cmd>] [--out report.json]` runs the
bundle (default smoke: `node <bundle> --version`), parses the dump, and
cross-references it with the apply-time manifest:

```
Patch                  Applied  Hit   Status
cost_tracker           yes      yes   LIVE
durable_cron           yes      no    DEAD
plan_mode_interview    no       -     SKIPPED
```

- `LIVE` — applied AND instrumented marker fired at runtime.
- `DEAD` — applied but the instrumented marker never fired. The patch's injected
  code is unreachable in this CC version. **This is a signal to delete or revisit
  the patch, not always a bug** — a feature flag may be off, or upstream may have
  rotated away from the anchored code path. Use the `revisit` marker to track
  temporary forensic patches; use coverage to catch the rest.
- `SKIPPED` — patch did not apply (anchor drift, disabled, etc.) so no runtime
  check is possible.
- `UNINSTRUMENTED` — patch applied but did not declare a `coverageMarker`. No
  verdict either way.

`ccpatch coverage` exits non-zero if any `DEAD` patches are found, so CI can fail
the build on "ship it forever" rot:

```bash
make patch-coverage VERSION=2.1.148
# or:
ccpatch <input> <output> --version 2.1.148
ccpatch coverage <output> --cc-version 2.1.148 --out coverage.json
```

The instrumentation is best-effort: when the runner can't find a sensible site
(e.g. the patch replaces a whole function wholesale without leaving a fresh
inserted line), it logs
`[coverage] <patch>: no instrumentation site found, skipping` and proceeds — the
patch still applies, but won't surface in the report. A future revision can teach
declarative kinds (`prefix`/`postfix`) to emit hits unconditionally.
