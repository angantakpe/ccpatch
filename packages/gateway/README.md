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
streaming.mjs           channel-agnostic turn streaming: throttle, SerialQueue, streamTurn
adapters/telegram.mjs   Telegram adapter (grammy-based)
adapters/stdio.mjs      local terminal adapter (node:readline only, no deps/credentials)
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

For a quick smoke test with no bot token and no `npm install`, use the stdio
adapter instead — one stdin line per turn, the turn's final result on stdout:

```
CC_BRIDGE_ADDR=unix:/run/ccpatch.sock CC_BRIDGE_TOKEN=<shared secret> \
GATEWAY_ADAPTERS=stdio node run.mjs          # interactive

echo 'summarize the repo' | CC_BRIDGE_ADDR=… CC_BRIDGE_TOKEN=… \
GATEWAY_ADAPTERS=stdio node run.mjs          # piped; exits at EOF
```

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

### All chats share ONE conversation — there is no per-user isolation

This is the single most important thing to understand before adding a second
chat id to `TELEGRAM_ALLOWED_CHAT_IDS`.

One gateway process holds **one** bridge connection to **one** patched CLI
session. Every allowed chat submits into that same session's turn history:

- chat B can read anything chat A said (and anything the assistant said back),
  simply by asking;
- both chats mutate the same context window, working directory, and file
  system, through the same CLI process;
- there is no per-chat memory, no per-chat cwd, no per-chat permissions.

