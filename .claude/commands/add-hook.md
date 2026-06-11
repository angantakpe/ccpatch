---
description: Author, register, test, and verify a ccpatch patch that adds a new hook into cli.js / cli-patched.js
argument-hint: <hook_name> [event=PreToolUse|PostToolUse|Stop|...] [matcher=ToolName] [version=x.y.z] [what it should do]
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, Task
---

Add a new hook into Claude Code's cli.js bundle via a ccpatch patch.

Request: $ARGUMENTS

Follow `.claude/skills/add-cli-hook/SKILL.md` and obey every rule in
`.claude/rules/hook-patches.md`. Prefer delegating the implementation to the
`hook-patch-engineer` agent; do the qualification step yourself first.

## Steps

1. **Qualify** — if `$ARGUMENTS` describes behavior achievable with a plain
   settings.json hook (command hook on an existing event), say so, show the
   settings snippet, and STOP. Patch only when in-process access is required
   (callback hook, new event, engine interception).

2. **Resolve the target version** — from `version=` in the arguments, else
   auto-detect: `claude --version` (the Makefile does the same). Confirm which
   bundle is being patched (pristine `cli.js` vs an existing
   `releases/<v>/cli.v<v>.patched.mjs`).

3. **Scaffold** — derive a snake_case patch name from the arguments:
   `make new-patch NAME=<hook_name> KIND=prefix` (pick `free` only for
   cross-cutting changes; `CATEGORY=core` only if the patch must default-on).

4. **Find anchors** — `make reconstruct VERSION=<v>`, then grep
   `storage/outputs/reconstructed-v<v>/` for stable literals near the hook
   engine (start from the table in the skill). Each anchor must be unique
   (`grep -c` = 1) in both pristine and patched bundles. Never anchor on
   minified identifiers.

5. **Implement** — sentinel-guarded idempotent transform; real logic in a shim
   (`extensions/hook_noise_mute.mjs` is the model); injected runtime code
   try/catch-wrapped, fail-open. Default injection vehicle: a `callback`-type
   hook appended to the requested event/matcher bucket in the config-merge
   map.

6. **Register** — add the patch to `ccpatch.yml` (`enabled: false` for
   extensions; long form with `env:` if it reads env vars).

7. **Test** — add a case to `tests/patch-verification.test.mjs`; run
   `make test-patches` and the single-patch dry-run the scaffolder printed.
   Both must pass before applying.

8. **Apply + doctor** — `make patch-claude-code` then `make doctor`; if doctor
   reports the new patch UNVERIFIED, strengthen `verify` (use `count:`) and
   re-apply.

## Output

Report: patch path, anchor literal(s) + uniqueness proof, the ccpatch.yml
entry, test results, doctor status, and how to enable/disable the hook
(`ccpatch.yml` flag + any `CC_*` env var). If an anchor is missing in the
target version, stop and report the drift candidates instead of forcing a
match.
