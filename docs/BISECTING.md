# Bisecting a broken patched CLI — patches, or runtime adaptation?

Audience: you have a patched `cli.v<ver>.patched.mjs` that hangs, crashes, or
exits weird under Node, and you need to know **which layer** broke:

- **the patch list** — one of the ~28 behavior patches regressed, or two of
  them conflict; or
- **the runtime-adaptation layer** — the machinery that makes a Bun-built,
  SEA-embedded bundle run under Node at all (shims in `runner/shims/`,
  the repack/extraction pipeline, Bun→Node API divergence). Patch bisection
  can never isolate this layer, because every build needs it.

The tool for the second question is the **`bare` profile**: the smallest set
of patches under which the extracted bundle executes under Node — and
*nothing else*. It contains exactly `react_singleton`, `esm_compat`,
`bun_shim` (one-line justification for each in the `profiles:` block of
`ccpatch.yml`). Crucially, profile selection does **not** auto-include
`required: true` patches, so a bare build really applies 3 patches — the
build prints a loud `⚠⚠ … REQUIRED INFRA SKIPPED` line to remind you that
contracts/fetch_interceptor/overlay_loader are absent and any
subscriber/hook-based patch would silently no-op in this build.

Throughout, `$BUNDLE` is the extracted upstream bundle (e.g.
`storage/archives/claude-code-v<ver>/cli.v<ver>.cjs`) and `$VER` the Claude
Code version.

---

## Step 0 — Reproduce with the standard build, collect what's already there

Rebuild and re-run exactly what's broken:

```sh
node bin/patch-cli.mjs $BUNDLE releases/$VER/cli.v$VER.patched.mjs \
  --profile standard --allow-unacked --version $VER
node releases/$VER/cli.v$VER.patched.mjs --version    # then the failing invocation
```

Before reaching for tools, read what the build and runtime already wrote:

- **Build log**: any `[!] anchor not found`, drift, `skipped`, or
  `verify` warnings? A patch that half-applied is a patch-layer suspect.
- **`storage/diagnostics/`**: `patch-lifecycle.jsonl` records hook fires per
  patch; an enabled patch with zero entries during the repro is either
  no-oping (missing infra?) or never reached.
- **Boot watchdog / boot diagnostics output, if present** in your build: note
  the last marker emitted before the hang — it brackets where boot stopped.
- How much output before silence? A few hundred bytes (banner then nothing)
  is the classic interactive-boot deadlock shape — see Step 3.

## Step 1 — The bare build: split the two layers

```sh
node bin/patch-cli.mjs $BUNDLE releases/$VER/bare.mjs \
  --profile bare --allow-unacked --version $VER
node releases/$VER/bare.mjs --version          # must print the version, exit 0
node releases/$VER/bare.mjs <failing args>     # the actual repro
```

Run it from a directory where Node can resolve the host `react`/`ink`
(anywhere under the ccpatch checkout works — `esm_compat` preloads them from
`node_modules`).

**Bare build is still broken → runtime-adaptation layer.** No amount of
patch bisection will help; you're in shims/repack/extraction territory.
Known classes, with one-line signatures:

| Class | Signature |
| --- | --- |
| Bun API divergence | `ReferenceError: Bun is not defined`, or a `Bun.*` polyfill behaving differently under Node (e.g. `--help` dies in `Bun.stringWidth` without `bun_shim`) |
| Bun-only fullscreen TUI path | banner prints, then silence — a code path that only Bun's terminal handling can drive deadlocks under Node awaiting events that never arrive |
| SEA-embedded modules not extracted | `Cannot find module 'ws'` (or similar) at require time — the module lives inside the Bun single-executable, not next to the extracted bundle |
| ESM/CJS wrapper breakage | throw at module scope before any output (`module`/`require` undefined in `.mjs`) — `esm_compat` missing or drifted |
| React duality | `Invalid hook call` / reconciler errors on first interactive render — bundled React not unified with the host copy (`react_singleton` drifted) |
| Terminal-query deadlock | boot blocks awaiting DA1/OSC11/XTVERSION replies that a non-answering pipe never sends — see Step 3 |

**Bare build works → bisect the patch list** (Step 2).

## Step 2 — Patch bisection recipe

Bisect the *standard* list by halves with explicit `--patch` lists. Two
things to know first:

1. **Required-infra auto-include.** A plain `--patch a,b,c` build silently
   adds every `required: true` patch (`[config] auto-including N required
   patch(es): …` in the log) — your floor is ~8 patches, and the required
   infra itself is unbisectable. Pass **`--no-required`** to suppress it;
   you then own the exact list, and the build prints the loud `⚠⚠` warning.
   Keep the three bare patches in every list so the build still boots.
