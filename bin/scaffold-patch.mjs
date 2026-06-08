#!/usr/bin/env node
/**
 * scaffold-patch.mjs — Generate a new patch file with the contract pre-filled.
 *
 * Usage:
 *   node bin/scaffold-patch.mjs <name> [--category=extension|core] [--kind=<kind>] [--force]
 *
 * Examples:
 *   node bin/scaffold-patch.mjs my_logger
 *   node bin/scaffold-patch.mjs unlock_thing --kind=flag
 *   node bin/scaffold-patch.mjs my_fix --category=core --kind=free
 *   node bin/scaffold-patch.mjs entry_log --kind=prefix
 *
 * --kind options (default: prefix — a declarative kind, since the docs recommend
 * declarative over imperative for the common "one small thing to one function"):
 *   Declarative kinds (preferred — the runner synthesizes apply() from the
 *   target/code/transform fields; see runner/manifest-schema.mjs KIND_ENUM):
 *     free       — apply()-based escape hatch (the declarative default `kind`)
 *     prefix     — inject `code` right after the target function's opening brace (DEFAULT)
 *     postfix    — wrap the target function's return value via `code`
 *     transpiler — rewrite the target function's whole body via `transform()`
 *   apply()-helper kinds (imperative; use the patch-helpers toolbox):
 *     splice     — uses spliceBoot() to inject a boot-time IIFE
 *     flag       — uses forceFeatureFlag() to override a tengu_* feature flag
 *
 * Every template is lint-passing and passes validateManifest as-is, so the
 * only thing to fill in is the TODO-marked anchor/body.
 */

import fs, { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../runner/paths.mjs';

const REGISTRY_PATH = path.join(PROJECT_ROOT, 'tests/fixtures/registry.mjs');
const REGISTRY_MARKER = '// ── scaffold-patch.mjs inserts new entries here ──';
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'ccpatch.yml');

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') return { help: true };
  let name = null, category = 'extension', kind = 'prefix', force = false;
  for (const a of args) {
    if (a.startsWith('--category=')) category = a.slice('--category='.length);
    else if (a.startsWith('--kind=')) kind = a.slice('--kind='.length);
    else if (a === '--force' || a === '-f') force = true;
    else if (!a.startsWith('--') && !name) name = a;
  }
  return { name, category, kind, force };
}

const USAGE =
  'Usage: node bin/scaffold-patch.mjs <name> [--category=extension|core] ' +
  '[--kind=free|prefix|postfix|transpiler|splice|flag] [--force]';

