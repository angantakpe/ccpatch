---
description: Standup recap, then (on your trigger) spin up a team of agents to fully execute today's tasks — implement, push, and open PRs
argument-hint: [days=1]
allowed-tools: Bash, Read, Edit, Write, Task, mcp__linear__list_my_issues, mcp__linear__list_issues, mcp__linear__get_issue, mcp__linear__list_issue_statuses, mcp__linear__list_teams, mcp__linear__get_user
---

Produce a standup, then offer to dispatch a team of agents that **fully ship**
today's tasks. This composes existing routines: the standup half is `/standup`;
the task list merges git activity with my workable Linear issues (the
`/day-start` gate); each agent composes `/plan-ticket` → `/verify-change` →
`/open-pr` (push the branch and open a GitHub PR via the `gh` CLI).

Linear access comes in two flavors — prefer whichever is wired up:
- **Linear MCP** (`mcp__linear__*`) — primary, for structured issue queries.
- **Linear CLI** (`linear`) — convenience for quick fetches and issue-linked
  branches (e.g. `linear issue <ID>`, `linear branch <ID>`). Discover exact
  subcommands with `linear --help`; fall back to MCP if the CLI is absent.

Lookback window (days): $ARGUMENTS

## Stage 1 — Standup (read-only)

1. **Resolve the window** — parse `$ARGUMENTS` as a positive integer; default `1`.
   Call it `N`, `since="N days ago"`.

2. **Gather git** in the current repo (run `git rev-parse --is-inside-work-tree`
   first; if not a repo, say so and skip git, but still fetch Linear):
   - Commits: `git log --since="<since>" --pretty=format:'%h %s'`
   - Churn: `git diff --stat "@{N.days.ago}"` (fall back to
     `git log --since="<since>" --shortstat --pretty=format:''`).

3. **Gather Linear** — `mcp__linear__list_my_issues` for issues assigned to me,
   ordered by most-recently-updated (or `linear issue list --assignee me` via the
   CLI). Apply the `/day-start` **workable-issue gate** using each issue's
   workflow state *type*: keep only what I can act on now — states of type
   `started` (**In Progress**, **In Review**) and `unstarted` (**Todo**). Drop
   types `backlog` (**Backlog**, **Triage**), `completed` (**Done**), and
   `canceled` (**Canceled**, **Duplicate**). Use `mcp__linear__list_issue_statuses`
   if you need to resolve a team's custom state names to their types.

4. **Merge into a task list** — correlate commits to issues by explicit
   identifier (`CAL-42`, `ENG-12`) or branch→identifier (`*/cal-42-…` →
   `CAL-42`, per [[feedback_branch_linear_pattern]]; Linear's per-issue copyable
   branch name follows `<initials>/<identifier>-<slug>`). The merged "Today"
   list = workable issues, annotated with whether recent commits already touched
   them (in-flight) or not (fresh).

5. **Write the standup** — **Yesterday** (commits that landed) / **Today** (the
   merged workable-issue list) / **Blockers** (stalled or uncertain; "None"
   otherwise). Keep it channel-paste tight; show the Today issues as a numbered
   list with identifier, title, state, and in-flight/fresh tag.

## Stage 2 — Trigger gate (ask the user)

Do **not** dispatch anything automatically. After printing the standup, use
**AskUserQuestion** to ask whether to launch the agent team:
- **Ship all** — one agent per Today issue (branch → implement → verify → PR).
- **Pick a subset** — let me name which issue identifiers to run.
- **Cancel** — stop here; standup only.

If the user cancels, end after the standup. Honor any subset they choose.

## Stage 3 — Dispatch the agent team (only after trigger)

Spawn **one agent per chosen issue, in parallel** (a single message with
multiple `Task` calls), each with `isolation: "worktree"` so they don't collide
in the shared tree. Give each agent this brief:

> You own issue **<IDENTIFIER>** end-to-end. Resolve the module/area from the
> issue's recent commits/branch, else ask.
> 1. Read the issue via `mcp__linear__get_issue` (or `linear issue <IDENTIFIER>`).
>    Plan it the `/plan-ticket` way: break into tasks, create the correctly-named
>    branch off the right base — use Linear's suggested branch name for the issue
>    (`<initials>/<identifier>-<slug>`, per [[feedback_branch_linear_pattern]]),
>    e.g. via `linear branch <IDENTIFIER>` when the CLI is present.
> 2. Implement the change. Match surrounding code style.
> 3. Verify like `/verify-change`: run the module's tests + lint; exercise the
>    fix/feature. Do not proceed if verification fails — report the failure.
> 4. Ship like `/open-pr`: push the branch and open a **GitHub PR** with
>    `gh pr create` against the correct base branch. Put the Linear identifier in
>    the branch name and PR title/body (e.g. a `CAL-42` line) so Linear
>    auto-links the PR to the issue.
> Return: the branch name, PR URL, test/lint result, and a one-line summary.
> Never force-push, never touch another issue's branch, never merge.

## Stage 4 — Report

Collect the agents' results into a table: **Issue · Area · Branch · PR ·
Tests · Status**. Call out any agent that stopped on a verification failure or
needed a decision — those need my attention. List the PR URLs so I can review
and merge.

## Notes
- The trigger gate in Stage 2 is the authorization for the push/PR in Stage 3 —
  agents still branch first and never commit to a default branch.
- Stage 1 is always safe to run; Stage 3 mutates repos and opens PRs, so it only
  runs on an explicit trigger.
- PRs are opened with the GitHub `gh` CLI; ensure `gh auth status` is healthy
  before a Ship run (agents will surface an auth failure rather than guess).
- Prefer the Linear MCP for structured reads; use the `linear` CLI for branch
  creation and quick lookups. Respect repo rules and memory
  ([[feedback_branch_linear_pattern]]).
