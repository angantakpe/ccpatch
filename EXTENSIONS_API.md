# ccpatch Extensions API

## Versioning

This API follows the ccpatch package version (currently read from package.json). Minor version bumps are required for any breaking change to `__ccp*` globals. Additive changes (new globals, new optional fields) may be made in patch versions.

## Global registry

The following `__ccp*` globals are injected into `globalThis` at patch-apply time. Extension authors should use `__ccpRequire` to consume them and `__ccpProvide` to register their own named contracts.

| Global name | Provided by patch | Available after | Description |
|---|---|---|---|
| `__ccpRegistry` | `contracts` | `pre` phase | Internal `Map` backing the contract registry. Do not read directly — use `__ccpInspectContracts()`. |
| `__ccpProvide(name, spec)` | `contracts` | `pre` phase | Register a named value contract. `spec`: `{ version, producer, shape?, value }`. Returns `value`. |
| `__ccpRequire(name, opts)` | `contracts` | `pre` phase | Consume a named contract. Throws with actionable diagnostics if unregistered, version too low, or a declared dotted path is missing. `opts`: `{ consumer, minVersion?, shape? }`. |
| `__ccpInspectContracts()` | `contracts` | `pre` phase | Debug helper. Returns `[{ name, version, producer, shape }]` for all registered contracts (no values). |
| `__ccpBusWarn(name, phase, err)` | `fetch_interceptor` | `pre` phase | Advisory error sink called when a fetch subscriber throws. `phase` is one of `'before' \| 'stream' \| 'after'`. Writes one `console.error` line only when `CLAUDE_DEBUG=1` or `globalThis.__ccpDebug` is truthy. Does not alter fan-out semantics. |
| `__ccpOnFetch(fn)` | `fetch_interceptor` | `pre` phase | Subscribe to completed fetch responses. `fn(url, init, responseText)`. |
| `__ccpOnFetchBefore(fn)` | `fetch_interceptor` | `pre` phase | Subscribe to outgoing fetch calls before they are sent. `fn(url, init)`. |
| `__ccpOnFetchStream(fn)` | `fetch_interceptor` | `pre` phase | Subscribe to streaming fetch responses chunk-by-chunk. `fn(url, init, chunk)`. |
| `__ccpOrigFetch` | `fetch_interceptor` | `pre` phase | Reference to the original (un-patched) `fetch`. Use when you need to bypass the interceptor. |
| `__ccpCoverage` | `coverage_kernel` | `pre` phase | Coverage hit-count map (`Map<string, number>`). Keys are marker strings declared in patch manifests via `coverageMarker`. |
| `__ccpCovHit(marker)` | `coverage_kernel` | `pre` phase | Increment the hit counter for `marker`. Called automatically by injected coverage instrumentation — extension authors rarely need to call this directly. |
| `__ccpBunShim` | `bun_shim` | `pre` phase | Truthy when the Bun runtime compatibility shim has been installed. Indicates `require`/`process` polyfills are active. |
| `__ccpBootBanner` | `boot_banner` | `pre` phase | Truthy after the boot-banner hook has run. Used to prevent double-installation. |
| `__ccpAdkContract` | `contracts` | `pre` phase | Coarse top-level ADK handshake marker: `{ version: <int> }` (currently `2`). The ADK's `capabilities()` may read `__ccpAdkContract.version` as a single drift signal in addition to the per-capability shape/version checks. Advisory only. |
| `__ccpGetDispatchNonce()` | `expose_tool_dispatch` | after patch | Returns the load-time **dispatch nonce**. Trusted callers acquire it once at startup and pass it as the first argument to `__ccpInvokeTool`, `__ccpRegisterTool`, and `__ccpUnregisterTool`. |
| `__ccpInvokeTool(nonce, name, input, signal?)` | `expose_tool_dispatch` | after patch | Dispatch a tool call through the live tool object. First arg must equal `__ccpGetDispatchNonce()`; wrong/absent nonce throws. |
| `__ccpRegisterTool(nonce, toolObj)` | `expose_tool_dispatch` | after patch | **Nonce-gated** upsert of `toolObj` into `__ccpRawTools` keyed by `toolObj.name`. Same nonce as `__ccpInvokeTool` (registration + dispatch are one trust domain). Returns `true`. Lets the ADK inject tools through a guarded boundary instead of mutating the raw array. |
| `__ccpUnregisterTool(nonce, name)` | `expose_tool_dispatch` | after patch | **Nonce-gated** splice-by-name from `__ccpRawTools`. Returns `true` if removed, `false` if no match. Wrong/absent nonce throws. |
| `__ccpGetSystemPromptNonce()` | `expose_system_prompt` | after patch | Returns the load-time **system-prompt nonce** (distinct from the dispatch nonce — persona writes are higher authority). Trusted callers acquire it once and pass it to `__ccpSetSystemPrompt`. |
| `__ccpSetSystemPrompt(nonce, str\|null)` | `expose_system_prompt` | after patch | **Nonce-gated** persona-overlay writer (was single-arg `(str)` pre-v0.2.2). First arg must equal `__ccpGetSystemPromptNonce()`; wrong/absent nonce throws. Set/clear (with `null`/`""`) the trailing system-prompt overlay. |
| `__ccpGetSystemPrompt()` | `expose_system_prompt` | after patch | **Ungated** reader for the current persona overlay (or `null`). Reading the active persona is not a privilege escalation; only writing is gated. |

