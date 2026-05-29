# Manifest reference

Every patch is a `.mjs` module that default-exports a *manifest* object. This
page is the human-facing reference for the manifest fields. The machine-readable
source of truth is [`runner/manifest-schema.mjs`](../runner/manifest-schema.mjs)
— that module owns the enum vocabularies and the documented type surface, and
both the runtime validator (`runner/manifest.mjs`) and the generated
`types/patch.d.ts` are driven from it. If this page and the schema ever
disagree, the schema wins; please open an issue.

When the validator rejects a manifest it now quotes the offending field and
points back here. Keep the field names below in sync with the schema.

---

## Required fields

Every patch must declare these two.

### `description: string`

A short, one-line description shown in build output and reports.

### `verify: VerifyBlock`

The post-apply invariant. The runner asserts it immediately after `apply()`
returns and fails the patch if any assertion does not hold. A patch with no
`verify` block is rejected at load time — there is no opt-out.

A `VerifyBlock` must contain at least one of:

| Field      | Type                                            | Meaning |
| ---------- | ----------------------------------------------- | --- |
| `present`  | `string \| string[]`                            | Substring(s) that MUST exist post-apply. |
| `absent`   | `string \| string[]`                            | Substring(s) that MUST NOT exist post-apply. Catches no-op apply and double-apply by asserting the pre-patch form is gone. |
| `count`    | `number \| { present?: number; absent?: number }` | Exact occurrence totals. A bare number is shorthand for the `present` count. |
| `weak`     | `boolean`                                       | Opt-in acknowledgement for a `present`-only verify (which cannot detect a wrong-location or double apply). |
| `label`    | `string`                                        | Optional human label used in failure messages. |

A `present`-only verify is **weak**: `ccpatch doctor` reports it as
`UNVERIFIED` because a wrong-location apply could leave the sentinel matching an
unrelated string elsewhere in the bundle. In `--strict` mode `UNVERIFIED` is a
failure. Pick the strongest verify you can derive by reading your own `apply()`
— prefer `absent` and/or `count` over `present` alone. See
[anchors.md](./anchors.md) for the "don't reuse an existing bundle string"
anti-pattern.

---

## Declarative kind vs. free-form apply

A patch is either *declarative* (a `kind` plus a `target`) or *free-form* (an
`apply()` you write). See [authoring-patches.md](./authoring-patches.md) for the
full prose on each kind; this is the field reference.

### `kind?: 'free' | 'prefix' | 'postfix' | 'transpiler'`

The patch shape. Defaults to `'free'`, which uses `apply()`.

- `prefix` — inject `code` verbatim at the target function's entry.
- `postfix` — wrap every `return` in the target function.
- `transpiler` — full source-text rewrite scoped to the target function's bytes.

Mixing a non-`free` kind with a user-supplied `apply()` is a manifest error: the
runner synthesizes `apply` from the declarative fields.

### `target?: KindTarget`

Required when `kind` is not `'free'`. Names the function to operate on:

```js
target: { function: { literal: 'STR' } }   // function whose body contains "STR"
target: { function: { body: 'SUBSTR' } }   // function whose body contains SUBSTR verbatim
target: { function: 'name' }               // source-level name (rare in minified bundles)
```

`function` is a `FunctionSpec`: a bare `string` (name), `{ literal }`,
`{ name }`, or `{ body }`.

### `code?: string`

Required when `kind` is `'prefix'` or `'postfix'`. Verbatim JS to inject.

### `transform?: (functionBody, opts) => string`

Required when `kind` is `'transpiler'`. Receives the target function's body text
and returns the rewritten body.

### `apply?: (code, opts?) => string`

The free-form transform over the whole bundle. Required when `kind` is `'free'`
(or unset). Must be idempotent — re-applying must be a no-op, typically guarded
by a sentinel string the patch injects.

---

## Recommended fields

### `category?: 'infrastructure' | 'fix' | 'feature' | 'observe' | 'expose' | 'optional'`

Informational, used by reporters.

### `enabled?: boolean`

A default-enabled hint. `ccpatch.yml` is authoritative — this field is only a
suggestion for the curated profiles.

### `capabilities?: Capability[]`

The self-reported runtime powers the patch can exercise inside the patched
bundle. One of `network`, `fs`, `prompt`, `tools`, `env`, `exec`, `telemetry`.
An empty or missing array means the patch is purely cosmetic. Capabilities feed
the `--allow-capabilities` gate and the risk classification. See
[THREAT_MODEL.md](../THREAT_MODEL.md) for the full meaning of each capability
and the low/medium/high risk tiers.

---

## Identity & docs

| Field     | Type       | Notes |
| --------- | ---------- | --- |
| `name`    | `string`   | Filename stem is used when omitted. |
| `version` | `string`   | Patch version, informational. |
| `tags`    | `string[]` | Free-form labels. |
| `env`     | `string[]` | Env vars this patch reads — **documentation only**. Mirror these in `ccpatch.yml`'s long form. Reading an env var beyond what this lists is what the `env` *capability* declares. |

---

## Scheduling

### `phase?: 'pre' | 'main' | 'post'`

The build phase. Patches run `pre` → `main` → `post`. Defaults to `main`.