The queues described under [Status](#status) serialize turns so replies do not
interleave. **Serialization is not isolation.** Treat
`TELEGRAM_ALLOWED_CHAT_IDS` as the list of people you would hand the same
terminal to.

True multi-tenancy — one patched CLI process plus one bridge socket per user,
routed by chat id — is **not implemented**.

## Adding another channel adapter

Implement `{ name, start({ bridge, log }), stop() }` (see `adapter.mjs`) and
register it in `run.mjs`'s `ADAPTER_FACTORIES`. `bridge` is an already
`connect()`-ed `BridgeClient` — call `.submit()`/`.dispatch()` and listen for
`.on('event', (topic, payload) => …)` or `.on('<topic>', payload => …)` (e.g.
`assistant.text`) to stream output back to the channel as it arrives instead
of waiting for the full turn to finish.

For the common case, don't rebuild the streaming loop: `streaming.mjs`'s
`streamTurn({ bridge, prompt, message, throttleMs })` already does
placeholder → throttled mid-turn edits → final result, and holds the
gateway-wide submit lock described under [Status](#status). It knows nothing
about Telegram — supply a `message` surface with `send(text)` / `edit(text)`
(`createMessageSurface` in `adapters/telegram.mjs` is the ~12-line reference
implementation). Use `SerialQueue` from the same module for per-conversation
ordering.

## Status

Scaffold stage: two adapters (Telegram, and the zero-dependency stdio adapter
for local manual testing), a protocol-level smoke test against a real socket,
and a unit suite over the streaming/ordering/translation logic.

### Done

- **Mid-turn streaming** — a Telegram message gets an immediate `…`
  placeholder, which is then edited in place as `assistant.text` events
  arrive, and edited a final time with the turn's result. Edits go through a
  leading+trailing throttle (~1.2s, `editThrottleMs`) so a 300-delta turn
  costs a handful of `editMessageText` calls rather than 300 — Telegram
  rate-limits edits. A rejected `submit()` edits the placeholder to the error
  instead of leaving it stuck on `…`. The stdio adapter keeps the simpler
  submit-wait-print form deliberately (no incremental stdout writes) — see
  `adapters/stdio.mjs`'s header — streaming to the same stdout that also
  prints the final result would either duplicate output or break the piping
  contract that makes it useful for `echo … | node run.mjs`.
- **The real answer comes from the event stream, not `submit()`'s return
  value** — confirmed live against a real patched CLI on 2026-08-21, not just
  the test stub. `extensions/expose_submit_input.mjs` captures React's
  `submit` useCallback, a void UI event handler that dispatches into the chat
  UI and resolves with nothing usable — it is not a request/response
  function. `tests/bridge_host.mjs`'s stub fabricates a `{final: ...}` return
  the real CLI never produces, which is exactly how the original bug (both
  adapters printing `null`/the literal string `"null"`) shipped past a green
  test suite undetected. Fixed by `streaming.mjs`'s `resolveTurnText` /
  `submitAndCollect`: both adapters now accumulate `assistant.text` and treat
  that as the answer, falling back to `submit()`'s return value only when
  nothing streamed at all (e.g. a tool-only turn, or a test double).
- **Per-chat ordering** — a `Map<chatId, Promise>` chain (`SerialQueue`) means
  two messages from the same chat are handled strictly in arrival order rather
  than racing each other's placeholders and edits. The stdio adapter has the
  same property for free — one stdin, lines read and awaited strictly in
  order.
- **Zero-dependency local adapter** — `adapters/stdio.mjs` needs no bot token,
  no credentials, and no `npm install` (stdlib `node:readline` only), so a
  patched session is reachable for manual testing immediately after cloning.
- **`assistant.text` no longer mixes in auxiliary API calls** — found live on
  2026-08-21 while verifying the fix above: a real turn's accumulated output
  included stray `{"title": "..."}` JSON ahead of the actual answer. Claude
  Code makes ~30 internal API calls beyond the human-facing turn (title
  generation, branch naming, hook prompts, repl sampling, ...; grep the
  extracted bundle for `querySource`) that were all streaming through the
  same SSE tap and getting re-emitted as ordinary `assistant.text`. Fixed at
  the source, not in this package: `core/fetch_interceptor.mjs`'s stream
  subscribers now receive the originating request's `{url, options}`, and
  `extensions/assistant_stream_events.mjs` uses that to skip any request
  whose body sets `output_config.format` (the wire-level marker every one of
  those internal calls sets when requesting schema-constrained JSON output —
  the main conversation turn never does). Re-verified live against the real
  patched CLI after the fix: clean `PONG`, no JSON noise. See both files'
  module-header comments for the full trace, including a first attempt that
  checked the wrong field path (`body.format` instead of the actual
  `body.output_config.format`) and caught nothing until corrected.

### Known limitation: bridge events are not correlated to a submit

`extensions/headless_bridge.mjs` advertises `{ ref?, kind:"event", … }` in its
docblock, but its `subscribe()` implementation sends
`send({ kind:'event', event: topic || t, payload })` — **`ref` is never
populated**. `assistant.text` itself carries only `{ text }`
(`extensions/assistant_stream_events.mjs`), and although the bridge passes
`{ requestId: id }` into `__ccpSubmitInput`, `extensions/expose_submit_input.mjs`'s
adapter discards its options argument, so that id never reaches the CLI — nor
the SSE tap that emits the events, which has no notion of which submit it
belongs to.

There is therefore **no id to filter on**. Rather than ship code that silently
interleaves two users' assistant text into each other's messages, every submit
is funnelled through one process-wide queue: **at most one submit is in flight
across the whole gateway**, so while a turn streams, every `assistant.text` on
the connection provably belongs to it. The cost is deliberate — concurrent
chats wait their turn. Fixing this properly means threading a turn id through
those three CLI-side patches, not working around it here.

### Not yet covered

- **Multi-user session routing** — explicitly *not* solved. All chats still
  share one CLI session and one conversation; see
  [the security section](#all-chats-share-one-conversation--there-is-no-per-user-isolation).
  True isolation means one patched CLI process + one bridge socket per user,
  routed by chat id — a materially bigger undertaking than this scaffold
  (process lifecycle, port/socket allocation, per-user config) and
  deliberately out of scope until asked for explicitly.
- Streaming `tool.call` / `agent.*` activity (only `assistant.text` is
  streamed today); `run.mjs` already subscribes to those topics.

## Tests

```
node --test packages/gateway/tests/*.test.mjs   # from the repo root
```

- `tests/bridge-client.test.mjs` drives the real protocol over a real Unix
  socket via `tests/bridge_host.mjs` at the repo root.
- `tests/telegram-adapter.test.mjs` needs neither grammy nor a socket — the
  adapter's logic takes its Telegram and bridge surfaces as plain objects, so
  a fake `ctx` (`reply` + `api.editMessageText`) and a fake bridge (`on`/`off`/
  `submit`) exercise the real code paths.
- `tests/stdio-adapter.test.mjs` needs neither a TTY nor a socket — a fake
  `Readable` stands in for stdin and a stub bridge stands in for
  `BridgeClient`, covering the translation layer (one submit per line, the
  `final`/`text`/JSON fallback, a rejected submit not killing the loop).
