---
description: EagleView recap — kanban (cols=status, rows=priority) of everything I touched, with a today→5y time selector, rendered to a navigable HTML file
argument-hint: "[max range: today|3days|7days|2weeks|1month|1quarter|6months|1year|5years] (default 1month)"
allowed-tools: Bash(git:*), Bash(basename:*), Bash(find:*), Bash(cat:*), Bash(jq:*), Bash(date:*), Read, Write, mcp__youtrack__get_current_user, mcp__youtrack__search_issues, mcp__youtrack__get_issue, mcp__claude_ai_Gmail__search_threads, mcp__claude_ai_Google_Calendar__list_events
tags: [routine, recap, dashboard]
---

You are the **EagleView recap builder**. Gather everything the user touched across all reachable sources, correlate it onto their YouTrack tickets, and emit a self-contained navigable HTML board.

This composes the existing routines rather than duplicating them: the YouTrack fetch is the **`/day-start`** query (stage 3), widened. The git-activity scan is the **`/day-end`** "take stock" logic, run across all modules. There is no `/recap` command — this *is* it.

## Window
`$ARGUMENTS` sets the **fetch ceiling** (how far back to pull the heavy sources). Default **1month**. Cheap sources (YouTrack, git) always fetch the full ceiling; if the user passes `5years`, honor it. Convert the keyword to a day count and a `since` date via `date -d`.

## Stage 1 — YouTrack core (the grid)
- `mcp__youtrack__get_current_user` to resolve me.
- `mcp__youtrack__search_issues` — `for: me updated: {ceiling-start} .. Today order by: updated desc`, limit ~80, `customFieldsToReturn: ["Status","Assignee","Priority"]`. ⚠️ In the **Intra** project the state field is **`Status`**, not `State`.
- These become the kanban cards. Unlike `/day-start`, **do not** apply the workable-ticket gate here — a recap shows everything I touched, including `New` and Resolved. Keep the real `Status` and `Priority` values; map an empty priority to `"No priority"`.
- Note the YouTrack base URL from the issue URLs so each card links out.

## Stage 2 — source adapters (each degrades gracefully; a missing source must NOT abort the build)
Pull each over the ceiling window, normalize to `{ source, ts(epochMs), title, url?, ticketKey? }`, then correlate to a ticket by **explicit key** (`INTRA-33`, `PROC-12` — match the project-prefix+digits pattern anywhere in the text) or, for git, by **branch→key** (`intra33-...` → `INTRA-33`, per [[feedback_branch_youtrack_pattern]]). Anything with no resolvable key → **ambient**.

- **git** (`source:"git"`): for each module under `~/workspace/effenco/modules/*` (and the repo root), run `git -C <m> log --author="<my git email>" --since="<since>" --pretty=format:'%H%x09%ct%x09%s%x09%D' --all`. Each commit → activity item; title = subject, ts = committer epoch, ticketKey from the subject or the ref/branch. Skip modules with no matches silently. This is the same "take stock" idea as `/day-end` but fleet-wide.
- **email** (`source:"email"`): `mcp__claude_ai_Gmail__search_threads` over `newer_than:<Nd>`. For each thread, ts = last message, title = subject, url = the thread permalink. Correlate by any ticket key in the subject/snippet; else ambient. Keep it to the most recent ~40.
- **calendar** (`source:"calendar"`): `mcp__claude_ai_Google_Calendar__list_events` between since and now. title = event summary, ts = start, url = htmlLink. Correlate by key in the title/description; else ambient (most meetings will be ambient — that's fine, it shows the week's shape).
- **journal** (`source:"journal"`): read `~/.vibe-log/analyzed-prompts/*.json` (AI summaries of my coding sessions). Use `find ~/.vibe-log/analyzed-prompts -name '*.json' -newermt "<since>"` then `cat`/`jq` the summary + timestamp. title = the session summary line, ts = its time. Correlate by key if the summary mentions one; else ambient.
- **teams** (`source:"teams"`): set `sources.teams=false` and skip — `~/browser-use-teams` is not wired in this environment. Leave the adapter documented so it can be turned on later (see [[reference_teams_browser_use]]).

Be resilient: wrap each adapter so an error/empty result just omits that source and flips its `sources.<name>` flag to false. Report at the end which sources contributed and which were empty/unavailable.

## Stage 3 — assemble the data object
Build exactly this shape (epoch **milliseconds**):
```json
{
  "generatedAt": "<ISO now>",
  "me": "<my name>",
  "fetchCeilingDays": <N>,
  "statuses":  ["<status order, left→right — e.g. Open, In Progress, In Review, Done, Resolved>"],
  "priorities":["Critical","Major","Normal","Minor","No priority"],
  "sources": { "youtrack": true, "git": <bool>, "email": <bool>, "calendar": <bool>, "journal": <bool>, "teams": false },
  "tickets": [{ "key","summary","status","priority","updated":<ms>,"url",
                "activity":[{ "source","ts":<ms>,"title","url" }] }],
  "ambient": [{ "source","ts":<ms>,"title","url" }]
}
```
Derive `statuses` from the actual statuses present, ordered logically (backlog → in-progress → review → done/resolved). A ticket's `updated` drives which time-bucket it falls in; its `activity[]` adds the cross-source events that surface as card badges.

## Stage 4 — render & open
- Read `.claude/recap/template.html`. Replace the literal token `__RECAP_DATA__` with `<script>window.RECAP_DATA = <the JSON>;</script>`.
- Write the result to `.claude/recap/eagleview-<YYYY-MM-DD>.html` (overwrite same-day).
- Print the absolute path and tell the user to open it (offer to `SendUserFile` it). The HTML itself owns the today→5y EagleView buttons and ←/→ navigation — all time-range switching happens client-side from the single embedded dataset, so they navigate without re-running.
- Close with a 3-line text summary: tickets tracked, total correlated events, and which sources were live vs unavailable.

## Notes
- Never push, comment, or mutate anything — this is **read-only reporting**.
- Respect repo rules and memory ([[feedback_branch_youtrack_pattern]], [[reference_intranet_environments]]).
- If a source is slow (email/calendar over a long ceiling), cap counts and say so rather than hanging.
