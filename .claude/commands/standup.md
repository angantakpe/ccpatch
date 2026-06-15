---
description: Summarize recent git activity into a daily standup update (Yesterday / Today / Blockers)
argument-hint: [days=1]
allowed-tools: Bash, Read
---

Write a daily standup update from recent git activity.

Lookback window (days): $ARGUMENTS

## Steps

1. **Resolve the window** — parse `$ARGUMENTS` as a positive integer day count;
   if empty or invalid, default to `1`. Call it `N`, with `since="N days ago"`.

2. **Confirm a repo** — run `git rev-parse --is-inside-work-tree`. If it is not
   `true` (not a git repo, or git missing), say so and write the standup from
   whatever context is available instead of failing.

3. **Gather activity** — in the current working directory:
   - Commits: `git log --since="<since>" --pretty=format:'%h %s'`
   - Churn: `git diff --stat "@{N.days.ago}"`; if that ref does not resolve
     (shallow clone, fresh repo, detached HEAD), fall back to
     `git log --since="<since>" --shortstat --pretty=format:''`.
   - Treat any empty result as "(no commits in this window)" /
     "(no diff stats available)" rather than an error.

4. **Write the standup** — a concise update with three sections, a few bullets
   each, grounded in the commits and churn above:
   - **Yesterday** — what landed (the commits in the window).
   - **Today** — the natural next steps implied by that work / open threads.
   - **Blockers** — anything stalled or uncertain; "None" if nothing stands out.

## Output

The standup update only — no preamble, no raw git dumps. Keep it tight enough to
paste into a chat channel.
