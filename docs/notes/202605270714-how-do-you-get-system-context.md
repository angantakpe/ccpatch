 System context arrives through a few distinct channels, all assembled
  by the harness before I see your message:

1. Static prompt prefix (every turn)

- My base system prompt: identity, tone rules, tool-use guidance,
  safety policies.
- Environment block: cwd, OS, shell, git branch/status snapshot, model
  ID, knowledge cutoff.
  by the harness before I see your message:

1. Static prompt prefix (every turn)

- My base system prompt: identity, tone rules, tool-use guidance,
  safety policies.
- Environment block: cwd, OS, shell, git branch/status snapshot, model
  by the harness before I see your message:

1. Static prompt prefix (every turn)

- My base system prompt: identity, tone rules, tool-use guidance,
  safety policies.
- Environment block: cwd, OS, shell, git branch/status snapshot, model
  ID, knowledge cutoff.
- Tool schemas: JSON definitions for the built-in tools loaded
  upfront.

2. Injected files

- CLAUDE.md files are concatenated in: user-global
  (~/.claude/CLAUDE.md), then project-local. @path references inside
  them pull in more files (that's how your RTK.md got included).
- MEMORY.md index is loaded so I know what persistent memories exist
  (individual memory files are read on demand).

3. System reminders
   Tagged `<system-reminder>` blocks the harness injects mid-conversation —
   e.g. the deferred-tool list, available skills, MCP server
   instructions, date changes, file-state warnings. They look like user
   messages but originate from the harness.
4. Tool results
   Once I call a tool (Read, Bash, Grep…), its output flows back as a new
   message. That's how I learn anything beyond the initial prefix — file
   contents, command output, web fetches, subagent reports.
5. Deferred / on-demand

- ToolSearch fetches schemas for MCP and extra tools only when needed
  (keeps the prefix small).
- Memory files are read via Read when relevant.
- Skills inject their instructions only when invoked via /name.

6. Auto-compression
   When the context window fills, the harness summarizes older turns and
   replaces them with a synopsis — I keep working without hitting a hard
   limit, but fine detail from early in the conversation may be lossy.

  So: a fixed prefix + injected docs + streaming tool results +
  on-demand fetches, all stitched into one growing message list each
  turn.
