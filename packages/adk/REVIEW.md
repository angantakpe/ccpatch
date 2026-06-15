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

### 3. Contract-drift handling is centralized in data but duplicated in behavior — ADDRESSED
`contracts.mjs` made the *pins* single-source (`ADK_CONTRACT_REQUIREMENTS`), but
each consumer re-implemented the *reaction* differently and with a subtle,
divergent memoization asymmetry:
- `capabilities()` downgrades a boolean (`index.mjs`)
- tool-registry latched `_driftChecked` only on the `via:'require'` path
- handoff threw at the write site, with its **own** `_driftChecked` latch

The "latch only when proven via require, re-check otherwise" rule was correct but
non-obvious and lived in two places that could drift apart.

**Fix applied:** the latch + "drift → action" decision moved into
`contractVerdict(name)` in `contracts.mjs`, which returns one decided verdict —
`'trusted'` (require-proven, latched in a single process-global `_trusted` set),
`'refuse'` (proven drift, not latched), or `'proceed'` (nothing to prove /
advertised-only, not latched). `gatedPathTrusted()` (tool-registry) and
`assertSystemPromptContract()` (handoff) now hold only their *reaction* — false
vs. throw on `'refuse'`, proceed otherwise — and no longer carry their own latch
state. The two per-module reset seams (`__resetDriftGuardForTests`,
`__resetSystemPromptDriftGuardForTests`) are kept as back-compat aliases over the
central `__resetContractVerdictsForTests`. `capabilities()` / `useAgentBus()`
intentionally keep calling raw `checkContract` (they re-probe every call and must
never memoize). Covered by `tests/adk-contracts.test.mjs` §5.

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

### 7. Surface area has run ahead of consumption — MARKED PROVISIONAL (COD-12)
The shipped `adk` profile only exercises the hello-agent → tools path;
`defineHandoff` / `swap` / `AgentRouter` / `createMemory` / `useAgentBus` are
wired at the capability level but **no enabled-by-default patch consumes them**.
That is a lot of security-sensitive machinery (TOCTOU pins, swap locks,
cross-process merge) validated only by its own unit tests. **Direction (highest
strategic lever):** build one reference consumer patch that exercises handoff +
router + memory end-to-end through a real patched session, or explicitly mark the
unconsumed surface as provisional and resist hardening it further until a
consumer exists.

**Decision (COD-12): marked PROVISIONAL — the docs path, not the consumer
path.** Of the two directions above, this issue takes the second. These surfaces
are now **explicitly provisional**: wired at the capability level, validated by
their own `tests/adk-*.test.mjs` suites, but **not consumed by any
enabled-by-default shipped patch**. The README banner and the per-surface notes
below say so in the same words, so the API docs no longer imply a consumption
guarantee the build does not make.

Rationale for choosing docs over a shipped consumer here:
- `extensions/adk_handoff_demo.mjs` already exists as the *opt-in* reference
  consumer (listed in the `adk` profile, but `enabled: false` — it does not ship
  in the default `make patch-claude-code` build). Promoting it to an
  enabled-by-default consumer is a build/security change, not a docs change: it
  composes the same tools/prompt capability surface the `daemon` profile gates,
  and enabling it blind risks a boot regression in a real patched session.
- Turning that demo into a *validated, enabled* consumer is its own scoped work
  and is tracked as the follow-up **COD-13** (intentionally not shipped in this
  run). Doing it here would pre-empt that issue and widen this change's blast
  radius past docs.
- Until COD-13 lands, the honest statement is "provisional, not yet consumed by
  an enabled-by-default patch" — which is what this change records, and it
  unblocks the §7 decision without hardening the unconsumed surface further.

**Status of the listed surfaces (until COD-13):**
- `defineHandoff` (delegate + swap) — PROVISIONAL.
- `swap` (persona overlay / `allowSwapTargets` / TOCTOU pins) — PROVISIONAL.
- `AgentRouter` — PROVISIONAL.
- `createMemory` (cross-process merge store) — PROVISIONAL.
- `useAgentBus` — PROVISIONAL.

The `tools` path (`defineAgent` + `defineTool`) is **not** provisional: it is the
one surface `adk_hello_agent` consumes in the shipped `adk` profile.

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