## Registered contracts

The expose-internals patches register typed contracts (`__ccpProvide`) so consumers
can probe version + dotted-path shape. The ADK's `capabilities()` consumes these as
a drift-refusal handshake (a present-but-drifted global is reported unusable).

| Contract | Producer | Version | Shape paths |
|---|---|---|---|
| `toolDispatch` | `expose_tool_dispatch` | `2` | `getTools`, `invokeTool`, `buildToolContext`, `mcpHealth`, `getDispatchNonce`, `registerTool`, `unregisterTool` |
| `systemPrompt` | `expose_system_prompt` | `2` | `set`, `get`, `getNonce` |

Both bumped to **v2** when the nonce-gated registrar / writer landed:
`toolDispatch` v2 adds `registerTool`/`unregisterTool` to the shape; `systemPrompt`
v2 changes `set` to the two-arg `(nonce, value)` form and adds `getNonce`. The ADK
requires `systemPrompt` **minVersion 2 with shape `getNonce`** for `swap`, and
`toolDispatch` shape `registerTool` for `tools` — a host advertising the old v1
shape is downgraded loudly in `capabilities().detail[cap].reason`.

## headless_bridge: tool-dispatch allowlist (default-deny)

The `headless_bridge` extension's `dispatch` op is gated by a server-side tool
allowlist read from `CC_BRIDGE_TOOL_ALLOWLIST` at bridge startup:

| `CC_BRIDGE_TOOL_ALLOWLIST` | Effect |
|---|---|
| unset / empty | **Deny every `dispatch` op** (the default). A one-time loud warning is printed at bridge startup when unset; denied dispatches return an error naming the variable and both opt-in forms. |
| `*` | Allow every exposed tool. This was the implicit pre-allowlist behavior; it now requires explicit opt-in. |
| `ToolA,ToolB` | Allow only the named tools (a `*` entry anywhere in the list means allow-all). |

