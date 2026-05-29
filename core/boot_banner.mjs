// Patch: boot_banner
// Collects ccpatch's own boot-log lines and renders them inside a responsive
// rounded box, printed once just before Claude Code's own banner. Patches push
// lines through an order-independent global contract (see the shim header), so
// this patch never has to run first — it just owns the debounced flush.
//
// Shim convention (mirrors core/bun_shim.mjs): the runtime payload lives in
// runner/shims/boot-banner-v1.js.txt and is read verbatim via readFileSync, so
// the box-drawing glyphs and template logic need no escaping. The only build-
// time substitution is the box title, which carries the patched bundle version.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { spliceBoot } from '../runner/patch-helpers.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const BOOT_BANNER_V1 = readFileSync(join(__dir, '..', 'runner', 'shims', 'boot-banner-v1.js.txt'), 'utf8');

export default {
  category: 'fix',
  required: true,

  description: 'Render ccpatch boot-log lines in a responsive rounded box before the Claude Code banner.',
  // stderr-only — no network/env/exec capability.
  verify: { present: '__ccpBootBanner', count: { present: 1 } },
  apply: (code, options = {}) => {
    const version = options && typeof options.version === 'string' ? options.version : null;
    const title = version ? `ccpatch v${version}` : 'ccpatch';
    // Function-form replace so any $-sequences in `title` are injected literally.
    const shim = BOOT_BANNER_V1.replace('__CCP_BOOT_TITLE__', () => title);
    return spliceBoot(code, shim);
  },
};
