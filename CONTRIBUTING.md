# Contributing to ccpatch

Thanks for considering a patch. ccpatch injects scripts into Claude Code's
`cli.js` to reach behavior that MCP and external wrappers cannot touch —
internal feature flags, the tool list before it reaches the API, user input
before the harness processes it, and module-scoped state in the agent loop.

This document covers PR mechanics: governance (what gets merged), the PR
checklist, and where to find the reference material. The reference material
itself lives under [`docs/`](./docs/).

---

## Reference docs

The how-to and contract material that used to live in this file has moved into
`docs/`. Start here:

| Doc | What it covers |
| --- | --- |
| [docs/authoring-patches.md](./docs/authoring-patches.md) | The patch contract, the inline-vs-shim-as-patch model, the step-by-step "add a new patch" walkthrough, declarative kinds (`prefix`/`postfix`/`transpiler`), the overlay loader, fallback diffs, priority/overlap detection, dry-run shadow mode, the REPL, reversible patches, third-party modules, and coverage. |
| [docs/manifest-reference.md](./docs/manifest-reference.md) | The manifest fields — `verify`, `kind`/`target`, `capabilities`, `dependsOn`, `phase`, `priority`, `allowOverlapWith`, `revisit`, `fallbackDiff`, and the rest. Source of truth is [`runner/manifest-schema.mjs`](./runner/manifest-schema.mjs). |
| [docs/anchors.md](./docs/anchors.md) | Anchoring strategy: `findFunctionByLiteral` + the `runner/anchors.mjs` registry, the `@At` selector vocabulary, refmaps, per-version patch directories, and anchor-drift troubleshooting. |
| [docs/finding-anchors.md](./docs/finding-anchors.md) | The hands-on playbook for locating a stable anchor in a fresh minified bundle. |
| [docs/lifecycle-hooks.md](./docs/lifecycle-hooks.md) | The `onBeforeApply` / `onAfterApply` / `onVerifyFail` hooks and the retry contract. |
| [THREAT_MODEL.md](./THREAT_MODEL.md) | Per-patch risk table, capability declarations, the apply-time gate, and the module content-hash trust model. |

If you're writing your first patch, read
[docs/authoring-patches.md](./docs/authoring-patches.md) front to back; it links
into the other docs where you need them.

---

## Governance: what gets merged

**Accepted without much discussion:**

- Bug fixes for issues reproducible against the upstream bundle.
- Quality-of-life patches that are clearly opt-in and don't change semantics for
  users who leave them off.
- Patches that expose existing internals via `__ccp*` globals for tooling,
  without altering CLI behavior.
- Observability patches that record locally and ship nothing off-machine by
  default.

**Flagged for discussion before merge:**

- Patches that change which model is called or alter routing.
- Patches that touch billing-adjacent surfaces (cost reporting that overrides
  upstream, rate-limit bypass that affects accounting).
- Patches that unlock unreleased or server-gated features when there's reason to
  believe Anthropic intends them to remain gated.
- Patches that send data off-machine by default (e.g. webhook destinations) —
  these must be strictly opt-in via env var.

The bar for the second list isn't "no" — it's "open an issue first so we can
discuss scope and defaults." The goal is for ccpatch to remain a tool a user can
hand to a colleague without explaining a list of footguns.

---

## PR checklist

- [ ] One patch per PR, or a tight cluster (e.g. a core fix plus its dependent
      extension).
- [ ] Manifest fields complete: `description`, `verify`, `category` where
      applicable. (See [docs/manifest-reference.md](./docs/manifest-reference.md).)
- [ ] `apply()` is idempotent (guard with a sentinel string).
- [ ] No anchor drift on the current `VERSION` from npm:
      `make patch-claude-code` succeeds.
- [ ] `make test-patches` passes.
- [ ] If the patch introduces a new exposed global, it follows the `__ccp*`
      naming convention and is documented in the patch's header comment.
- [ ] If the patch reads env vars, they're listed in `manifest.env` and in the
      `ccpatch.yml` long form.
- [ ] If the patch is version-sensitive, an entry is added to
      `runner/anchors.mjs`.

---

## Patch budget & deprecation policy

The extension corpus is the long tail of drift liability: every patch is a
recurring per-release maintenance cost, paid each time upstream ships. To keep
that cost bounded:

**New extensions must clear the settings-first bar.** A PR adding an extension
must state, in the PR description, why the behavior cannot be achieved with a
documented `settings.json` hook event (rule 10 in
[.claude/rules/hook-patches.md](./.claude/rules/hook-patches.md)). "A hook
exists but is less convenient" does not clear the bar — patches are reserved
for behavior the hook surface cannot express.

**New extensions must justify their anchor cost.** Prefer a stable
string-literal anchor or an existing `runner/anchors.mjs` entry. A patch that
needs a new version-specific regex variant per release (the `project_root`
pattern) needs an explicit maintainer sign-off acknowledging the treadmill.

**Idle extensions get deprecated.** An extension that is in no profile, has no
`ccpatch.yml` ack, and has needed no anchor maintenance interest for **6
upstream releases** is a candidate for removal: it is unexercised surface that
still costs a verify probe, a doctor row, and a drift-sweep cell every night.
Deprecation path: mark `enabled: false` with a `# deprecated:` comment in
`ccpatch.yml` for one release cycle, then delete the patch, its tests, and its
threat-model row together.

**Upstreamed behavior retires the patch.** When Claude Code ships a feature an
extension was papering over, the patch is deleted in the same PR that bumps
the supported version — not kept "just in case".

---

## Patch-authoring guidance

The deep how-to lives in [`docs/authoring-patches.md`](./docs/authoring-patches.md).
Two things worth internalizing before you write a `verify` block or a
network/fetch subscriber are called out below — they're easy to get wrong and
cost nothing to get right.

