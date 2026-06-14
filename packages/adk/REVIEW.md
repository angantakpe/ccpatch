# ADK Architecture Review

A structural review of `packages/adk/` (index, host, contracts, agent, memory,
handoff, tool-registry), ranked by leverage. Findings #1 and #2 are **addressed**
in the same change that added this document; the rest are recorded as known debt.

The ADK is well-built — thorough docs, real test suites, careful trust
boundaries, atomic persistence. These notes are about structural debt that will
bite as the package grows, not about correctness defects in what ships today.

---

## 1. The isolation model was leaky — `createAdk()` over-promised — ADDRESSED

`createAdk()` advertised "two instances never share state", but only **agents and
tools** were actually scoped. Three returned methods were the raw global-bound
functions (`createMemory`, `capabilities`, `useAgentBus`), and swap is
architecturally unscopable — there is exactly one persona slot
(`__ccpSystemPromptOverride`), so per-instance swap stacks are "a convenient
fiction backed by a single shared stack" (`handoff.mjs`). Cross-scope restore
then fails **silently** (returns `false`).

**Fix applied:** the boundary is now stated explicitly instead of implied
uniform. `index.mjs` carries an **ISOLATION CONTRACT** that lists, per method,
what is INSTANCE-LOCAL (agents, tools, swap-stack footprint, dispose) vs.
PROCESS-GLOBAL (persona slot, bus, capabilities probe, path-keyed memory). The
three global methods are labeled as deliberately-shared at the return site,
`createAdk()` instances now carry a stable `id` for introspection, and
`index.d.ts` + the `Adk` typedef were updated to match. Memory is **not**
fake-scoped: it is keyed by file path on purpose (cross-process merge depends on
it), and that is now documented rather than papered over.

## 2. No host-primitives port — `globalThis.__ccp*` reached from everywhere — ADDRESSED

The `__ccp*` globals were touched ~40 times across five files, each site
re-implementing `typeof x !== 'function'` / `Array.isArray` / `?.()` guards.
There was no adapter between "the ADK" and "the bundle's exposed internals", so a
change to how a primitive is probed had to be chased through five files.

**Fix applied:** `host.mjs` is the single port onto the host primitives. Every
other module depends on `host`, not on `globalThis` — verified by grep (only
doc-comment references to `globalThis.__ccp*` remain). The port reads `globalThis`
**live** on every call (no import-time snapshot), which preserves both the
bare-global test stubs and late-binding hosts. `host.emit()` centralizes the
guarded fire-and-forget emit that several modules hand-rolled. Covered by
`tests/adk-host.test.mjs`.

---

## Known debt (not yet addressed)

### 3. Contract-drift handling is centralized in data but duplicated in behavior
`contracts.mjs` made the *pins* single-source (`ADK_CONTRACT_REQUIREMENTS`), but
each consumer re-implements the *reaction* differently and with a subtle,
divergent memoization asymmetry:
- `capabilities()` downgrades a boolean (`index.mjs`)
- tool-registry latches `_driftChecked` only on the `via:'require'` path
- handoff throws at the write site, with its **own** `_driftChecked` latch

The "latch only when proven via require, re-check otherwise" rule is correct but
non-obvious and now lives in two places that can drift apart. **Direction:** move
the latch + "drift → action" policy into `checkContract` (or the host port) so
consumers branch on a single decided verdict.

### 4. Defensiveness is swallowing signal
17 catch blocks in `memory.mjs`, ~12 in handoff, ~11 in tool-registry — much of it
silent fallback, and the failure-reporting channel is inconsistent (sometimes a
bus event, sometimes a once-only `console.warn`, sometimes a bare `return false`,
often DEBUG-gated). Concrete hazards:
- **Clear-merge can silently drop a concurrent process's write** on name
  collision (`memory.mjs`) — intentional but very sharp.
- Out-of-order swap restore returns `false` with no durable signal.
- `validateInput` silently ignores 13 JSON-schema keywords; the warning is
  definition-time and DEBUG-gated.
- `transform.onRead`/`onWrite` inverse is **never verified** — a bad pair
  silently corrupts the store on reload.

**Direction:** one structured observability seam (`report(level, event, detail)`)
that always emits to the bus and optionally logs; make "silent" a deliberate
level, not an accident of which catch you landed in. Add the cheap correctness
guards that are missing (transform round-trip check at construction; surface
clear-merge conflicts as events).

### 5. The three big files mix several concerns each
- `handoff.mjs` (1074 lines) = `SwapCoordinator` singleton + handoff factory +
  `AgentRouter` (the router is a sibling concern with no dependency on swap
  internals).
- `tool-registry.mjs` (873) = schema validation + a shared poll scheduler + drift
  detection + promise lifecycle.
- `memory.mjs` (569) = two distinct persistence strategies behind one factory.

**Direction:** extract `swap-coordinator.mjs`, `agent-router.mjs`, a
`schema-validate.mjs`, and split the two memory strategies behind a tiny
`Persistence` interface. Smaller files shrink the per-change blast radius — which
matters in a repo whose whole premise is surgical patching.

### 6. Memory: cwd-bound sandbox + unbounded append-log compaction
The path sandbox is computed against `cwd()` **at construction**;
`process.chdir()` later moves the goalposts. The append-log mode's compaction
snapshot isn't bounded by `capBytes`, so a store grown past the cap re-reads
unbounded. **Direction:** anchor the sandbox to an explicit root (e.g.
`host.path()` / a project-root helper) rather than live `cwd()`; make the
append-log strategy an opt-in subpath import so the common path stays small.

### 7. Surface area has run ahead of consumption
The shipped `adk` profile only exercises the hello-agent → tools path;
`defineHandoff` / `swap` / `AgentRouter` / `createMemory` / `useAgentBus` are
wired at the capability level but **no shipped patch consumes them**. That is a
lot of security-sensitive machinery (TOCTOU pins, swap locks, cross-process
merge) validated only by its own unit tests. **Direction (highest strategic
lever):** build one reference consumer patch that exercises handoff + router +
memory end-to-end through a real patched session, or explicitly mark the
unconsumed surface as provisional and resist hardening it further until a
consumer exists.

### Smaller items
- `depthOf()` is O(n) per swap push/restore (`handoff.mjs`) — fine at depth 64,
  but it is on the hot path.
- Duplicated "is the registry array ready?" check in tool-registry — could factor
  to `isRegistryReady()` (the host port now makes this a one-liner: `host.hasRawTools()`).
- No namespace guard on tool names — a tool can be named to shadow a
  `__ccp*`-adjacent global.

---

## What is already good (do not regress)
Atomic temp+rename with cross-process merge; nonce-gated tool injection with a
fail-open test path; persona pinning (sha256) closing the swap TOCTOU; the shared
poll scheduler instead of N timers; the `DECISIONS.md` finding-index. These are
the load-bearing parts — the recommendations above are about making the
*boundaries* between them explicit, not rewriting them.
