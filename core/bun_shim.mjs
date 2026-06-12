// Patch: bun_shim
// Injects a globalThis.Bun polyfill so the extracted CJS bundle can run under
// Node.js. Bun-compiled bundles call Bun.* APIs without typeof guards. This shim
// provides Node.js equivalents for every Bun API the bundle actually invokes.
//
// Shim convention (mirrors core/esm_compat.mjs / core/react_singleton.mjs):
// heavy payload lives in runner/shims/bun-polyfill-v1.js.txt (versioned filename
// — future polyfill rewrites bump the version). The payload is read verbatim via
// readFileSync so no escaping is required (avoids template-literal pitfalls with
// $&-style regex placeholders in the payload).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const BUN_POLYFILL_V1 = readFileSync(join(__dir, '..', 'runner', 'shims', 'bun-polyfill-v1.js.txt'), 'utf8');

export default {
  category: 'fix',
  required: true,

  description: 'Inject globalThis.Bun shim so bundle runs under Node.js without Bun installed',
  capabilities: ["env","network"],
  verify: {
    present: '__ccpBunShim',
    // Shim source contains '__ccpBunShim' exactly 3 times: function name,
    // catch err var declaration, and the warn() reference.
    count: { present: 3 },
  },
  // Boot hook spliced by the runner's boot registry (runner/boot-registry.mjs):
  // ONE combined insertion at the canonical boot anchor (after a real leading
  // shebang, else before the CJS-IIFE head — the registry owns the careful
  // startsWith-vs-includes shebang handling that used to live here). order 20:
  // the polyfill runs at the top of the boot block, before any bundle Bun.*
  // call (those all live inside the IIFE body, which follows the whole block).
  bootInject: { order: 20, code: BUN_POLYFILL_V1 },
};