### Verify checks presence, not placement — known limitation

The verify primitive ([`runner/verify-core.mjs`](./runner/verify-core.mjs)) is
deliberately small: it only evaluates `present` / `absent` / `count` assertions
as substring tests over the patched bundle. It answers *"does my string appear in
the file?"* — it does **not** answer *"does my code run at the right structural
point?"*

That gap is real. A patch whose `apply()` injects at the wrong site — into a dead
branch, after the function it meant to wrap, or into the wrong one of several
look-alike call sites — still passes verify as long as its sentinel ends up
*somewhere* in the bundle. `@At`/AST selectors mitigate this on the **apply**
side by pinning *where* the injection lands; verify on its own cannot catch a
mis-targeted-but-present injection. (This is distinct from the "weak verify"
no-op case that [dry-run shadow mode](./docs/authoring-patches.md#dry-run-shadow-mode)
catches — there the sentinel pre-exists upstream; here the sentinel is genuinely
new but landed in the wrong place.)

Concrete guidance for placement-sensitive patches:

- **Prefer `count` over bare `present`.** Pinning the exact number of occurrences
  is far stronger than "at least one." `fetch_interceptor`
  ([`core/fetch_interceptor.mjs`](./core/fetch_interceptor.mjs)) asserts
  `count: { present: 2 }` on its `__ccpFetchInterceptorInstalled__` sentinel
  because the hook references it exactly twice — once at the guard and once at the
  assignment. A stray extra (or missing) copy fails verify immediately.
- **Use structurally-specific, unique sentinels — not generic ones.** A sentinel
  like `__ccpMyPatch_v1` that only your patch could have produced makes the
  presence test meaningful. Asserting on vocabulary that already exists in the
  upstream bundle (or could plausibly recur) tells you almost nothing about
  placement.
- **Lean on `@At`/AST anchors for placement.** When *where* the code runs matters,
  anchor the apply with the selector vocabulary in
  [`docs/anchors.md`](./docs/anchors.md) rather than trusting verify to notice a
  misplacement. Verify is the backstop that the string survived; the anchor is
  what makes sure it survived in the right spot.

### RTK shell hook and subshell tool rewrites

If you have the [RTK](https://github.com/anthropic-ai/rtk) token-saving shell hook active, it transparently rewrites common shell commands (`cat`, `grep`, `find`, etc.) to token-optimised proxies (`ugrep`, `bfs`, etc.). This is invisible in interactive shells but **breaks Makefile recipes and subshell invocations** that rely on POSIX flag compatibility — for example, `grep -oE` may fail with `ugrep: bad option` or `find -name` may fail with `bfs: bad option`.

If you hit unexplained option errors in `make` recipes:

1. **Bypass for a single command** — prefix it with `rtk proxy`: e.g. `rtk proxy grep -oE '[0-9]+' file`.
2. **Bypass for a make session** — unset the hook for that shell: `env -u RTK_HOOK make patch-claude-code`.
3. **Verify the hook is active** — `rtk --version` and `which grep` will show whether the shim is in play.

The hook is opt-in from the user profile; other contributors who don't run RTK are unaffected.

---

### packages/adk boundary — decision point

`packages/adk/` lives in the monorepo as a workspace package, but it is now a
**cleanly self-contained unit**: it owns its sources (`*.mjs` + `index.d.ts`),
its own `tests/` (run with `npm test -w @codehornets/adk`, or via the root
`npm run test:adk`), its `tsconfig.json`, `LICENSE`, and a `files`-scoped
`package.json`. It is published-ready (`@codehornets/adk`) but still developed
here for velocity. Keep that boundary clean when you touch it:

- **Source must not import from the monorepo.** ADK runtime code depends only on
  `node:*` and its own files; it consumes ccpatch via the `__ccp*` `globalThis`
  contract, never via a static import. Do not add `../../core` / `../../runner`
  imports.
- **One sanctioned cross-boundary edge.** `tests/adk-handoff.test.mjs`
  integration-checks the live `extensions/expose_system_prompt.mjs` shim the ADK
  consumes, importing it at `../../../extensions/...`. That is the *only* path
  reaching back into the monorepo; if the ADK is ever split into its own repo,
  that shim must be vendored or the test split.

This remains a revisable arrangement: if the ADK grows its own release cadence,
third-party consumers, or a conflicting test matrix, the next step is a sibling
repository (e.g. `ccpatch-adk`) consumed via a workspace protocol or semver
range. The self-contained layout above is intended to make that extraction a
near-mechanical move. If you're adding features to `packages/adk` that don't
directly serve the patch runner, open an issue to discuss whether the extraction
milestone has arrived rather than expanding the in-repo surface.

---

### Debugging a network/fetch subscriber

If you're writing a patch that registers a subscriber on the shared fetch
interceptor (`__ccpOnFetch`, `__ccpOnFetchBefore`, `__ccpOnFetchStream`), know
that **subscriber exceptions are swallowed by default.** The interceptor isolates
each subscriber so one buggy handler can't take down the CLI's network path —
which means a throw in your subscriber fails *invisibly* unless you opt into the
debug sink.

Swallowed errors are routed to `__ccpBusWarn`
([`core/fetch_interceptor.mjs`](./core/fetch_interceptor.mjs)), which stays silent
unless debugging is enabled. To surface them, set `CLAUDE_DEBUG=1` (the convention
the `debug` patch uses) or set `globalThis.__ccpDebug`; either makes the bus print
`[ccp:bus] subscriber <name> threw in <phase>: <message>` to stderr. If your
subscriber "does nothing" and you can't see why, run with `CLAUDE_DEBUG=1` first —
the error is almost certainly being caught and routed there.