### `priority?: number`

Lower runs first within a phase (default `1000`). Must be a finite integer;
floats and strings are rejected at validation time. Use sparingly — `priority`
only orders peers with no dependency relationship. Prefer `dependsOn`, which is
self-documenting.

### `dependsOn?: string[]`

Names of patches that must run before this one. Authoritative over `priority`:
if `B` depends on `A`, `A` runs first regardless of priorities. A dependency
must live in the same or an earlier phase.

### `allowOverlapWith?: string[]`

Acknowledged overlapping peers. After each phase the runner detects pairs whose
resolved sites or diff spans intersect; in strict mode an unacknowledged overlap
is fatal. Declare the specific peer name on at least one side to acknowledge it
(wildcards are intentionally unsupported). Must be an array of non-empty
strings.

### `applyMode?: 'build' | 'either'`

`build` runs only at bundle build time; `either` may also run at runtime.

---

## Anchoring

### `at?: AtSelector`

The declarative `@At` selector — names *where* in the bundle to attach,
decoupled from *what* to inject. The runner resolves the selector once and
passes resolved byte ranges to `apply()` via `opts.atSites`. Shape:

```js
at: {
  kind: 'HEAD' | 'RETURN' | 'INVOKE' | 'BEFORE' | 'AFTER',
  target: {
    function?: FunctionSpec,
    call?: FunctionSpec,
    in?: FunctionSpec,
    literal?: string,
    occurrence?: number,
  },
}
```

A patch that declares `at` MUST still export `apply()` — the helper consumes the
sites; the runner does not splice for you. See
[anchors.md](./anchors.md) and [authoring-patches.md](./authoring-patches.md)
for the selector vocabulary.

### `anchor?: Anchor`

A literal anchor `{ literal, byteOffset? }`. Legacy — prefer the `at:` selector.

---

## Robustness

### `required?: boolean`

When `true`, a no-change apply, a verify failure, or an apply error makes the
whole build fail (instead of warn-and-continue).

### `forbiddenAfterPatch?: string[]`

Substrings that must NOT appear in the patched bundle. Checked by `--dry-run`
shadow mode. Useful for guarding against stray `console.log(`, `debugger;`,
etc. Validated as `string[]`; an empty or missing field skips the `forbidden`
dimension for that patch.

### `fallbackDiff?: FallbackDiff`

A patch-package-style stored unified diff the runner consults when `apply()`
produces no change (likely anchor drift). Shape:

| Field             | Type     | Notes |
| ----------------- | -------- | --- |
| `patch`           | `string` | Unified-diff text. Required. |
| `capturedAgainst` | `string` | CC version the diff was captured against. Required, informational. |
| `fuzz`            | `number` | `applyPatch` fuzz factor, ≥ 0, default `3`. Optional. |

A fallback that keeps applying release after release is a smell, not a feature —
re-anchor the patch. See [authoring-patches.md](./authoring-patches.md).

### `testedAgainst?: string[]`

CC versions this patch was validated against. **Required** on per-version
variant files (`core/<name>/<version>.mjs`), where it must match the filename
stem; optional but recommended on default files.

---

## Lifecycle hooks

Three optional exports let a patch react to its own apply lifecycle. They are
*named exports*, not manifest fields. See
[lifecycle-hooks.md](./lifecycle-hooks.md) for the full contract.

```js
export async function onBeforeApply(ctx) { /* mutate ctx.opts or ctx.code */ }
export async function onAfterApply(ctx)  { /* mutate ctx.appliedCode */ }
export async function onVerifyFail(ctx)  { /* return string → retry verify once */ }
```

---

## Overlay (sibling-file shim)

### `overlay?: Overlay`

Opts the patch into the overlay loader, which collapses N anchors into one. Both
fields are required when `overlay` is present:

| Field      | Type     | Notes |
| ---------- | -------- | --- |
| `register` | `string` | The registry name consumers pass to `__ccpRequire`. Non-empty. |
| `code`     | `string` | The shim body collected into the sibling `ccpatch-overlay.mjs`. Non-empty. |

See the overlay loader section in [authoring-patches.md](./authoring-patches.md).

---

## Preload (`--require`) variant

| Field         | Type      | Notes |
| ------------- | --------- | --- |
| `preload`     | `boolean` | Expose the patch's hook as a `--require` preload. |
| `preloadCode` | `string`  | The code injected on the preload path. |

---

## Status markers

### `deprecated?: Deprecated`

Marks a patch as no-longer-needed: `{ reason: string, since?: string }`.

### `revisit?: Revisit`

Marks a patch that should be re-evaluated as upstream evolves:
`{ note: string, addedIn?: string, until?: string }`. Pair with
`coverageMarker` to track temporary forensic patches.

---

## Coverage

### `coverageMarker?: string`

Opt-in runtime coverage marker. When set, the runner injects a
`__ccpCovHit('<marker>')` call at the first inserted line of the diff (or at the
resolved `@At` site). `ccpatch coverage` cross-references the runtime dump with
the apply-time manifest to flag `LIVE` / `DEAD` patches. See the Coverage
section in [authoring-patches.md](./authoring-patches.md).