Only `dispatch` is gated — `hello`, `submit`, `subscribe`, `cancel`, and `bye`
work regardless of the allowlist. **Breaking change:** bridge clients that
dispatched tools with the variable unset must now set it (a per-tool list is
preferred; `'*'` restores the old behavior). See THREAT_MODEL.md ("Remote
tool/code-execution surface") for why the default is deny-all.

## policy_gate: host-driven behavior gate

> **Status: ships disabled, no bundled consumer.** `policy_gate` is `enabled: false`
> in `ccpatch.yml` and provides only the gate *mechanism* — it is policy-free and
> inert until a host wires a consumer module. ccpatch does **not** bundle a
> consumer; the gate is a platform-tier building block for downstream hosts that
> own their own policy logic. The keep-vs-remove question (should ccpatch ship a
> consumer-less gate at all?) is an **owner decision tracked in COD-15** — this
> entry documents the gate so the decision is explicit rather than implicit. Do
> not remove this patch without owner sign-off; it is a security-relevant
> enforcement primitive.

The `policy_gate` extension enforces two host-supplied checks **inside** the CLI
process, on every surface (interactive and headless), so a host's server-side
policy engine can reach a raw `claude` session it otherwise couldn't:

- **SOFT** — a system-prompt steer string (`steer()`), installed via
  `expose_system_prompt`'s nonce-gated writer at boot and before each turn.
- **HARD** — an outbound request gate (`inspectRequest()`) via `fetch_interceptor`'s
  `__ccpOnFetchBefore`, returning `allow` / `scrub` (replace request body) /
  `block` (short-circuit with a synthetic assistant turn). An optional
  response-side `onStreamEvent()` can abort a stream early.

### Wiring a consumer

1. Write a host policy module exporting any subset of the contract
   (`steer`, `inspectRequest`, `onStreamEvent` — all optional, feature-detected):

   ```js
   module.exports = {
     steer() { return '## House rules: …' /* or null to clear */ },
     inspectRequest({ url, options, isApi, body }) {
       return { action: 'allow' }; // or { action:'scrub', body } / { action:'block', message }
     },
     onStreamEvent(ev) { return false; /* true aborts the stream */ },
   };
   ```

2. Enable `policy_gate` (and its deps `fetch_interceptor` + `expose_system_prompt`)
   in your profile and re-apply the patch set.
3. Point the CLI at the module and choose a failure mode:

| Env var | Effect |
|---|---|
| `CCP_POLICY_GATE_MODULE` | Absolute path to the host policy module. **Unset = inert** (the shipped default); the gate does nothing. |
| `CCP_POLICY_GATE_REQUIRED` | `1` = **fail closed**: a configured-but-degraded gate (missing/throwing module, wrong shape, throwing `steer()` boot probe) BLOCKS every outbound Anthropic request instead of degrading to no-gating. Default (unset) = **fail open**: degrade to no-gating, but print one loud boot warning. |
| `CCP_POLICY_GATE_PRIORITY` | Before-hook priority for the outbound gate (default `20`; lower runs earlier). |
| `CLAUDE_DEBUG` | `1` surfaces per-request gate diagnostics on stderr. |

**Loading a module path runs arbitrary host code in the CLI process** — hence the
extension's `exec` capability and the disabled-by-default posture. See the file
header in `extensions/policy_gate.mjs` for the full contract and fail-open /
fail-closed semantics.

## Authoring an extension

See [docs/authoring-patches.md](docs/authoring-patches.md) for the full patch manifest reference, lifecycle hooks, and worked examples.

Key points for extension authors:

- **Use `__ccpRequire` for dependencies.** If your extension consumes a value registered by another patch (e.g. `__ccpOnFetch`), call `__ccpRequire('your-contract-name', { consumer: 'my_extension', minVersion: 1 })` rather than reading `globalThis.__ccpOnFetch` directly. This gives a clear error when the producing patch is not enabled.

- **Declare `dependsOn` for hard dependencies.** If your patch must run after another patch, list it in `dependsOn`. The runner enforces topological ordering and rejects cycles. Cross-phase deps must point to the same or an earlier phase (`pre < main < post`).

- **Phase ordering matters.** `pre` patches run before `main` before `post`. Infrastructure globals (`__ccpRegistry`, fetch interceptor, etc.) are registered in the `pre` phase. Consumer extensions in `main` or `post` can rely on them being present.

## Boot hooks (`bootInject`)

A patch that needs code to run **before the bundle body** must NOT hand-roll its own splice at the shebang / CJS-IIFE anchor. Declare it instead:

```js
// extensions/my_patch.mjs
export default {
  description: 'My patch',
  verify: { present: '__ccpMyHook', count: { present: 1 } },
  bootInject: {
    order: 70,            // lower runs first; ties broken by patch name. Use gaps of 10.
    code: hook,           // verbatim JS string, or (options) => string (receives e.g. options.version)
    // sentinel: '__ccpMyHook',  // optional; defaults to the first verify.present literal
  },
};
```

The runner's boot registry (`runner/boot-registry.mjs`) collects every enabled patch's block, sorts by `order`, and performs **exactly one** insertion at the canonical boot anchor (after a real leading shebang, else immediately before the CJS-IIFE head). Patches whose sentinel is already present in the input are skipped, so re-applying is a byte-identical no-op per patch. A patch may be boot-only (no `apply()`) or combine `bootInject` with an `apply()` for non-boot transformations.

Reserved order slots (standard profile): `10` fetch_interceptor (the `__ccpOnFetch*` bus must exist before any subscriber), `20` bun_shim, `30` tool_result_error_content, `40` boot_banner (order-independent by design), `50` mcp_lazy (registers against the bus without polling), `60` stdin_da1_leak. New boot hooks should use `70+`.

## Preload companion files

Instead of embedding preload code as a string inside the patch manifest, you can place it in a sibling file named `<name>.preload.mjs`. The preload-builder will automatically detect and use it.

**Before** (inline `preloadCode` string):

```js
// extensions/my_patch.mjs
export default {
  description: 'My patch',
  preload: true,
  preloadCode: `
    const orig = globalThis.fetch;
    globalThis.fetch = (url, init) => { console.log('fetch:', url); return orig(url, init); };
  `,
  apply(code) { return code; },
  verify: { present: 'fetch', weak: true },
};
```

**After** (companion file):

```js
// extensions/my_patch.mjs
export default {
  description: 'My patch',
  preload: true,
  // preloadCode omitted — preload-builder reads extensions/my_patch.preload.mjs
  apply(code) { return code; },
  verify: { present: 'fetch', weak: true },
};
```

```js
// extensions/my_patch.preload.mjs
const orig = globalThis.fetch;
globalThis.fetch = (url, init) => { console.log('fetch:', url); return orig(url, init); };
```

The companion file (`<name>.preload.mjs`) must live alongside `<name>.mjs`. The preload-builder resolves it at build time using `patch.__filePath` (set by the loader). If neither `preloadCode` nor the companion file is found, the patch is skipped with a warning.

Note: when using the companion file convention, `validateManifest` will emit a warning (not an error) during normal runtime loads. In validation-only / CI strict mode (no logger context), omitting both `preloadCode` and the companion file is still a hard error at manifest validation time.

## Changelog

- **v0.2.0** — Initial API documentation.
- **v0.2.1** — Preload companion `.preload.mjs` file convention (#9).
- **v0.2.2** — Nonce-gated ADK write surfaces. `expose_tool_dispatch` adds `__ccpRegisterTool`/`__ccpUnregisterTool` (dispatch-nonce gated) and bumps the `toolDispatch` contract to **v2**. `expose_system_prompt` makes `__ccpSetSystemPrompt` two-arg `(nonce, value)`, adds `__ccpGetSystemPromptNonce()`, and bumps the `systemPrompt` contract to **v2** (shape `['set','get','getNonce']`). `contracts` publishes the coarse `__ccpAdkContract` marker. **Breaking:** the old single-arg `__ccpSetSystemPrompt(str)` is superseded; the ADK keeps a legacy fallback for hosts/stubs without the nonce getter.
- **v0.2.3** — Security-review hardening. **Breaking:** `headless_bridge` tool dispatch is now default-deny — `CC_BRIDGE_TOOL_ALLOWLIST` unset/empty rejects every `dispatch` op; set a per-tool list or `'*'` to restore dispatch (non-dispatch ops unaffected). `policy_gate` prints a one-time loud boot warning when `CCP_POLICY_GATE_MODULE` is configured but the gate degrades to no-gating (missing/throwing module, wrong shape, or throwing `steer()` boot probe) — runtime fail-open behavior unchanged. Capability declarations made honest: `headless_bridge` → `network,prompt,tools,exec,env,fs`; `policy_gate` → `+exec`; `expose_tool_dispatch` → `tools,network,exec`.