2. **`dependsOn` pulls are NOT automatic.** If a listed patch declares
   `dependsOn` on something you dropped, the build fails loudly
   (`Patch "X" requires "Y", but "Y" is not enabled`) — add the dependency
   back to that half (e.g. `tool_result_error_content` →
   `fetch_interceptor`, `coverage_kernel` → `contracts`). A failing half
   that *needs* a required patch is itself a data point.

Concrete halving of the standard profile (28 patches; first half = the
`minimal` profile, second half = the QoL set):

```sh
# Half A: minimal-ish (infra + bug fixes)
node bin/patch-cli.mjs $BUNDLE releases/$VER/halfA.mjs --no-required --allow-unacked --version $VER \
  --patch react_singleton,esm_compat,bun_shim,contracts,overlay_loader,fetch_interceptor,stdin_da1_leak,message_normalizer,project_root,tool_result_error_content,boot_banner,subagent_hooks_stub

# Half B: bare floor + the QoL patches
node bin/patch-cli.mjs $BUNDLE releases/$VER/halfB.mjs --no-required --allow-unacked --version $VER \
  --patch react_singleton,esm_compat,bun_shim,model,custom_commands,slash_dispatch,context_budget_warn,recap_strip_hint,suppress_npm_deprecation,unhide_features,extended_thinking,force_thinking,tool_result_trim,large_content_guard,hook_noise_mute,mcp_lazy,dotenv_loader,block_tools,input_bar_color
```

Run the repro against each half; recurse into the broken half, halving the
suffix while keeping the bare floor prefix. `ccpatch explain --patch …
--no-required` previews any list without building. log2(28) ≈ 5 builds to a
single suspect; confirm with bare + that one patch:

```sh
node bin/patch-cli.mjs $BUNDLE releases/$VER/suspect.mjs --no-required --allow-unacked --version $VER \
  --patch react_singleton,esm_compat,bun_shim,<suspect>
```

Caveat: hook/subscriber patches need their infra to *do* anything, so a
`--no-required` build can mask a bug that only fires when (say)
`fetch_interceptor` delivers events. If the suspect patch declares one of
the required patches in its plumbing, re-test it *without* `--no-required`
(suspect + auto-included infra) before concluding.

## Step 3 — Interactive hangs: probe with a pty that answers back

`--version`/`--print` style repros run fine in a pipe, but **interactive
boot blocks on terminal handshakes**. At startup the CLI writes queries —
DA1 (`\x1b[c`), OSC 11 (background color), XTVERSION — and awaits replies.
A plain `spawn()` with pipes never answers, so boot deadlocks *by design*,
and you'll chase a phantom bug. Two hard rules:

1. **The probe must answer terminal queries.** At minimum reply to DA1
   `\x1b[c` with `\x1b[?62;4c`; also answer OSC11 and XTVERSION if queried.
2. **Run in a TRUSTED directory.** The folder-trust dialog renders *before*
   the deadlock-prone boot code; in an untrusted dir every probe stops at
   the dialog and masks the real bug. Pre-trust the directory (or point
   `$CLAUDE_CONFIG_DIR` at a config that trusts it) before timing anything.

See `tests/boot-tty.test.mjs` and `tests/helpers/pty-boot-probe.py` (added
alongside this document; if they're not in your checkout yet, they land on a
parallel branch) for a working probe: a Python pty harness that spawns the
patched CLI on a real pty, answers the handshake, and asserts the REPL
paints. `tests/boot-smoke.test.mjs` is the non-interactive little sibling
(`--version` exit-0 check).

## Worked example — the v2.1.175 boot deadlock (2h incident)

Symptom: standard patched build under Node printed the boot banner and then
went silent — ~900 bytes of output, no prompt, no exit. An `strace` showed a
polling loop around `wslpath`, which burned an hour as a red herring (it was
just the idle environment-probe loop ticking while boot was blocked).

Bisection stalled exactly as Step 2 predicts *without* `--no-required`: the
required patches were auto-included into every half, so the minimum
buildable set stayed ~7–8 patches and the failing layer never narrowed. A
bare-equivalent build (Step 1) still hung → runtime adaptation, not patches.

It turned out to be **two stacked causes**, which is why each fix alone
"didn't work":

1. **Bun-only fullscreen TUI path deadlocking under Node** — boot took a
   fullscreen-terminal branch only Bun's terminal plumbing can complete;
   under Node it awaited an event that never fires (the banner-then-silence
   signature above).
2. **`require('ws')` failure from un-extracted SEA-embedded modules** —
   once the TUI path was fixed, boot died loading `ws`, which the Bun
   single-executable embeds but the extraction step hadn't laid down next
   to the bundle.

With this document's workflow the same incident is four commands: Step 0
(reproduce, note ~900-byte banner-then-silence), Step 1 (bare build still
hangs → adaptation layer, consult the signature table: rows 2 and 3 match),
Step 3 (pty probe in a trusted dir localizes the blocked handshake), fix,
re-run, find cause #2 the same way.
