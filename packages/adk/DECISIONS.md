# ADK Decision Log — the "FINDING N" index

This file is the canonical reference for what each `FINDING <n>` meant. The ADK
modules were originally annotated with opaque `FINDING 1..16` markers in their
inline comments; those numbers are being removed from the code (the explanatory
prose stays). This log preserves the traceability: one entry per finding, per
module, mapping the original number to a short title and the decision/rationale.

Findings are numbered per the original audit, so the same number can mean
different things in different modules (e.g. `FINDING 2` is the contract drift
guard in several modules, `FINDING 7`/`FINDING 8`/`FINDING 15` recur with
module-local meanings). Entries are grouped by module and ordered by number.

The text below is sourced from the pristine committed (`git show HEAD:`) versions
of the modules, so it reflects the rationale as written before the numbering was
stripped.

---

## tool-registry.mjs

Findings present: 2, 8, 9, 12, 14, 15, 16.

### tool-registry FINDING 2 — load-bearing drift guard on the gated injection path
Before routing an injection through the (possibly drifted) `__ccpRegisterTool`
global, positively re-validate the `toolDispatch` typed contract shape via
`__ccpRequire` (`shape: ['registerTool']`). A throw is *proven drift* → latch a
refusal and `tryInject()` fails closed. Fail-OPEN when there is nothing to prove
(no `__ccpRequire` / no registered `toolDispatch` contract), which keeps the
bare-array and fake-registrar test stubs working. Memoized at most once per
process (`gatedPathTrusted()`); `__resetDriftGuardForTests()` clears the latch.

### tool-registry FINDING 8 — shared drain scheduler
Previously every waiting scope armed its OWN `setInterval`, so N waiting scopes
meant N timers all polling `__ccpRawTools`. Replaced with a SINGLE module-level
timer ticking the set of registered-waiting scopes. Per-scope semantics are
preserved exactly: each scope advances its own attempt counter every
`(interval / base)` ticks, so its effective cadence (50ms primary / 250ms bus
safety-net) and ~5s bounded timeout are unchanged; the per-scope once-only
"patch not enabled" warning and give-up behaviour are unchanged.

### tool-registry FINDING 9 — cheap input-size measurement without serializing scalars
`inputByteSize()` measures input against the `MAX_INPUT_BYTES` ceiling cheaply:
null/undefined/boolean/number/bigint/symbol are tiny by construction →
short-circuit to 0; strings use `Buffer.byteLength` (UTF-8, no JSON copy); only
objects/arrays fall back to `JSON.stringify`. A non-serializable object
(cycle / throwing `toJSON`) returns 0 — the schema validator and `execute()` are
the next line of defence.

### tool-registry FINDING 12 — pluggable `validate(input)` hook
Optional `validate(input) => string|null` on a tool def, run at the `call()`
boundary AFTER the built-in `validateInput` (which short-circuits first on
failure). A non-empty string rejects with that message; null/undefined accepts; a
thrown error is surfaced as a validation error. This is the dependency-free seam
for wiring in ajv/zod/etc. to cover the deep checks `validateInput` intentionally
does NOT perform. Zero deps shipped — the caller brings their own.

### tool-registry FINDING 14 — full queued/live/failed lifecycle view
Tools carry a status (`'queued'` | `'live'` | `'failed'`) in `scope.live` (a Map,
not a Set). `listToolsIn()` reports ONLY `'live'`; `toolStatusesIn()` reports the
full set so callers can SEE the silent-failure cases. A tool that times out is
marked `'failed'` (observable) rather than dropped from the map; a queued tool is
`'queued'` until it actually goes live.

### tool-registry FINDING 15 — cross-agent dispose contract for a tool scope
`disposeToolScope()` tears a scope down idempotently: deregister from the shared
drain scheduler + drop the bus sub; unregister/dispose every LIVE tool (gated or
fallback path); clear the queue and resolve any pending `.ready`/`.injected` to
false so awaiters never hang; clear the status map and reset drain bookkeeping for
reuse.

### tool-registry FINDING 16 — silent-by-default, louder-on-debug
Queueing and never-injected ("poll timed out") cases are silent by default and
escalate to a warning ONLY on the debug switch (`CLAUDE_DEBUG` / `__ccpDebug`), so
authors can opt into seeing a tool that did not inject immediately. (The once-only
hard-timeout `console.warn` for the no-array case is left as-is.)

---

## handoff.mjs

