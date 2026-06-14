# Patch ordering: apply order vs runtime order

ccpatch has **two distinct ordering systems**, and conflating them is the single
most common ordering mistake. This page is the canonical answer to "what
determines the order my patch runs in?". The authoritative implementation lives
in [`runner/apply-order.mjs`](../runner/apply-order.mjs) and
[`runner/boot-registry.mjs`](../runner/boot-registry.mjs); this doc is the map.

## TL;DR

| You want to control… | Use | You do **not** use |
| --- | --- | --- |
| The order patches' `apply()` transforms run over the bundle **text** | `phase` → `dependsOn` → `priority` | `bootInject.order` |
| The order your injected code **executes at runtime / boot** | `bootInject.order` (or self-bootstrapping helpers) | `priority` |

If your patch declares `bootInject`, its `priority` is at best inert and at
worst misleading. The `lint-ordering` check (`npm run lint:ordering`) fails the
build on a `bootInject` + `priority` combination for exactly this reason.

## 1. Apply order — `phase` / `dependsOn` / `priority`

`orderPatches()` produces the sequence in which each patch's `apply()` runs over
the bundle **text**, in strict precedence:

1. **`phase`** (`pre` → `main` → `post`) — dominates everything. A cross-phase
   `dependsOn` must point at a same-or-earlier phase; the runner enforces this
   and fails loudly otherwise.
2. **`dependsOn`** — a topological constraint that **dominates `priority`**: a
   patch never applies before a patch it (transitively) depends on, even if
   priority "wants" otherwise. This is the hard correctness invariant.
3. **`priority`** — orders only patches that are otherwise free to run in either
   order (same phase, no dependency path between them). Lower runs first.
   Default `1000`.
4. **enable-list index** — final stable tie-breaker.

This is what you reach for when **patch B's transform must see the text patch A
already produced** (e.g. B anchors inside a region A injects). Declare
`dependsOn: ['A']`.

## 2. Runtime order — `bootInject.order`

Apply order is **not** runtime order for a whole class of patches.

Patches that prepend at the **first occurrence of a shared head anchor** (the
shebang / CJS-IIFE head) all replace the *same* site, so whichever applies
**last** ends up textually **first** in the emitted bundle. For these patches the
runtime execution order is the **reverse** of the apply order. Setting `priority`
low to "run early" is therefore correct for apply but **inverted** at runtime.

Two mechanisms make runtime order explicit instead of inheriting this inversion:

- **`bootInject: { code, order }`** — the boot registry collects every enabled
  patch's boot block and emits **one** combined splice ordered by the declared
  `order` key (lower runs first; use gaps of 10). Runtime order is exactly what
  you declared, regardless of apply order. **This is the preferred mechanism.**
- **Self-bootstrapping helpers** — make injected helpers work no matter which
  prepend lands first, e.g. the `contracts` pattern: `__ccpProvide` /
  `__ccpRequire` lazily create the registry on first call, so neither producer
  nor consumer cares who executed first.

Prefer one of these over trying to encode runtime order through `priority`.

## Why the lint exists

A `bootInject` patch contributes its block to a single combined splice whose
internal order is decided **only** by `bootInject.order`. Its `priority` cannot
move that block earlier or later at runtime. So `bootInject` + `priority` is
always either a no-op or a misunderstanding — `lint-ordering` flags it and points
back here. If you ever have a legitimate non-runtime reason to set `priority` on a
bootInject patch, add the stem to the `ALLOWLIST` in
[`scripts/lint-ordering.mjs`](../scripts/lint-ordering.mjs) with a one-line
justification.
