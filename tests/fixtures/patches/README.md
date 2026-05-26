# Per-patch fixture pattern

Each subdirectory holds one fixture pair for a single patch:

- `<patch-name>/pre.js`  — minimal synthetic input containing the patch's anchor literal.
- `<patch-name>/post.js` — expected output after calling `patch.apply(pre)`.

Tests live in `tests/patch-fixtures.test.mjs` (not yet created). Import the
patch's default export, call `apply(pre)`, and `assert.strictEqual(result, post)`.

## Skipped patches

- `react_singleton` — the three `REACT_MOD_RE_*` regexes require a realistic
  minified bundle shape; the runtime-injection branch requires `globalThis.__hm_require`
  which is injected by the ESM-compat shim. Fixture-testing in isolation is not
  meaningful without the full shim chain.
- `esm_compat` — the shim entangles with the shebang/CJS-IIFE wrapper and emits
  a multi-hundred-byte prelude; expected output would be fragile against shim edits.
- `contracts` — relies on the same shebang/CJS-IIFE anchor as `fetch_interceptor`
  and prepends a large inline block. Output equality would couple tests to hook text.

Add fixture pairs here for patches whose `apply()` is a simple, self-contained
string transformation with a stable anchor (e.g. a single `str.replace` call).
