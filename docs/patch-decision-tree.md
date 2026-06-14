# Patch decision tree

The framework has more than one way to mutate the bundle, run boot-time code,
and ship an agent. **This page is the single canonical answer to "which pattern
do I use?"** Start at the top and take the first branch that fits. Each branch
cites one real patch in the tree as the example to copy.

When in doubt, prefer the **most declarative** option you can get away with:
declarative `kind` > a `patch-helpers.mjs` helper > hand-written `apply()`.
Declarative forms are scoped to one function, fail loud on anchor drift, and
read in PRs as a few lines of intent instead of a slice/concat puzzle.

---

## 1. Mutating the bundle?

> **Prefer declarative `kind` (`prefix` / `postfix` / `transpiler`). Fall back
> to a `runner/patch-helpers.mjs` helper. Fall back to a hand-written `apply()`
> ONLY when the transform is genuinely bespoke.**

### 1a. Declarative `kind` — the default

If your change is "inject code at the start of one function", "wrap one
function's return values", or "rewrite one function's source", use a `kind`.
No `apply()` — you declare a `target` and a `code`/transform, and
`runner/patch-kinds.mjs` synthesizes the `apply()` for you. The four kinds are
documented in `patch-kinds.mjs`: `prefix`, `postfix`, `transpiler`, and `free`
(free = "I need a hand-written apply", i.e. branch 1c).

Canonical example — `extensions/force_thinking.mjs` (a `prefix`):

```js
export default {
  category: 'feature',
  description: 'Force thinking enabled when CC_THINKING env var is set',
  verify: { present: 'CC_THINKING!=="disabled"', count: { present: 1 } },

  kind: 'prefix',
  // Anchor on a stable property access via body-substring matching.
  target: { function: { body: 'process.env.MAX_THINKING_TOKENS' } },
  code: 'if(process.env.CC_THINKING&&process.env.CC_THINKING!=="disabled"&&process.env.CC_THINKING!=="0")return!0;',
};
```

That is the whole patch: anchor, intent, verify. No bundle slicing.

### 1b. A `patch-helpers.mjs` helper — when a `kind` doesn't fit

If you need a hand-written `apply()` but the transform is one of the recurring
shapes, use a helper from `runner/patch-helpers.mjs` instead of hand-rolling the
splice:

- `spliceAfter(code, anchor, snippet)` — insert after a stable anchor; **throws
  on drift** instead of silently no-oping.
- `replaceFunctionByLiteral(code, literal, build)` — find the function wrapping
  a stable literal and rebuild its body.
- `forceFeatureFlag(code, literal)` — the "make this `tengu_*` flag return true"
  one-liner.

These throw on anchor misses so the strict-mode runner catches drift
immediately — the whole reason to prefer them over `code.replace(...)`.

### 1c. Hand-written `apply()` — last resort, bespoke only

A free-form `apply(code) => string` is correct only when the transform is
genuinely one-of-a-kind (multiple coordinated splices, an event bus, a
boot-time IIFE that none of the helpers model). `extensions/debug.mjs` is one of
these: it injects a multi-block runtime that wraps `globalThis.fetch` and
branches on shebang-vs-CJS-IIFE by hand. Note even this would today route its
boot splice through `bootInject` (branch 2) rather than re-deriving the anchor.
If you reach for a hand-written `apply()`, justify it in a comment.

---

## 2. Boot-time code that runs once at startup?

> **Declare `bootInject: { code, order, sentinel? }`. Do NOT hand-splice the
> boot anchor.**

Code that must run before the bundle body — a `globalThis.__ccp*` registration,
a `fetch` wrapper, a banner — goes through the boot registry
(`runner/boot-registry.mjs`). The registry collects every enabled patch's block,
sorts by `order` (use gaps of 10), and performs **exactly one** splice at the
canonical boot anchor. Hand-splicing the shebang/CJS-IIFE yourself re-derives an
anchor the registry already owns and reintroduces the emergent-ordering bug the
registry exists to kill.

Canonical example — `core/boot_banner.mjs`:

```js
export default {
  category: 'fix',
  required: true,
  description: 'Render ccpatch boot-log lines in a rounded box before the banner.',
  verify: { present: '__ccpBootBanner', count: { present: 1 } },
  bootInject: {
    order: 40,                       // lower runs first; gaps of 10 leave room
    code: (options = {}) => { /* returns the boot JS, version stamped in */ },
  },
};
```

Boot-only patches may omit `apply()` entirely — idempotency comes from the
sentinel (defaults to the first `verify.present` literal). `code` can be a string
or a function of the build options.

---

## 3. Shipping an agent definition?

> **Use `agentDir: { name, code }` with a no-op `apply()` and an
> `verify.absent`-only block.**

An agent isn't a bundle mutation — it ships as an independent file written to
`ccpatch-agents/<name>.mjs` next to the patched bundle and loaded at startup
(after a `.sha256` integrity check) by `core/overlay_loader`. Because there is no
bundle change, `apply()` is a no-op and you MUST use an `verify.absent`-only
block: a `verify.present` literal would make the runner read the (correct)
no-change as anchor drift and force-fail the build.

Canonical example — `extensions/adk_hello_agent.mjs`:

```js
export default {
  category: 'optional',
  description: 'Load the ADK into a patched session and register a hello agent.',
  enabled: false,
  // absent-only: there is no bundle mutation, so no present literal to assert.
  verify: { absent: '__ccp_adk_hello_should_never_be_in_bundle__' },
  agentDir: { name: 'adk-hello', code: AGENT_CODE },
  apply: (code) => code,            // intentional no-op
};
```

---

## Anti-patterns

- **Anchoring on minified identifiers** (`aP`, `oU8`, `JMq`, …). They rotate
  every release. Anchor on a stable string literal or an AST anchor in
  `runner/anchors.mjs`. (Rule 1.)
- **Hand-splicing the boot anchor.** If you find yourself branching on
  `startsWith('#!/usr/bin/env node')` vs the CJS-IIFE head in your `apply()`,
  you want `bootInject` (branch 2), not a private splice.
- **Hand-rolling a function override** with `code.slice(0, fn.start) +
  'function ' + fn.name + ...` when `kind: 'prefix'` / `kind: 'transpiler'` or
  `replaceFunctionByLiteral` expresses it declaratively. (`check-declarative`
  flags this.)
- **A single `code.replace(...)` anchored on a quoted literal** in a free-form
  `apply()` when `kind: 'transpiler'` scopes it to the one function.
  (`check-declarative` flags this too.)
- **More than ~15 lines of injected code inline** in the patch file. Move real
  logic into a `.mjs` shim read as a template string; the patch injects only a
  thin wrapper. Model: `extensions/hook_noise_mute.mjs`. (Rule 6.)
- **Writing a patch at all** when a documented `settings.json` hook event does
  the job. Settings-level hooks first. (Rule 10.)
