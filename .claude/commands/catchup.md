---
description: Orient on the codebase, then summarize recent git activity (overview + Yesterday / Today / Blockers)
argument-hint: [days=1]
allowed-tools: Bash, Read
---

Get me back up to speed on this repo: a comprehensive orientation followed by a
standup recap. Combines `/what-is-this` (codebase overview) and `/standup`
(activity summary) in one pass.

Lookback window (days): $ARGUMENTS

## Steps

1. **Resolve the window** — parse `$ARGUMENTS` as a positive integer day count;
   if empty or invalid, default to `1`. Call it `N`, with `since="N days ago"`.

2. **Confirm a repo** — run `git rev-parse --is-inside-work-tree`. If it is not
   `true` (not a git repo, or git missing), say so and produce whatever
   orientation you can from the filesystem instead of failing. Skip the
   git-dependent parts below gracefully.

3. **Gather git once** (reuse these results for both halves — do NOT re-run):
   - State: `git status --short` and `git branch --show-current`
   - Commits: `git log --since="<since>" --pretty=format:'%h %s'`
   - Churn: `git diff --stat "@{N.days.ago}"`; if that ref does not resolve
     (shallow clone, fresh repo, detached HEAD), fall back to
     `git log --since="<since>" --shortstat --pretty=format:''`.
   - Treat any empty result as "(none in this window)" rather than an error.

4. **Orient on the codebase** (the `/what-is-this` half):
   - Structure: `ls -la`; identify monorepo layout (apps/services/packages/libs)
     and read `package.json` / `composer.json` / `pnpm-workspace.yaml` for project info.
   - Tech stack: read `Makefile` for available commands; note key indicators
     (Node/pnpm, PHP/Laravel, `docker-compose.yml`, `requirements.txt`).
   - Running services: `docker ps 2>/dev/null` (skip silently if unavailable).
   - Active work: `ls -la dev/active/ 2>/dev/null`; read `scratchpad.md` and
     `dev/README.md` if present.
   - Available commands: list `.claude/commands/`.

5. **Write the standup** (the `/standup` half) from the commits + churn gathered
   in step 3 — do not re-query git:
   - **Yesterday** — what landed (the commits in the window).
   - **Today** — the natural next steps implied by that work / open threads.
   - **Blockers** — anything stalled or uncertain; "None" if nothing stands out.

## Output

Two clearly separated sections, in this order:

### 🧭 Orientation
- **Project & Purpose** — what this codebase does
- **Architecture** — monorepo structure, main components
- **Tech Stack** — languages, frameworks, tools
- **Services / Apps** — what's available to develop
- **Current State** — current branch, uncommitted changes, what's running
- **Quick Commands** — most useful `make` targets / how to start & test
- **Active Work** — tasks from `dev/active/`

### 🗒️ Standup (last N day(s))
- **Yesterday** / **Today** / **Blockers**

Keep it tight and grounded in what the commands actually returned — no raw git
dumps, no speculation beyond the evidence. The Standup half should stay
paste-into-a-channel concise even though the Orientation half is fuller.
