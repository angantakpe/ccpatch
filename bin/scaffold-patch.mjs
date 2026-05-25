#!/usr/bin/env node
/**
 * scaffold-patch.mjs — Generate a new patch file with the contract pre-filled.
 *
 * Usage:
 *   node bin/scaffold-patch.mjs <name> [--category=extension|core] [--kind=splice|flag|free] [--force]
 *
 * Examples:
 *   node bin/scaffold-patch.mjs my_logger
 *   node bin/scaffold-patch.mjs unlock_thing --kind=flag
 *   node bin/scaffold-patch.mjs my_fix --category=core --kind=free
 *
 * --kind options:
 *   splice (default) — uses spliceBoot() to inject a boot-time IIFE
 *   flag             — uses forceFeatureFlag() to override a tengu_* feature flag
 *   free             — empty apply() body, no helper import
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../runner/paths.mjs';

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') return { help: true };
  let name = null, category = 'extension', kind = 'splice', force = false;
  for (const a of args) {
    if (a.startsWith('--category=')) category = a.slice('--category='.length);
    else if (a.startsWith('--kind=')) kind = a.slice('--kind='.length);
    else if (a === '--force' || a === '-f') force = true;
    else if (!a.startsWith('--') && !name) name = a;
  }
  return { name, category, kind, force };
}

const USAGE =
  'Usage: node bin/scaffold-patch.mjs <name> [--category=extension|core] [--kind=splice|flag|free] [--force]';

function templateSplice(name) {
  return `import { spliceBoot } from '../runner/patch-helpers.mjs';

export default {
  category: 'optional',
  enabled: false,
  description: 'TODO: one-line summary of what this patch does',
  capabilities: [], // declare any of: network|fs|env|prompt|telemetry|exec|process
  verify: {
    present: '__ccp_${name}_installed__',
  },
  apply(code) {
    if (code.includes('__ccp_${name}_installed__')) return code; // idempotent guard
    const snippet = \`
// ── [patch:${name}] ────────────────────────────────────────────────────────
(function(){
  if (globalThis.__ccp_${name}_installed__) return;
  globalThis.__ccp_${name}_installed__ = true;
  // TODO: your code here. Runs at bundle boot, before anything else.
})();
var __ccp_${name}_installed__ = true;
\`;
    return spliceBoot(code, snippet);
  },
};
`;
}

function templateFlag(name) {
  return `import { forceFeatureFlag } from '../runner/patch-helpers.mjs';

// TODO: replace with the stable tengu_* feature-flag literal you want to force.
const FLAG_LITERAL = 'tengu_change_me';

export default {
  category: 'feature',
  enabled: false,
  description: 'TODO: what feature does forcing this flag unlock?',
  capabilities: [],
  verify: {
    absent: \`"\${FLAG_LITERAL}",!1\`, // the gated form should be gone post-patch
  },
  apply(code) {
    const { code: out, fnName } = forceFeatureFlag(code, FLAG_LITERAL);
    console.log(\`  [${name}] forced \${fnName}() → true\`);
    return out;
  },
};
`;
}

function templateFree(name) {
  return `export default {
  category: 'optional',
  enabled: false,
  description: 'TODO: one-line summary',
  capabilities: [],
  verify: {
    // At least one of present/absent/count is required by the loader.
    present: '__ccp_${name}__',
  },
  apply(code) {
    // TODO: implement.
    return code;
  },
};
`;
}

const TEMPLATES = { splice: templateSplice, flag: templateFlag, free: templateFree };

function main(argv = process.argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(USAGE); return 0; }
  if (!opts.name) { console.error(USAGE); return 2; }
  if (!/^[a-z][a-z0-9_]*$/.test(opts.name)) {
    console.error(`Error: name must be lowercase snake_case (got "${opts.name}")`);
    return 2;
  }
  if (!['extension', 'core'].includes(opts.category)) {
    console.error(`Error: --category must be 'extension' or 'core'`);
    return 2;
  }
  if (!TEMPLATES[opts.kind]) {
    console.error(`Error: --kind must be one of: ${Object.keys(TEMPLATES).join(', ')}`);
    return 2;
  }
  const dir = path.join(PROJECT_ROOT, opts.category === 'core' ? 'core' : 'extensions');
  const filePath = path.join(dir, `${opts.name}.mjs`);
  if (fs.existsSync(filePath) && !opts.force) {
    console.error(`Error: ${filePath} already exists — pass --force to overwrite`);
    return 1;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, TEMPLATES[opts.kind](opts.name), 'utf8');
  console.log(`Wrote ${filePath}`);
  console.log(`Next: open it, fill in the TODOs, then run`);
  console.log(`  node bin/patch-cli.mjs <bundle> --patch ${opts.name} --dry-run`);
  return 0;
}

const invokedFromCli = (() => {
  try { return import.meta.url === new URL(`file://${path.resolve(process.argv[1] || '')}`).href; }
  catch { return false; }
})();
if (invokedFromCli) process.exit(main());

export { main as runScaffoldCli, parseArgs };
