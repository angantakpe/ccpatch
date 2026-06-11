---
description: Non-negotiable rules when authoring or editing patches that touch Claude Code's hook engine in cli.js
globs:
  - "extensions/**/*.mjs"
  - "core/**/*.mjs"
  - "ccpatch.yml"
  - "runner/anchors.mjs"
  - "tests/patch-verification.test.mjs"
---

# Rules: hook patches against cli.js

1. **Never anchor on minified identifiers** (`aP`, `Usf`, `oU8`, `p19`, `dy`,
   `JMq`, `dsf`, …) — they rotate every release. Anchor on stable string
   literals (error messages, log strings, feature-flag keys) or register an
   AST anchor in `runner/anchors.mjs` and resolve via `findFunctionByLiteral`.

2. **Every patch is idempotent.** Guard `apply()` with a versioned sentinel
   (`__ccpMyHook_v1`) and return the input unchanged when it's already
   present. Applying twice must be byte-identical to applying once.

3. **`verify` is mandatory and must be strong.** At least one of
   `verify.present` / `verify.absent` / `verify.count`; prefer `count:` —
   `present`-only patches show as UNVERIFIED in `ccpatch doctor` and fail
   `--strict`.

4. **Fail open at runtime, fail loud at apply time.** Injected runtime code is
   wrapped in `try/catch` and must never break the CLI. Apply-time anchor
   misses `console.warn('  [!] <name>: anchor not found')` and return `code`
   unchanged — never throw mid-bundle, never half-apply.

5. **Preserve engine semantics.** Exit code 2 = blocking (stderr →
   `blockingError`); exit 0 + JSON stdout = parsed hook output; anything else
   = non-blocking error. A patch must not change these contracts for existing
   hooks, only add behavior.

6. **Shims-as-patches for real logic.** More than ~15 lines of injected code
   goes in its own `.mjs` shim; the patch injects only a thin wrapper. Model:
   `extensions/hook_noise_mute.mjs`.

7. **No Anthropic code in the repo.** Patches transform the user's local
   bundle; never commit bundle excerpts beyond short anchor literals. Bundles
   live under `releases/`/`storage/` per existing .gitignore conventions.

8. **Registration and tests are part of the change.** A new patch PR includes:
   the patch file, its `ccpatch.yml` entry (`enabled: false` for extensions),
   a case in `tests/patch-verification.test.mjs`, and a passing
   `make test-patches`. If you touched anchors, run `make doctor` against the
   installed version and report the result.

9. **Target both pristine and patched bundles.** Anchors must match in
   `cli.js` AND in already-patched output (`releases/*.patched.mjs`,
   `cli-patched.js`) since profiles compose; if your anchor sits inside
   another patch's injection region, declare `dependsOn` and the correct
   `phase` (`pre | main | post`).

10. **Settings-level hooks first.** If the requested behavior is achievable
    with a documented `settings.json` hook event, do not write a patch —
    say so and stop.
