# Anchoring strategy

An *anchor* is how a patch finds the place in the minified `cli.js` it needs to
touch. The bundle is ~16 MB of minified code and every release rotates variable
and function names — so the only durable thing to grab onto is the content the
minifier *cannot* rewrite: string literals (feature-flag keys, error messages,
env-var names).

This page is the strategy reference. For the hands-on "how do I find a stable
string in a fresh bundle" playbook, see
[finding-anchors.md](./finding-anchors.md).

ccpatch supports three anchoring strategies, in descending order of preference.

## 1. CANONICAL — `findFunctionByLiteral` + the `runner/anchors.mjs` registry

This is the approach **new patches should use** for any function-level anchor.

- **`findFunctionByLiteral(code, "stable_string")`** (`runner/ast-anchor.mjs`)
  scans for a stable string literal, walks backward to the enclosing `function`
  keyword, brace-matches the body, and validates the result with a windowed
  Acorn parse. It returns `{ name, start, end }` — the resolved (rotated)
  function name plus exact byte offsets. No regex over the whole bundle;
  minifier-proof because it pivots on the one token the minifier can't rename.
- **`runner/anchors.mjs`** is the central registry that gives each anchor a
  stable *ID* and records its stable `literal` in one place. A version bump that
  drifts an anchor becomes a single-file edit instead of a hunt across 30+
  patches. Read the adoption-policy comment at the top of that file before
  adding an entry.

Register the literal once:

```js
// runner/anchors.mjs
export const anchors = {
  isLoopDynamicEnabled: {
    literal: 'tengu_kairos_loop_dynamic',   // stable token findFunctionByLiteral() pivots on
    default: /function ([A-Za-z_$][\w$]*)\(\)\{return [A-Za-z_$][\w$]*\("tengu_kairos_loop_dynamic",!1\)\}/,
  },
};
```

Then resolve it by ID from the patch — never re-typing the raw literal:

```js
// extensions/loop_dynamic.mjs
import { findFunctionByLiteral } from '../runner/ast-anchor.mjs';
import { resolveAnchorLiteral } from '../runner/anchors.mjs';

apply: (code) => {
  const fn = findFunctionByLiteral(code, resolveAnchorLiteral('isLoopDynamicEnabled'));
  if (!fn) {
    console.warn('  [!] loop_dynamic: anchor not matched — update runner/anchors.mjs for this version');
    return code;
  }
  // fn.name is the rotated name; fn.start/fn.end are exact byte offsets.
  return code.slice(0, fn.start) + 'function ' + fn.name + '(){return !0}' + code.slice(fn.end);
},
```

