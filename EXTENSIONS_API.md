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

## Authoring an extension

See [docs/authoring-patches.md](docs/authoring-patches.md) for the full patch manifest reference, lifecycle hooks, and worked examples.

Key points for extension authors:

- **Use `__ccpRequire` for dependencies.** If your extension consumes a value registered by another patch (e.g. `__ccpOnFetch`), call `__ccpRequire('your-contract-name', { consumer: 'my_extension', minVersion: 1 })` rather than reading `globalThis.__ccpOnFetch` directly. This gives a clear error when the producing patch is not enabled.

- **Declare `dependsOn` for hard dependencies.** If your patch must run after another patch, list it in `dependsOn`. The runner enforces topological ordering and rejects cycles. Cross-phase deps must point to the same or an earlier phase (`pre < main < post`).

- **Phase ordering matters.** `pre` patches run before `main` before `post`. Infrastructure globals (`__ccpRegistry`, fetch interceptor, etc.) are registered in the `pre` phase. Consumer extensions in `main` or `post` can rely on them being present.

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
