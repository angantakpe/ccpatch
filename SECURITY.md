# Security policy

## Trust boundary

ccpatch transforms a copy of Anthropic's Claude Code CLI that is already
installed on your machine. The patched bundle runs **in-process** with the
same privileges as the original CLI: it can read your filesystem, call the
Anthropic API with your credentials, and spawn subprocesses.

There is no sandbox between a patch and the rest of the CLI. Treat any
enabled patch with the same trust you give the CLI itself.

- The patcher itself (`bin/`, `runner/`, `tools/`, `core/`, `extensions/`)
  makes no network calls, ships no telemetry, and has no auto-update path.
- ccpatch ships **no Anthropic source code**.
- Third-party patches installed under `modules/` are not vetted by this
  project. Read them before enabling.

See [THREAT_MODEL.md](./THREAT_MODEL.md) for per-patch capability detail.

## Supported versions

Security fixes target `main`. We attempt patch compatibility with the last
three published upstream Claude Code versions (see
[SUPPORTED_VERSIONS.md](./SUPPORTED_VERSIONS.md)); older versions are
best-effort.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security reports.

Email: **hello@codehornets.com** (or open a private GitHub Security
Advisory at <https://github.com/codehornets/ccpatch/security/advisories/new>).

Include:

- A description of the issue and its impact.
- Steps to reproduce, ideally with a minimal `ccpatch.yml` and the upstream
  Claude Code version (`claude --version`).
- The sha256 of the input bundle (`shasum -a 256 <cli.js>`).
- Any proof-of-concept code or logs.

We aim to:

- Acknowledge receipt within **3 business days**.
- Provide an initial assessment within **10 business days**.
- Release a fix or mitigation within **90 days** of confirmation, or sooner
  if the issue is being actively exploited.

We will credit reporters in the release notes unless you ask otherwise.

## In scope

- A patch that exfiltrates data, opens unsolicited network connections, or
  writes outside its declared paths.
- A patch whose declared `capabilities` understates what it actually does.
  Declared capabilities are self-reported; `scripts/lint-capabilities.mjs` is a
  best-effort source-text heuristic, not a guarantee — see
  [THREAT_MODEL.md](./THREAT_MODEL.md#capability-honesty-heuristic-not-a-guarantee).
- An anchor transform that corrupts the bundle in a way the runner's
  `verify` step fails to catch.
- A bypass of `--strict` capability acknowledgement.
- Privilege escalation through the patched bundle that the unpatched CLI
  does not already permit.

## Out of scope

- Vulnerabilities in upstream Claude Code itself — report those to
  Anthropic at <https://www.anthropic.com/security>.
- Issues that require a user to install an untrusted third-party patch
  from `modules/` (those are explicitly user-installed-at-their-own-risk).
- Anchor drift after a new Claude Code release (this is a maintenance
  signal, not a vulnerability — see the `drift-check` workflow).
