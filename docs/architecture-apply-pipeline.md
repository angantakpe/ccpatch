# Architecture: apply-pipeline.mjs

## Overview

`runner/apply-pipeline.mjs` contains the three stages that `applyNamedPatches`
orchestrates per patch: **apply**, **record**, and **verify**. They were
extracted from `runner.mjs` as independently-testable units with no behavior
change (Item 2 refactor).

```
applyNamedPatches (runner.mjs)
  └─ for each patch:
       ├─ applySinglePatch()     apply stage  (sync, returns ApplyResult)
       ├─ onAfterApply hook      async, may mutate effectiveCode
       ├─ recordStage()          coverage injection + reverse-diff capture
       └─ pendingVerify.push()
  └─ flushPendingVerify()        verify stage (end of phase / end of run)
```

## Stage functions

### `applySinglePatch(args)` → ApplyResult

Calls `apply()` (declarative kinds via `compileKind`, free kinds via `patch.apply`),
classifies the outcome, and builds the per-phase overlap trace.

**Return shape:**
```
{ name, status, effectiveCode, timingMs, failReason, forceFail, trace, driftEntry }
```

`status` values: `applied` | `applied-fallback` | `no-change` | `no-change-ok` | `error`

The caller (`applyNamedPatches`) drives `results`, `failures`, `phaseTraces`,
`drifts`, and `timings` off the returned struct.

### `recordStage(args)` → string

Injects the coverage marker and captures the reverse diff **after** `onAfterApply`
has finalized `effectiveCode`. Running earlier (inside `applySinglePatch`) caused
two bugs: reverse diffs that no longer restored byte-for-byte, and coverage markers
dropped by a hook rewrite (Finding #3).

Coverage runs before the reverse-diff capture so its bytes are included in the
stored diff (a revert removes them too).

### `makeVerifyFlusher(args)` → `flushPendingVerify(phase)`

Returns the async phase-flush closure. The closure drains `state.pendingVerify`,
groups entries by snapshot identity, runs `verifyBatch` once per unique snapshot,
then dispatches `onVerifyFail` heals per entry.

State shared between the apply loop and the flush (`nextCode`, `pendingVerify`) is
carried on a single `state` handle to avoid two separate `let` bindings in the loop.

## Public helpers

### `applyFallbackDiff(preCode, normalized, name, patchOptions, logger)`

Attempts the stored unified-diff fallback when `apply()` no-ops. Returns the
fallback-applied code or `null`. Only called when the patch has something to inject
(not `verify.absent`-only).

### `detectDrift(preCode, normalized, name, patchOptions)`

Computes anchor-drift forensics (pure — no fs writes, no logging). Probes
`anchor.literal` + `verify.present` + `verify.absent` in priority order,
fuzzy-matches each against `preCode`, dedupes within 50-byte buckets, returns
top 3 candidates. Caller writes `anchor-drift.jsonl` and logs candidates.

## Key design decisions

### PERF2 — per-snapshot verify, not verify-against-final

Each mutating patch forms its own snapshot group in `flushPendingVerify`.
Collapsing to one end-of-phase verify against the final code would produce false
failures: a patch P1 that injects sentinel S and is legitimately rewritten by a
later same-phase P2 (removing S) PASSES per-snapshot but FAILS against the final
code. Per-snapshot is the correct semantic ("did THIS patch do what it claimed
when it ran").

### S4 — lazy diffSpans in non-strict mode

Overlap detection is impossible with fewer than 2 patches in a phase.
In non-strict mode, `diffSpans` computation is deferred until `detectAndRecordOverlaps`
finds a phase with ≥2 patches. `structuredPatch` is pre-computed and cached on the
trace (`_sp`) so the lazy path never recomputes it. Strict mode computes spans
eagerly (they back FATAL overlap checks).

### A2 — shared coordinate frame

All overlap ranges are translated into the original-bundle coordinate frame by
subtracting `deltaBefore` (net length change from all prior patches).
`preCode` for each patch is exactly `original + prior-deltas`, so subtracting
its delta collapses every patch's spans into the same frame.
`detectOverlapsInPhase` can then compare spans like-for-like.

### Arch#2 — ApplyResult struct

The ~10-things-in-one-try body was extracted into `applySinglePatch()` returning
an `ApplyResult` struct. The loop drives mutable run state off the struct.
The async `onAfterApply` hook and verify push remain in the loop (they need
`await` and loop control).

### Finding #1 — no-change with verify.present is fatal by default

A patch that declared `verify.present` but no-op'd clearly failed to inject.
This is a build failure even in default (non-strict) mode, unless `--best-effort`
downgrades it to a warning.

### Finding #2 — onVerifyFail heal and the additive frame

A successful `onVerifyFail` heal replaces `state.nextCode` out-of-band.
`frame.recordHookDelta` records the length change so the additive-frame invariant
can subtract it back out. A genuine non-additive break (a patch kind that doesn't
preserve the frame, or an `onBeforeApply` that swapped `ctx.code`) still diverges
and throws.

### S5 — first-write-failure latch

Only the first storage write failure of a run produces a warning log; subsequent
failures on the same path are silently suppressed via `makeStorageWarnOnce`.
