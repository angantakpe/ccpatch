# Patch lifecycle hooks

Three optional exports let a patch react to its own apply lifecycle. They are
inspired by BepInEx / Fabric and run inside `applyNamedPatches` around the
normal apply step. They are *named exports* on the patch module, not fields on
the default-exported manifest object.

```js
export async function onBeforeApply(ctx) { /* mutate ctx.opts or ctx.code */ }
export async function onAfterApply(ctx)  { /* mutate ctx.appliedCode */ }
export async function onVerifyFail(ctx)  { /* return string → retry verify */ }
```

`ctx` is a single per-patch object reused across all hook fires. Fields:

| Field             | When set                   | Notes                                                     |
| ----------------- | -------------------------- | --------------------------------------------------------- |
| `name`            | always                     | Patch name (filename stem).                               |
| `phase`           | always                     | `pre` / `main` / `post`.                                  |
| `code`            | onBeforeApply              | Input code into `apply()`. Mutable.                       |
| `appliedCode`     | onAfterApply, onVerifyFail | Output of `apply()` (or fallback). Mutable on onAfterApply. |
| `opts`            | always                     | Shallow copy of patchOptions for this patch. Mutable on onBeforeApply. |
| `verify.issues`   | onVerifyFail               | Array of failure descriptions from `checkVerify`.         |
| `attempt`         | always                     | `1` on first apply, `2` on the post-onVerifyFail retry.   |
| `logger`          | always                     | The runner's logger.                                      |

**Retry contract.** `onVerifyFail` may return a string. If it does, the runner
runs `checkVerify` once more against that string. **One retry, ever.** If verify
still fails (or the hook returned anything other than a string), the original
failure stands and the patch fails per its strictness mode.

**Errors.** A hook that throws is logged as `[hook] <name>.<hookName>` and is
treated as the corresponding failure (apply throw / verify fail). Hooks are not
swallowed silently.

**Telemetry.** Every hook fire writes one JSONL line to
`storage/outputs/patch-lifecycle.jsonl`:

```json
{ "ts": "2026-05-22T...", "patch": "message_normalizer",
  "hook": "onAfterApply", "attempt": 1, "phase": "main",
  "byteDelta": 412, "durationMs": 5 }
```

Hooks that throw still produce an entry with an `error` field. See
`core/message_normalizer.mjs` for a real-world `onAfterApply` self-check.