Findings present: 1, 2, 5, 10, 13, 15.

### handoff FINDING 1 — exclusive swap lock over the single global persona slot
There is exactly ONE global persona slot shared by every `createAdk()` instance,
so per-instance swap isolation is a convenient fiction backed by a single
`GLOBAL_SWAP_STACK` with LIFO ownership. `tryAcquireSwap(scope)` makes the
single-ownership reality EXPLICIT and opt-in: while one scope holds the exclusive
lock (`_swapLockOwner`), another scope's `tryAcquireSwap` returns null, so a
caller can detect contention up front instead of at out-of-order-restore time. It
returns a token `{ swap(persona), restore(), release(), owned }`; the lock is
advisory over the shared stack — the legacy LIFO path does NOT consult it, so
existing callers are unaffected.

### handoff FINDING 2 — load-bearing systemPrompt contract handshake at the write site
`assertSystemPromptContract()` makes the drift guard load-bearing at handoff's
actual persona WRITE site (where a present-but-broken `systemPrompt` contract
would do real damage). Before the first live write, consult
`__ccpRequire('systemPrompt', { minVersion: 2, shape: ['getNonce'] })` — but ONLY
when both the require helper AND a registered `systemPrompt` contract exist. A
throw is proven drift → refuse the write with a clear Error (not memoized true, so
a recovered host re-checks). Absent helper / unregistered contract → proceed
unchanged (fail-open for bare-global test stubs). Memoized otherwise.

### handoff FINDING 5 — persona PIN at definition time (swap-mode TOCTOU)
`allowSwapTargets` only allowlists the target NAME; a later `defineAgent()` could
swap a hostile `systemPrompt` under an allowlisted name. So a `swap` handoff whose
target is already registered at definition time captures a PIN: the sha256 of the
resolved `systemPrompt`, held in the closure. At execute time, a drifted live hash
REFUSES the swap (emits `handoff.pin.mismatch`, warns once, returns a readable
tool_result error) rather than applying a changed persona.

### handoff FINDING 10 — pin-on-first-resolve closes the deferred-case TOCTOU hole
When the swap target was UNREGISTERED at definition time there is nothing to pin
yet (`pinDeferred`). Rather than trusting whatever persona is registered on every
subsequent execute (guarded only by the name allowlist), the FIRST execute that
resolves a live persona captures its sha256 into `pinnedHash` and treats it as the
pin for all later executes — so a swapped-in persona that later drifts is refused
exactly like the define-time-pinned case. `handoff.pin.deferred` fires only on the
first resolve; `handoff.pin.captured` records the capture.

### handoff FINDING 13 — sanitize + cap the AgentRouter submit string
Cheap insurance on `AgentRouter.start()`'s submit. The trusted-code model means a
predicate's persona string is not adversarial, but an unbounded or
control-char-laden submit can still wedge the host's input pipeline. Cap the
submitted byte length (`MAX_SUBMIT_BYTES`, 128 KB) and strip C0/C1 control
characters (allowing only newline and tab) via `sanitizeSubmit()` before handing
the string to `__ccpSubmitInput`.

