# @codehornets/ccpatch-gateway

An external messaging-channel gateway for a ccpatch-patched Claude Code CLI.
It connects to a running session over the `headless_bridge` NDJSON socket and
lets channel adapters (Telegram today; Discord/Slack/stdio can follow the same
contract) drive that session and stream its events back out.

## Why this exists, and what it doesn't reinvent

Claude Code itself has no gateway — no standing daemon, no channel adapters.
Other agent projects do (OpenClaw's `Gateway`, Hermes Agent's `gateway/`
module — see `workspace/projects/openclaw` and `workspace/projects/handyman`
in this workspace). Neither was directly reusable here: Hermes Agent's
gateway is Python and deeply coupled to its own session/turn model; OpenClaw's
Telegram integration is ~500 files deep and coupled to OpenClaw's own
plugin/account/pairing system. Copying either wholesale would mean adopting a
different agent runtime, not gatewaying this one.

What *is* reused:

- **The wire protocol and transport** — `extensions/headless_bridge.mjs`
  already implements the NDJSON socket protocol (`hello`/`submit`/`dispatch`/
  `subscribe`/`cancel`/`bye`) on top of `expose_submit_input` +
  `expose_tool_dispatch`. `bridge-client.mjs` in this package is a
  generalization of the request/response handling already proven in
  `tools/ccpatch-bridge.mjs` (the one-shot CLI client) — same protocol
  handling, restructured to be long-lived so a gateway can hold one
  connection open across many submits and many adapters.
- **The test fixture** — `tests/bridge-client.test.mjs` drives
  `tests/bridge_host.mjs` (the repo's existing headless_bridge test double),
  the same way `tests/smoke_bridge.mjs` does, instead of standing up a second
  fake server.
- **The Telegram transport** — `adapters/telegram.mjs` uses
  [grammy](https://grammy.dev) (MIT), the same library OpenClaw's own
  Telegram channel is built on. Long polling, update parsing, and replies are
  grammy's job; this adapter only translates between Telegram messages and
  bridge `submit`/event frames.

## Layout

```
bridge-client.mjs      reusable, long-lived NDJSON client (connect/submit/dispatch/subscribe/cancel/close)
adapter.mjs             the ChannelAdapter contract every adapter implements
adapters/telegram.mjs   Telegram adapter (grammy-based)
config.mjs              env -> config
run.mjs                 CLI entrypoint: connect + start configured adapters
tests/                  node:test suite
```

## Running it

1. Apply the `headless_bridge` patch (it ships `enabled: false` by default —
   see `ccpatch.yml`) and start the patched CLI with:
   ```
   CC_BRIDGE_ADDR=unix:/run/ccpatch.sock
   CC_BRIDGE_TOKEN=<shared secret>
   CC_BRIDGE_TOOL_ALLOWLIST=Read,Grep   # or unset to deny all tool dispatch (default-deny)
   ```
2. Install this package's deps (grammy is optional — only needed if you start
   the telegram adapter):
   ```
   cd packages/gateway
   npm install
   ```
3. Run the gateway against the same bridge address/token:
   ```
   CC_BRIDGE_ADDR=unix:/run/ccpatch.sock \
   CC_BRIDGE_TOKEN=<shared secret> \
   TELEGRAM_BOT_TOKEN=<from @BotFather> \
   TELEGRAM_ALLOWED_CHAT_IDS=<your chat id>  \
   node run.mjs
   ```
   `GATEWAY_ADAPTERS` (default `telegram`) picks which adapters to start,
   comma-separated.

## Security posture

Both layers are **default-deny**, deliberately matching `headless_bridge`'s
own `CC_BRIDGE_TOOL_ALLOWLIST` convention (see THREAT_MODEL.md at the repo
root):

- `headless_bridge` itself denies all `dispatch` ops unless
  `CC_BRIDGE_TOOL_ALLOWLIST` is set.
- `TELEGRAM_ALLOWED_CHAT_IDS` denies every chat unless explicitly listed (or
  set to `*` to allow all, which is an explicit opt-in, not the default).

A message from an allowed chat reaches the session via `bridge.submit()`,
i.e. as a normal turn — it does not get direct tool-dispatch access unless
you also configure `CC_BRIDGE_TOOL_ALLOWLIST` on the CLI side.

## Adding another channel adapter

Implement `{ name, start({ bridge, log }), stop() }` (see `adapter.mjs`) and
register it in `run.mjs`'s `ADAPTER_FACTORIES`. `bridge` is an already
`connect()`-ed `BridgeClient` — call `.submit()`/`.dispatch()` and listen for
`.on('event', (topic, payload) => …)` or `.on('<topic>', payload => …)` (e.g.
`assistant.text`) to stream output back to the channel as it arrives instead
of waiting for the full turn to finish.

## Status

Scaffold stage: one real adapter (Telegram), one working protocol-level smoke
test. Not yet covered: streaming partial `assistant.text` back to Telegram
mid-turn (currently replies once, on submit's final result), multi-user
session routing, and a stdio/local adapter for zero-dependency manual testing.