Because the literal lives in the registry, the patch carries no version-specific
knowledge and the only thing that ever needs editing on drift is
`runner/anchors.mjs`. The same registry feeds the refmap generator
(`tools/build-refmap.mjs`) and `resolveAnchor()`'s
version/refmap/tier/default precedence chain — see [Refmaps](#refmaps) below.

The `@At` declarative selectors (`{ function: { literal: 'STR' } }`, see
[@At selectors](#at-selectors-declarative-anchor-vocabulary)) are the
manifest-level expression of this same strategy: the runner resolves them
through `findFunctionByLiteral` for you before `apply()` runs.

## 2. Acceptable — bare inline regex for stable, non-rotating tokens

A plain `code.includes('...')` or a regex matched directly in `apply()` is fine
when the anchor is a **stable string that is not expected to drift across
versions** — flag keys like `"tengu_kairos_*"`, fixed module wrappers, distinct
error messages. These do not need a registry entry (per the adoption policy).
Keep the regex narrow and anchored on the literal, not on minified identifiers.

## 3. LEGACY / grandfathered — inline function-locating regex

Some older patches hand-roll a regex that matches a whole minified function
shape (capturing the rotated name with `(\w+)` etc.) directly inside `apply()`.
**This is legacy. Do not write new patches this way.** It duplicates per-version
knowledge inside the patch, so when a release drifts the anchor you have to edit
the patch itself rather than one registry line.

Existing inline-regex patches are **grandfathered** — there is no campaign to
rewrite them. Migrate opportunistically: when an anchor drifts and you're
already editing the patch, move it to a `runner/anchors.mjs` entry and switch to
`findFunctionByLiteral` / `resolveAnchorLiteral`.

---

## @At selectors — declarative anchor vocabulary

Patches may declare an `at` manifest field that names *where* in the bundle they
want to attach, decoupled from *what* they inject. The runner resolves the
selector once (using stable string literals and Acorn over windowed ranges, not
the whole 16 MB bundle), then passes the resolved byte ranges to your `apply()`
via `opts.atSites`. Helper splicers live in `runner/at-selector.mjs`.

A patch that declares `at` MUST still export `apply()` — the helper consumes the
sites; the runner does not splice for you.

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

---

## Refmaps

A refmap is a JSON sidecar (`refmaps/<ccVersion>.json`) that maps each anchor ID
from `runner/anchors.mjs` to the *current* minified function name and byte
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
(`make reconstruct VERSION=<x.y.z>`), regenerate the refmap so anchors with only
a `default` regex still resolve cleanly on the new minifier output:

```
node tools/build-refmap.mjs releases/<x.y.z>/cli.v<x.y.z>.cjs \
  --cc-version <x.y.z>
# or, equivalently:
ccpatch refmap releases/<x.y.z>/cli.v<x.y.z>.cjs --cc-version <x.y.z>
```

Refmaps live under `refmaps/` keyed by ccVersion. Check them in so contributors
don't need a local reconstruct to get correct anchor resolution for shipped
releases.

### CI drift detection

Use `--check` to fail CI when the on-disk refmap is stale:

```
ccpatch refmap releases/<x.y.z>/cli.v<x.y.z>.cjs --cc-version <x.y.z> --check
```

Exit code 0 = on-disk matches a fresh generation; 1 = drift, regenerate.

### How refmaps interact with `runner/anchors.mjs`

`resolveAnchor(id, version)` resolves an anchor pattern in this order:

1. **Version-pinned regex entry** in `runner/anchors.mjs`
   (`anchors[id][version]`) — wins outright. Use this for anchors whose *shape*
   (not just function name) differs in a specific release.
2. **Refmap entry** at `refmaps/<version>.json` — synthesises a `function <fn>`
   regex from the resolved symbol. Use this for the common case: same shape,
   different minified name.
3. **Default regex** (`anchors[id].default`) — final fallback. Sufficient when
   no version-specific drift has been observed yet.

Only anchors that declare a stable string `literal` are eligible for refmap
generation; anchors without a `literal` are listed under `misses` in the
generated JSON so you can see what was skipped.

### Refmaps vs per-version patch directories

These are **complementary**:

- **Per-version patch directories** (`core/<name>/<version>.mjs`) ship a
  different implementation per release — for when the patch body itself must
  change.
- **Refmaps** ship the *same* patch code but resolve a different minified symbol
  per release — for when only the function name changes.

If a release breaks anchor resolution but the patch logic still applies,
regenerating the refmap is usually enough. If the patch logic needs to change,
reach for per-version patch directories.

---

## Anchor drift troubleshooting

When a patch produces no changes, the runner does two things:

1. Logs `[!] Patch "<name>" produced no changes. (check anchors)` and any fuzzy
   candidates with similarity scores.
2. Appends a structured entry to `storage/outputs/anchor-drift.jsonl` tagged
   with the patch name and version, including up to three near-miss candidates.

The fuzzy matcher (`runner/anchors.mjs::fuzzyMatch`) extracts the stable string
literals from the failing pattern, scans the bundle for them, and ranks 200-char
windows by token overlap. The top candidate is usually within a handful of bytes
of the real new anchor.

`ccpatch doctor <cli.cjs>` surfaces these in a one-line-per-patch report. Status
codes:

- `OK` — anchor matched and `verify` passed.
- `DRIFT` — verify passed but the anchor needed a fuzzy fallback (review the
  candidate).
- `UNVERIFIED` — verify only contains `present` with no `absent`/`count`.
  Warning, not failure. Promote with `--strict`.
- `MISSING` — anchor not found, or verify failed.

Doctor exits 1 if any patch is `MISSING`. With `--strict` (or
`CCPATCH_STRICT=1`), it also exits 1 when any patch is `UNVERIFIED`.

---

## Per-upstream-version patch directories

When a patch needs a *different implementation* for a different Claude Code
version (not just a different anchor regex — that's `runner/anchors.mjs`), use a
per-version override directory:

```
core/
  bun_shim.mjs                 # default / fallback
  bun_shim/
    2.1.148.mjs                    # used when bundle is exactly 2.1.148
    >=2.1.150.mjs                  # used when bundle is >= 2.1.150
    >=2.1.150,<2.2.0.mjs           # half-open range
```

This is **opt-in**. Existing flat patches keep working unchanged. The loader
uses the variant directory only when one exists alongside the default file (or
instead of it).

### Resolution rules

For each patch `<name>` in `core/` or `extensions/`:

1. If `<name>/` exists, scan it for files whose stems are one of:
   - exact: `2.1.148.mjs`
   - range: `>=2.1.150.mjs`, `<2.2.0.mjs`, `>=2.1.150,<2.2.0.mjs`
2. Select the most specific match for the target bundle version:
   - **Exact** match always wins.
   - Otherwise the **narrowest** matching range (highest lower bound; ties
     broken by lowest upper bound).
3. Fall back to `<name>.mjs`.
4. If neither a default nor a matching variant exists, the build fails with a
   clear load error.

Any file in a version dir whose stem isn't a parseable version or range is a
fatal load error — don't park unrelated files in there.

### testedAgainst (required on variants)

Every per-version variant file must declare a `testedAgainst` field whose value
matches its filename stem:

```js
// core/bun_shim/2.1.148.mjs
export default {
  description: '...',
  testedAgainst: ['2.1.148'],
  verify: { ... },
  apply: (code) => { ... },
};
```

Mismatch between the filename stem and `testedAgainst` is a fatal manifest
error. `testedAgainst` is optional on default files but recommended.

### Inspecting variants

```
ccpatch versions                          # list variant dirs and would-be picks
ccpatch versions --target-version 2.1.150 # simulate for a specific version
```

The patch-results JSON (`storage/outputs/patch-results-v<X>.json`) records
`resolvedVariant` per patch so post-mortems can tell which file actually ran.
