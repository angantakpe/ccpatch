# Context

Use this skill when you need live repository context without asking a human to
paste branch, PR, or status output into chat.

## Workflow

1. Run `bash scripts/context.sh` from the repo root.
2. Inspect `AGENTS.md`, `CLAUDE.md`, `RULES.md`, `README.md`, and
   `CONTRIBUTING.md` for the current workflow and checks.
3. Use the `gh` output to confirm branch, PR, and remote state before making
   changes.
4. If `gh` is unavailable, continue with the Git output rather than stopping
   for manual copy-paste.

## Good Fits

- Repo inspection before a change.
- Syncing branch or PR context after a checkout switch.
- Verifying whether the current worktree matches the open PR.