function templateSplice(name) {
  return `import { spliceBoot } from '../runner/patch-helpers.mjs';

/** @type {import('../types/patch').Patch} */
export default {
  category: 'optional',
  enabled: false,
  description: 'TODO: one-line summary of what this patch does',
  capabilities: [], // declare any of: network|fs|env|prompt|tools|exec|telemetry
  verify: {
    // present-only is a WEAK verify; opt in so the stub validates, then tighten
    // with absent/count (e.g. absent the un-installed form) once it is stable.
    present: '__ccp_${name}_installed__',
    weak: true,
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

/** @type {import('../types/patch').Patch} */
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
  return `/** @type {import('../types/patch').Patch} */
export default {
  category: 'optional',
  enabled: false,
  description: 'TODO: one-line summary',
  capabilities: [],
  verify: {
    // At least one of present/absent/count is required by the loader.
    // present-only is a WEAK verify (can't detect double/wrong-location apply):
    // prefer adding \`absent\` or \`count\`. We opt in with weak:true so the stub
    // passes validation — tighten this once you know your real markers.
    present: '__ccp_${name}__',
    weak: true,
  },
  apply(code) {
    // TODO: implement.
    return code;
  },
};
`;
}

// ── Declarative kinds (kind: 'prefix'|'postfix'|'transpiler') ────────────────
// These synthesize apply() from target/code/transform — no apply() export, no
// helper import. The runner locates `target.function` (a stable string literal
// in the minified bundle, or a bare function name) and rewrites it per kind.
// See runner/patch-kinds.mjs and CONTRIBUTING.md "Declarative patch kinds".

function templatePrefix(name) {
  return `/** @type {import('../types/patch').Patch} */
export default {
  category: 'feature',
  enabled: false,
  description: 'TODO: what does injecting code at this function entry achieve?',
  capabilities: [], // declare any of: network|fs|env|prompt|tools|exec|telemetry
  // prefix injects \`code\` exactly once at the function head; assert it landed once.
  verify: { present: '__ccp_${name}__', count: { present: 1 } },

  kind: 'prefix',
  // Anchor the enclosing function by a STABLE substring. Prefer a quoted string
  // literal that survives minification; use { body: '...' } to match on a
  // property access / token inside the function instead of a quoted literal.
  target: { function: { literal: 'TODO_STABLE_LITERAL' } },
  // Verbatim JS spliced right after the opening brace. Keep it a single
  // statement-ish blob; it runs first, every time the function is called.
  code: 'var __ccp_${name}__=1;',
};
`;
}

function templatePostfix(name) {
  return `/** @type {import('../types/patch').Patch} */
export default {
  category: 'feature',
  enabled: false,
  description: 'TODO: how do you want to transform this function return value?',
  capabilities: [],
  // postfix wraps each \`return X\` as (function(__r){ <code>; return __r })(X).
  // \`__r\` is the original return value; mutate or replace it, then it is returned.
  // present-only is WEAK (can't catch double-apply); opt in so the stub validates,
  // then tighten with absent/count once your markers are stable.
  verify: { present: '__ccp_${name}__', weak: true },

  kind: 'postfix',
  target: { function: { literal: 'TODO_STABLE_LITERAL' } },
  // \`__r\` is in scope. TODO: inspect/replace it. The marker proves the wrap ran.
  code: 'var __ccp_${name}__=__r;',
};
`;
}

function templateTranspiler(name) {
  return `/** @type {import('../types/patch').Patch} */
export default {
  category: 'feature',
  enabled: false,
  description: 'TODO: what whole-body rewrite does this function need?',
  capabilities: [],
  // transpiler hands you the function body as a string and splices your result
  // back in. Returning the body unchanged leaves the bundle byte-identical.
  // present-only is WEAK; opt in so the stub validates, then tighten with
  // absent/count once your markers are stable.
  verify: { present: '__ccp_${name}__', weak: true },

  kind: 'transpiler',
  target: { function: { literal: 'TODO_STABLE_LITERAL' } },
  // (functionBody, opts) => string. TODO: do a targeted .replace() — avoid
  // wholesale rewrites so the patch survives minor upstream churn.
  transform(body) {
    // Example: short-circuit a guard. Replace with your real edit.
    return body.replace(/return!1/, 'return!0 /* __ccp_${name}__ */');
  },
};
`;
}

const TEMPLATES = {
  free: templateFree,
  prefix: templatePrefix,
  postfix: templatePostfix,
  transpiler: templateTranspiler,
  splice: templateSplice,
  flag: templateFlag,
};

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
  // Prepend `// @ts-check` so the @type JSDoc on each template is actually
  // enforced by the editor and by `make lint-dead` (tsc --checkJs), turning a
  // mistyped manifest field into an author-time error instead of a build-time one.
  const body = TEMPLATES[opts.kind](opts.name);
  const content = body.startsWith('// @ts-check') ? body : `// @ts-check\n${body}`;
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Wrote ${filePath}`);

  const testPath = path.join(PROJECT_ROOT, 'tests', opts.name + '.test.mjs')
  if (!existsSync(testPath)) {
    const name = opts.name;
    const testSrc = [
      '// Test stub for the ' + name + ' patch.',
      '// Generated by: make new-patch NAME=' + name,
      '// Replace placeholder assertions with real fixture-based tests.',
      "import { test } from 'node:test'",
      "import assert from 'node:assert/strict'",
      "import { loadPatches } from '../runner/loader.mjs'",
      '',
      "test('" + name + ": patch loads without error', async () => {",
      '  const patches = await loadPatches()',
      "  assert.ok(patches['" + name + "'], 'patch " + name + " should be registered')",
      '})',
      '',
      "test('" + name + ": verify.present strings are present after apply (placeholder)', async () => {",
      '  // TODO: load a fixture bundle, apply the patch, assert verify.present strings.',
      '  // See tests/patch-verification.test.mjs for the pattern.',
      "  assert.ok(true, 'Replace with real assertions')",
      '})',
      '',
    ].join('\n')
    writeFileSync(testPath, testSrc)
    console.log('  test: ' + testPath)
  } else {
    console.log('  test: ' + testPath + ' (already exists, skipped)')
  }

  const registryWrote = appendFixtureStub(opts.name);
  if (registryWrote) {
    console.log(`Appended fixture stub for "${opts.name}" to tests/fixtures/registry.mjs`);
  }

  const manifestStatus = registerInManifest(opts.name);
  if (manifestStatus === 'wrote') {
    console.log(`Registered "${opts.name}" in ccpatch.yml (DISABLED — enabled: false)`);
  } else if (manifestStatus === 'exists') {
    console.log(`Notice: "${opts.name}" already present in ccpatch.yml — left untouched`);
  }

  const name = opts.name;
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Edit the patch:    ${filePath}`);
  console.log(
    `     Fill in the TODO-marked anchor/body. Pick a STABLE string literal as the`
  );
  console.log(
    `     anchor — see docs/finding-anchors.md (\`make beautify\` + grep for tengu_*`
  );
  console.log(
    `     / error-message / env-var literals that survive minification).`
  );
  console.log(
    `  2. Enable it:         in ccpatch.yml, set \`${name}: true\` under \`patches:\``
  );
  console.log(`     (it was registered as \`${name}: false\` — opt-in/disabled by default).`);
  // Two positionals are required (<input> <output>); a single `--patch` in the
  // output slot is rejected. We point the output at /tmp since --dry-run never
  // writes it. A lone --patch X --dry-run relaxes the capability-ack gate, but
  // --allow-unacked keeps it working even if you later drop --dry-run.
  console.log(`  3. Dry-run JUST this patch:`);
  console.log(
    `       node bin/patch-cli.mjs <bundle> /tmp/${name}-out.mjs --patch ${name} --dry-run --allow-unacked`
  );
  console.log(`  4. Test just this patch:   make test-patch NAME=${name}`);
  console.log(`  5. Check anchor health:    node bin/patch-cli.mjs doctor <bundle>`);
  console.log(`     (a.k.a. \`ccpatch doctor\` — reports ok | drift | missing per patch)`);
  if (registryWrote) {
    console.log('');
    console.log(
      `Note: the Layer 1/2 verification tests will SKIP "${name}" until you replace its\n` +
      `      null fixture in tests/fixtures/registry.mjs with a real anchor-bearing fragment\n` +
      `      (so \`make test-patches\` does not silently pass it as skipped).`
    );
  }
  return 0;
}

