---
name: add-cli-hook
description: Author a ccpatch patch that adds a new hook into Claude Code's cli.js (or a patched cli.js) hook engine — inject a callback hook, intercept an existing hook event, or add a new event. Use when asked to "add a hook", "intercept PreToolUse/PostToolUse in the bundle", "patch the hook engine", or wire behavior into tool execution from inside the CLI process.
---

# Add a hook into cli.js via ccpatch

ccpatch never edits Anthropic source — it transforms the installed `cli.js`
bundle (anchor → transform → verify). "Adding a hook" means authoring a patch
under `extensions/` (or `core/`) that injects into the bundle's hook engine.

## Step 0 — pick the cheapest route that works

1. **No patch needed?** If the behavior is reachable with a normal
   settings-level hook (`PreToolUse`/`PostToolUse`/… command hook in
   `settings.json`), STOP — tell the user to configure it; don't patch.
2. **Callback hook injection (default patch route).** The engine natively
   supports in-process `callback`-type hooks. A patch that registers one gets
   full JS access to the hook input without spawning a process.
3. **New hook event (rare, expensive).** Requires touching the event list,
   config merge, dispatch table, and a call site. Only when 1–2 can't work.

## The hook engine map (verified on v2.1.170; minified names rotate per release)

| Piece | v2.1.170 name | Stable anchor literal to find it |
|---|---|---|
| Event name list | `dy=[...]` | `"PreToolUse","PostToolUse","PostToolUseFailure"` (array head) |
| Config merge (settings+plugins+skills → `{event:{matcher:[hooks]}}`) | `p19` | the same event-map object literal `{PreToolUse:{},PostToolUse:{}` |
| Per-event dispatch table | `Usf={PreToolUse:...}` | `executePreToolHooks called for tool:` (inside the PreToolUse wrapper, defined adjacent) |
| Central runner (matching, concurrency, timeouts, progress msgs) | `aP({hookInput,...})` | `hook execution - workspace trust not accepted` |
| Matcher resolution | `JMq` | `Getting matching hook commands for` |
| Matcher semantics (`*`, `a\|b`, regex) | `dsf` | `Invalid regex pattern in hook matcher:` |
| Command spawner (env, shell, exit codes) | `oU8` | `prompt-type hooks are not supported for` (in caller); `but no PowerShell executable` (in body) |

Semantics to preserve: exit code 2 → `outcome:"blocking"` with stderr as
`blockingError`; exit 0 + JSON stdout → parsed (`permissionDecision`,
`hookSpecificOutput`, `updatedInput`); other codes → `non_blocking_error`.
Hook types the runner accepts: `command`, `prompt`, `agent`, `http`,
`mcp_tool`, `callback`, `function`.

**Never anchor on the minified names above** — anchor on the string literals.
If an anchor is version-sensitive, register it in `runner/anchors.mjs` and
resolve with `findFunctionByLiteral` (see `docs/anchors.md`).

## Workflow

1. **Scaffold:** `make new-patch NAME=<hook_name> KIND=prefix` (or
   `KIND=free|postfix|transpiler|splice|flag`, `CATEGORY=core` for core/).
   This emits a manifest-valid stub and wires a fixture into
   `tests/fixtures/registry.mjs`.
2. **Reconstruct & read the target bundle:**
   `make reconstruct VERSION=<x.y.z>` → beautified tree under
   `storage/outputs/reconstructed-v<x.y.z>/`. Confirm your anchor literal is
   unique (`grep -c`), and present in BOTH the pristine and any already-patched
   bundle you target (`releases/<v>/cli.v<v>.patched.mjs`).
3. **Write the patch.** Contract (see `docs/authoring-patches.md`):
   - idempotent `apply(code)` guarded by a sentinel like `__ccpMyHook_v1`
   - required `verify` block — prefer `count:` over bare `present:`
     (`present`-only is reported UNVERIFIED by `doctor`)
   - real logic goes in a shim `.mjs`; the patch injects a thin wrapper
     (shims-as-patches — see `extensions/hook_noise_mute.mjs` as the model)
4. **Register** in `ccpatch.yml` (`enabled: false` default for extensions;
   long form with `env: [CC_...]` if it reads env vars).
5. **Test:** add a case to `tests/patch-verification.test.mjs`, then
   `make test-patches`.
6. **Dry-run one patch** (the scaffolder prints the exact command), then
   apply: `make patch-claude-code` and health-check: `make doctor`.

## Injection recipes

**A. Observe/veto a tool call (intercept PreToolUse):** `kind: 'prefix'` on the
PreToolUse wrapper — target `{ function: { literal: 'executePreToolHooks called for tool:' } }`,
inject code reading the wrapper's tool-name/input args (resolve positions at
patch time from the reconstructed source, not hardcoded letters).

**B. Add a synthetic callback hook for an existing event:** patch the config
merge (target the `{PreToolUse:{},PostToolUse:{}` object literal) to append
`{matcher:"", hooks:[{type:"callback", callback: globalThis.__ccpMyHookCb}]}`
to the desired event bucket, and have your boot-time shim define
`globalThis.__ccpMyHookCb`. Callback hooks bypass spawn entirely.

**C. New hook event:** extend the `dy` array, add the event key to the merge
map in `p19`, add a wrapper to the `Usf` dispatch table, and inject a call
site that invokes it. Each is a separate small anchor — keep them as one patch
with `verify.count` asserting all injection sentinels.

## Pitfalls

- Re-running apply must be a no-op — sentinel-guard every replace.
- `apply()` may run on an already-patched bundle (`cli-patched.js` /
  `releases/*.patched.mjs`); your anchor must still match or fail loudly via
  `console.warn` + return `code` unchanged.
- Don't mix a declarative `kind` with a custom `apply` — manifest error.
- Native-binary targets: plain-JS path patches fine; growth on PE/fat Mach-O
  fails closed (see README "Native binary repack").
- Respect `.claude/rules/hook-patches.md` in this repo — it is the gate for
  these edits.
