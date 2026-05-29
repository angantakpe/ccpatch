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
