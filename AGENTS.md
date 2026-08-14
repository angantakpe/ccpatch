# AGENTS.md

## Project Context

`ccpatch` is a patch framework for the Claude Code CLI. Keep changes scoped,
preserve the checked-in patch/runtime outputs, and prefer the existing scripts
and tests over ad hoc workflows.

Start with `README.md` for the project overview, `CONTRIBUTING.md` for change
expectations, and `RULES.md` for repo-specific agent behavior.

## Repo Layout

- `bin/`: CLI entrypoints.
- `core/`, `runner/`, `extensions/`, `types/`, `refmaps/`: runtime and patch
  implementation.
- `tools/`, `packages/`: workspace packages and support tooling.
- `tests/`: test coverage for patch and boot behavior.
- `scripts/`: repo checks, generators, and validation helpers.
- `scripts/context.sh`: branch, status, PR, and repo metadata snapshot for
  Codex-style sessions.
- `.codex/skills/context/SKILL.md`: repository-embedded context-gathering
  instructions.

## Local Context Workflow

- Run `bash scripts/context.sh` before asking a human for branch or PR state.
- Use `git` and `gh` directly so the context comes from the live checkout.
- When you need implementation context, combine the script output with
  `README.md`, `RULES.md`, and the relevant files under `scripts/` or `tests/`.
- If `gh` is unavailable, the script still prints the Git state needed to keep
  moving.

## Working Notes

- Keep unrelated edits intact, especially the checked-in runtime and patch
  artifacts.
- Run the smallest relevant test or lint slice for the files you changed, then
  expand only if the change touches shared behavior.
- Update the docs alongside release-visible behavior.