### handoff FINDING 15 — dispose a scope's swap footprint
`disposeHandoffScope()` tears down a scope's swap footprint per the
instance-dispose contract: LIFO-pop/restore every `GLOBAL_SWAP_STACK` entry OWNED
by this scope, release the exclusive swap lock if held, and unregister the
auto-registered `transfer_back` tool if present. Idempotent; returns the count of
entries restored. Entries owned by OTHER scopes are left untouched (single global
slot — never clobber another instance's live persona); an owned entry not at the
LIFO top is left in place, mirroring the honest-LIFO refusal policy.

---

## memory.mjs

Findings present: 6, 7, 8, 10, 11a, 11b, 11c, 15.

### memory FINDING 6 — memoized snapshot deep clone
`structuredClone(cache)` on every `snapshot()` call is O(store). Instead cache ONE
deep clone (`snapshotClone`), invalidate it on any mutation, and rebuild it lazily
on the first `snapshot()` after a write. Each call still returns a FRESH clone of
the memo, so callers can never mutate the live store — nor each other's snapshots —
through the returned value.

### memory FINDING 7 — hard coalesce cap + atomic 0600 write
The 100ms debounce re-arms on every mutation, so continuous `set()` churn could
starve the flush indefinitely. `MAX_COALESCE_MS` (1s) is the absolute ceiling on
how long dirty data may sit unwritten: tracked via `firstDirtyAt` (the oldest
dirty mutation since the last flush), once that age is exceeded the next
`scheduleWrite()` flushes synchronously instead of re-arming. (FINDING 7 also
covers the durability half: the file is written `0600` and replaced ATOMICALLY via
a sibling temp file + `renameSync`, so a crash mid-write leaves the old file
intact. Contents remain untrusted-at-rest plaintext JSON — `0600` limits readers,
it is not encryption.)

### memory FINDING 8 — single module-level exit-flush registry
Registering a separate `process.once('exit', ...)` per `createMemory()` instance
leaks listeners (Node MaxListeners warning) and retains each instance's closure.
Instead keep ONE module-level Set of flush-on-exit callbacks and register the
`'exit'` listener exactly once; each instance adds its (synchronous) flusher and
removes it via `dispose()`.

### memory FINDING 10 — whole-file rewrite is acceptable at this scale
Every flush rewrites the WHOLE file (O(store)), not a delta. Acceptable because
`MAX_FILE_BYTES` (5 MB) bounds the rewrite cost. A store that outgrows that cap
should move to an append/delta log format instead of full-file rewrites.

### memory FINDING 11a — shape validation on load
A corrupt-but-parseable array/primitive (e.g. `"[1,2]"`, `"42"`, `"null"`) must
NOT become the store, since get/set assume a plain object. On load, if the parsed
JSON is null / non-object / array, reset to `{}` and warn (on the debug switch).

### memory FINDING 11b — cross-process lost-write safety (re-read + merge)
If the on-disk file's mtime is NEWER than the mtime we loaded
(`loadedMtimeMs`), another process wrote it after us; blindly writing our cache
would drop their keys. Instead re-read the fresher disk store and re-apply only
OUR `dirtyKeys` over it (last-write-wins per dirty key; keys other processes added
survive). A pending `clear()` (`dirtyClear`) isn't expressible as per-key dirt, so
it's handled specially in the merge: start from disk, keep untouched disk keys,
overlay our post-clear re-sets.

### memory FINDING 11c — encryption/redaction transform hook
Callers may plug in a reversible `transform` (`onWrite` / `onRead`) mapping the
serialized JSON to/from on-disk bytes (encrypt, base64, redact). Default is
identity → plaintext JSON (backward compatible). No crypto lib is bundled;
`onWrite`/`onRead` are the caller's responsibility and MUST be inverses of each
other.

### memory FINDING 15 — deep-copy snapshot (no nested-ref leak)
A shallow `{ ...cache }` shares nested object/array refs, so a caller mutating
`snapshot().foo.bar` would corrupt the live store. `snapshot()` uses
`structuredClone()` (Node 17+) for a dependency-free DEEP clone so nested
mutations cannot leak back. (Works together with FINDING 6's memoization.)

---

## index.mjs

Findings present: 2, 12, 13.

### index FINDING 2 — version/shape handshake in capabilities()
Where a typed contract is registered (`core/contracts.mjs`), `capabilities()`
cross-checks ALL contracted capabilities via `__ccpInspectContracts` so a
present-but-shape/version-drifted global is not reported as usable. The direct
global probe stays the source of truth (contracts are opt-in per boundary); the
contract check only ever DOWNGRADES a capability it can positively prove broken
(never invents one) and records why in `detail[cap].reason`. Required minimums:
`swap` → `systemPrompt` minVersion 2 + shape `['getNonce']`; `tools` →
`toolDispatch` shape `['registerTool']`; `delegate` → `agentTool` shape
`['invoke']`. Fully defensive (try/catch, advisory, never throws).

### index FINDING 12 — top-level introspection mirrors bound to the DEFAULT instance
`listTools` / `swapDepth` / `currentPersona` are surfaced at the top level bound
to the DEFAULT instance, and `createAdk()` instances expose the same as methods.
`listTools` is this instance's tool scope; `swapDepth` counts entries THIS instance
owns on the single global swap stack; `currentPersona` reads the one global persona
slot shared by all instances.

### index FINDING 13 — per-capability remediation detail
`caps.detail[cap] = { live, patch, reason? }`: `live` mirrors each boolean and
`patch` names the providing patch (`CAPABILITY_PATCH`) so a caller seeing `false`
knows what to enable. `reason` is populated only when the FINDING 2 contract
handshake downgraded the capability.
