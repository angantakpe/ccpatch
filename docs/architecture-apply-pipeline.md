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

The caller (`applyNamedPatches`) drives `run.results`, `run.failures`,
`run.phaseTraces`, `run.drifts`, and `run.timings` off the returned struct
(see "The apply-state struct" below).

### `recordStage(args)` → string

Injects the coverage marker and captures the reverse diff for one patch. Its
internal ordering is load-bearing in **two** ways (both stated in the
`recordStage` comments in `apply-pipeline.mjs` — the code comments are
authoritative):

1. **Both operations run AFTER the async `onAfterApply` hook**, so they target
   the hook-finalized `effectiveCode`. Running earlier (inside
   `applySinglePatch`) caused two bugs: reverse diffs that no longer restored
   byte-for-byte, and coverage markers dropped by a hook rewrite (Finding #3).
2. **Coverage runs before the reverse-diff capture**, so the injected coverage
   bytes are included in the stored diff — a revert removes them too.

`recordStage` also threads the **carried sha**: `captureReverseDiff` returns
each record's `postSha256`, which is reused as the next record's `preSha256`
(the post code state of patch N IS the pre code state of patch N+1). The reuse
is gated on **string reference identity** (`preCode === state.nextCode`):
the runner threads the previous patch's `effectiveCode` straight into the next
patch's `preCode` as the *same string object*, so each ~16MB code state is
hashed exactly once per build instead of twice per changed patch (hashing is
the dominant harness cost). An `onBeforeApply` hook that rewrites `ctx.code`
produces a fresh string, the identity gate misses, and the sha is recomputed —
correct, just slower. A `CCPATCH_DEBUG` guard at the threading site in
`runner.mjs` throws if the identity is broken *without* a hook to explain it,
so an accidental copy (slice/concat/`String()`) breaks loudly in dev instead
of silently doubling hash work. See the PERF comments in
`runner/reverse-diff.mjs`.

### `makeVerifyFlusher(args)` → `flushPendingVerify(phase)`

Returns the async phase-flush closure. The closure drains `state.pendingVerify`,
groups entries by snapshot identity, runs `verifyBatch` once per unique snapshot,
then dispatches `onVerifyFail` heals per entry.

The flusher takes **one context object**: the runner's apply-state struct
(`state`) plus `frame` / `checkVerify` / `logger` — not a positional list of
loose collections. Everything mutable it reads or writes (`pendingVerify`,
`nextCode`, `failures`, `verifyIssuesReport`, `harness`) lives on the struct.

`verifyBatch` itself is a thin composition over the verify-core kernel: it
unions the unique literals across all entries, runs `scanOccurrences()` (one
scan per snapshot), and satisfies each entry's assertions via
`checkVerifyCore()` fed the recorded positions — the matching algorithm exists
in exactly one place (`runner/verify-core.mjs`).

## The apply-state struct (`run`)

`applyNamedPatches` used to thread 5+ loose mutable collections through the
phase loop. They now live on a single struct the loop stages take and return
(formalizing what `applySinglePatch`'s ApplyResult and `recordStage`'s shared
handle already half-did):

```
run = {
  nextCode,       // the threaded bundle string (an onVerifyFail heal rewrites it)
  pendingVerify,  // deferred-verify queue (loop pushes, phase flush drains)
  carriedSha,     // recordStage's carried sha256 (postSha(N) → preSha(N+1))
  results,        // name -> status string map (returned to the caller)
  failures,       // strict/required/forceFail failure lines (throws at the end)
  timings, drifts, verifyIssuesReport,   // report buckets
  phaseTraces,    // per-phase overlap traces
  harness,        // per-build harness-timing buckets (ms)
}
```

`recordStage` and `makeVerifyFlusher` both receive this struct as their
`state` handle.

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

### Arch#1 — prepend vs low-offset body edit

A true **prepend** (the near-offset-0 shim injections: esm_compat /
fetch_interceptor / bun_shim / contracts) has no meaningful original-bundle
coordinate: the shared-frame translation collapses every prepend onto a
sentinel range where they would all false-overlap each other, so
`detectOverlapsInPhase` drops prepend ranges up front.

The discriminator (authoritative comments: `isPrependRange` in
`runner/conflict.mjs`) is each edit's offset **in its OWN pre-apply frame**,
recovered by adding the trace's `_deltaBefore` back — NOT the sign of the
translated coordinate. A range is a prepend only when BOTH hold:

1. its translated start is negative (it landed in the collapsed sentinel
   region that produced the false overlaps in the first place), **and**
2. its pre-apply-frame start is within `PREPEND_REGION_BYTES` (64) of offset 0
   — i.e. it genuinely injected at the top of its bundle (the window absorbs a
   shebang line without admitting body edits).

The original test was `r[0] < 0` — a coordinate-**sign** proxy. That conflates
two very different patches: a true prepend, and a genuine **low-offset body
edit** that ran AFTER a large net prior insertion — `deltaBefore` is a big
positive number, so `start - deltaBefore` goes negative even though the edit
touched real bundle bytes, and its real conflict was silently suppressed.
Condition (2) is what the sign test was missing: such an edit satisfies (1)
but fails (2) (its pre-frame start is large), so it is no longer dropped,
while true top-of-bundle prepends satisfy both and still don't false-overlap
each other. A synthetic trace without `_deltaBefore` defaults to 0 and never
trips (1) for small offsets. Covered by `tests/conflict-prepend.test.mjs`.

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

### S5 — first-write-failure latch (+ `artifactsDegraded`)

Only the first storage write failure of a run produces a warning log; subsequent
failures on the same path are silently suppressed via `makeStorageWarnOnce`.

The latch only suppresses *logging*: every failed best-effort sidecar write
(conflicts JSONL, anchor-drift JSONL, coverage-apply manifest, patch-results
catalog) is still collected (deduped by artifact label) on the latch's
`.failures` array. When any write failed, the runner attaches
`report.artifactsDegraded = [{ artifact, error }]`, which the build report
surfaces in both the `--json` schema and the text summary box — a degraded run
still succeeds (the bundle is fine), but "build OK" no longer reads as
"all forensics written". The field is absent on the happy path, so the report
shape is unchanged when nothing failed. The write helpers also return their
outcome directly (`writeConflictsArtifact` → boolean, `writeApplyArtifacts` →
`{ failed: string[] }`) for callers outside the runner.
