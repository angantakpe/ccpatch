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
  // Co-locates at the boot point (before the CJS-IIFE) with other boot hooks on
  // shebang-less Bun-extracted bundles. Benign stacking — the shim still runs
  // before the IIFE body's first Bun.* call. Not a clobber.
  allowOverlapWith: ['fetch_interceptor'],
  verify: {
    present: '__ccpBunShim',
    // Shim source contains '__ccpBunShim' exactly 3 times: function name,
    // catch err var declaration, and the warn() reference.
    count: { present: 3 },
  },
  apply: (code) => {
    // Anchor: inject the shim before any bundle code executes — after a real
    // leading shebang if one exists, otherwise immediately before the CJS-IIFE.
    // NOTE: match the shebang with startsWith(), NOT includes(). Bundles extracted
    // from the Bun binary have no leading shebang, but DO contain the literal
    // "#!/usr/bin/env node" as an interior string (Anthropic's own hook-installer
    // code). includes() matches that interior literal and splices the Bun polyfill
    // into the middle of the bundle as dead string content, so globalThis.Bun is
    // never defined → "ReferenceError: Bun is not defined" at the first Bun.* call.
    // The no-shebang case is handled correctly below by replacing the CJS-IIFE head
    // wherever it sits (even if earlier patches prepended code before it).
    const SHEBANG = '#!/usr/bin/env node';
    const CJS_IIFE = '(function(exports, require, module, __filename, __dirname)';
    const hasShebang = code.startsWith(SHEBANG);
    const hasCjsIife = code.includes(CJS_IIFE);
    if (!hasShebang && !hasCjsIife) {
      console.warn('  [!] bun_shim: neither shebang nor CJS-IIFE anchor found — skipping');
      return code;
    }

    const shim = BUN_POLYFILL_V1;

    if (hasShebang) {
      // Shebang present: inject after the shebang line
      const shebangEnd = code.indexOf(SHEBANG) + SHEBANG.length;
      const afterShebang = code.indexOf('\n', shebangEnd) + 1;
      return code.slice(0, afterShebang) + shim + code.slice(afterShebang);
    }
    // CJS IIFE: inject immediately before the IIFE so the shim runs first.
    // Use function replacement to prevent $& and other $-patterns in the shim
    // (e.g. the "Number($&0xffffffffn)" comment) from being expanded by replace().
    return code.replace(CJS_IIFE, () => shim + CJS_IIFE);
  },
};
