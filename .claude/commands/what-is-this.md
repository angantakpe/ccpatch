---
description: Get comprehensive overview of codebase structure and status
tags: [overview, context, onboarding, prime]
---

Provide comprehensive codebase overview:

1. **Project Structure Analysis**
   - List main directories: `ls -la`
   - Identify monorepo structure (apps/services/packages/libs)
   - Read package.json or composer.json for project info
   - Check for workspace configuration

2. **Technology Stack**
   - Read Makefile to understand available commands
   - Check for key tech indicators:
     - package.json/pnpm-workspace.yaml (Node/pnpm)
     - composer.json (PHP/Laravel)
     - docker-compose.yml (Docker services)
     - requirements.txt (Python)
   - List main services/applications

3. **Current Status**
   - Git status: `git status`
   - Current branch: `git branch --show-current`
   - Running containers (if any): `docker ps 2>/dev/null` or check Makefile
   - Active dev docs: `ls -la dev/active/ 2>/dev/null`
   - Recent commits: `git log --oneline -5 2>/dev/null`

4. **Development Context**
   - Read scratchpad.md if exists
   - Check dev/README.md for patterns
   - List available make targets: `make help` or parse Makefile

5. **Quick Start Guide**
   - Common development commands
   - How to start services
   - How to run tests
   - Available slash commands in .claude/commands/

Present summary report with:
- **Project Name & Purpose**: What this codebase does
- **Architecture**: Monorepo structure, main components
- **Tech Stack**: Languages, frameworks, tools
- **Services/Apps**: What's available to develop
- **Current State**: What's running, what's in progress
- **Quick Commands**: Most useful make targets
- **Active Work**: Tasks from dev/active/
- **Next Steps**: How to get started or resume work
