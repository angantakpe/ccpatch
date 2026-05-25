# Finding anchors in the Claude Code bundle

When you're adding a new patch, 80% of the work is finding a *stable* place in
the minified bundle to splice into — one that won't shift on the next upstream
release. This is the playbook.

## What survives minification

The minifier renames identifiers and strips whitespace, but it cannot rename:

- **Quoted string literals** — telemetry event names (`tengu_*`), feature-flag
  keys, error messages, header names (`X-Claude-Code-Session-Id`), env-var
  names accessed via `process.env.FOO`.
- **DOM / API / network identifiers** — `globalThis.fetch`, `createObjectURL`,
  status codes, content types.
- **Public function shape** — function arity (param count), `await Promise.all`
  patterns, `async function*` markers.

Anchor on those. *Don't* anchor on minified function names like `Wj7` —
they're shuffled on every build. If you must reference one, capture it via a
regex against a stable nearby literal.

## The four-step workflow

### 1. Grep for stable strings

```bash
make beautify INPUT=storage/archives/claude-code-v2.1.148/cli.v2.1.148.cjs OUTPUT=cli.pretty.js
grep -n "tengu_" cli.pretty.js | head
grep -n "MAX_THINKING_TOKENS\|CLAUDE_CODE_PLAN_MODE" cli.pretty.js
```

The `tengu_*` family is Anthropic's internal feature-flag namespace. Each flag
is a string literal passed to a checker function — the function is your anchor.
For non-flag features, error messages and env-var names work equally well.

### 2. Read the window

Open the beautified file in your editor at the line `grep` returned. You want
to see ~50 lines of context: the function signature, the body, and the call
site. This is where you decide *what* to splice — a return-value override, a
boot-time IIFE, a wrapper around an existing function, etc.

### 3. Pick the right helper

```js
import {
  spliceBoot,            // inject a boot-time IIFE (debug logger, fetch hook)
  spliceAfter,           // splice after a unique string/regex anchor
  forceFeatureFlag,      // override a tengu_* flag to return true/false
  replaceFunctionByLiteral, // replace a whole function body (full control)
} from '../runner/patch-helpers.mjs';
```

If none fit, hand-roll `code.replace(anchor, ...)` — but prefer the helpers
because they throw on drift instead of silently no-opping.

### 4. Validate

```bash
node bin/scaffold-patch.mjs my_patch --kind=flag   # generate the stub
# … fill in TODOs …
node bin/patch-cli.mjs storage/archives/claude-code-v2.1.148/cli.v2.1.148.cjs /tmp/out.cjs \
  --patch my_patch --dry-run
node bin/patch-cli.mjs doctor storage/archives/claude-code-v2.1.148/cli.v2.1.148.cjs
```

`doctor` runs `probeAnchor` on every patch, including yours, and reports
`ok | drift | missing` per patch. If yours says `missing`, the candidate list
in `storage/outputs/anchor-drift.jsonl` will point at the closest matches.

## When string-anchoring isn't enough

- **Prompt text** — system-prompt strings are stable but long. Use
  `make anchor-catalog` (powered by `tools/tweakcc-anchors.mjs`) to build a
  catalogue of system-prompt hashes and detect drift across releases.
- **Multi-tier anchors** — when the obvious anchor is fragile, declare a fallback
  chain in `runner/anchors.mjs`:
  ```js
  my_anchor: {
    literal: 'stable_literal_here',
    anchors: [
      { priority: 'primary',     pattern: /VERY_SPECIFIC_REGEX/ },
      { priority: 'fallback',    pattern: /LOOSER_REGEX/ },
      { priority: 'last-resort', pattern: /JUST_THE_LITERAL/ },
    ],
  }
  ```
  `resolveAnchor(id, version, code)` returns the first matching tier with its
  priority tag, so the doctor records which one fired.
- **Refmaps** — when even regex shape changes between versions, build a refmap:
  ```bash
  make refmap VERSION=2.1.148
  ```
  This commits `refmaps/2.1.148.json` mapping anchor IDs to the resolved
  minified name + offset for that version. `resolveAnchor()` consults it
  automatically.

## Anti-patterns

- **Don't** anchor on a minified identifier (`Wj7`, `m9`). Use the stable
  literal near it.
- **Don't** anchor on whitespace or line breaks — the bundle has none.
- **Don't** anchor on an opening brace `{` alone — there are millions.
- **Don't** use `verify.present` strings that already appear in the unpatched
  bundle. The doctor will warn ("weak verify") but it won't be able to detect
  drift on your patch. Add `verify.absent` or `verify.count`.
- **Don't** silently return `code` unchanged when the anchor is missing.
  Helpers throw by default for exactly this reason. Use `{ allowMissing: true }`
  only when the patch is genuinely opportunistic.

## Reference

- `runner/patch-helpers.mjs` — the helpers themselves
- `runner/anchors.mjs` — central anchor registry, multi-tier support
- `runner/ast-anchor.mjs` — `findFunctionByLiteral` (AST-based fn lookup)
- `tools/anchor-doctor.mjs` — patch-agnostic health checker
- `tools/build-refmap.mjs` — per-version refmap generator
- `tools/tweakcc-anchors.mjs` — system-prompt anchor catalogue
- `CONTRIBUTING.md` — the patch contract & PR checklist