/**
 * Append a new patch entry to the `patches:` map in ccpatch.yml, defaulting to
 * DISABLED. Uses the `name: false` shorthand that every other opt-in entry in
 * the manifest already uses (see docs/manifest-reference.md), so the result is
 * valid YAML and matches the surrounding style.
 *
 * Idempotent: if a `<name>:` key already exists anywhere in the manifest, the
 * append is skipped and `false` is returned so the caller can print a notice.
 *
 * Returns one of:
 *   'wrote'   — entry appended
 *   'exists'  — a key for this patch already exists; skipped
 *   'missing' — ccpatch.yml or its `patches:` section could not be found
 *
 * @param {string} name
 * @returns {'wrote'|'exists'|'missing'}
 */
function registerInManifest(name) {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.warn(`  [warn] ${MANIFEST_PATH} not found — skipping manifest registration`);
    return 'missing';
  }
  const src = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const lines = src.split('\n');

  // Idempotency: bail if a key for this patch already exists (either the
  // `name:` long form or the `name: <value>` shorthand), at any indentation.
  const keyRe = new RegExp(`^\\s*${name}\\s*:`, 'm');
  if (keyRe.test(src)) return 'exists';

  // Locate the `patches:` block and the first subsequent top-level key (a line
  // starting in column 0 that is not a comment/blank), which bounds the map.
  const patchesIdx = lines.findIndex((l) => /^patches:\s*$/.test(l));
  if (patchesIdx === -1) {
    console.warn(`  [warn] no \`patches:\` section in ccpatch.yml — skipping manifest registration`);
    return 'missing';
  }
  let endIdx = lines.length;
  for (let i = patchesIdx + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i])) { endIdx = i; break; }
  }
  // Back up past trailing blank lines AND any contiguous comment block that
  // precedes the next top-level key — that block (e.g. the `# Profiles —` banner)
  // documents the FOLLOWING section, not the patches map, so we must insert
  // before it to keep the new entry attached to the map and the banner intact.
  let insertAt = endIdx;
  while (
    insertAt > patchesIdx + 1 &&
    (lines[insertAt - 1].trim() === '' || /^\s*#/.test(lines[insertAt - 1]))
  ) {
    insertAt--;
  }

  const entry = [
    '',
    '  # ── Scaffolded (disabled by default — flip to `true` to enable) ──────────────',
    `  ${name}: false           # TODO: describe what this patch does`,
  ];
  lines.splice(insertAt, 0, ...entry);
  fs.writeFileSync(MANIFEST_PATH, lines.join('\n'), 'utf8');
  return 'wrote';
}

/**
 * Append a per-patch fixture stub to tests/fixtures/registry.mjs. The stub
 * returns `null` (= "no synthetic fixture available") so the author can
 * decide whether to write one. Idempotent: skips if `name:` already appears
 * in the FIXTURES map.
 */
function appendFixtureStub(name) {
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.warn(`  [warn] ${REGISTRY_PATH} not found — skipping fixture stub`);
    return false;
  }
  const src = fs.readFileSync(REGISTRY_PATH, 'utf8');
  // Idempotency: bail if a key for this patch already exists in FIXTURES.
  const keyRe = new RegExp(`^\\s*${name}\\s*:`, 'm');
  if (keyRe.test(src)) return false;
  if (!src.includes(REGISTRY_MARKER)) {
    console.warn(`  [warn] registry marker missing — skipping fixture stub`);
    return false;
  }
  const stub = `// ${name}: return null until a real anchor-bearing fragment is needed.\n  ${name}: () => null,\n  ${REGISTRY_MARKER}`;
  const next = src.replace(REGISTRY_MARKER, stub);
  fs.writeFileSync(REGISTRY_PATH, next, 'utf8');
  return true;
}

const invokedFromCli = (() => {
  try { return import.meta.url === new URL(`file://${path.resolve(process.argv[1] || '')}`).href; }
  catch { return false; }
})();
if (invokedFromCli) process.exit(main());

export { main as runScaffoldCli, parseArgs, TEMPLATES };
