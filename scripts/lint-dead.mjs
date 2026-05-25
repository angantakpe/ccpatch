#!/usr/bin/env node
/**
 * lint-dead — run tsc --checkJs and report only dead-code findings.
 *
 * checkJs surfaces both dead-code diagnostics AND general type-shape errors
 * (ESTree narrowing, dynamic object access, etc.). For a pure-JS codebase we
 * only want the former. This wrapper runs tsc, filters output to dead-code
 * TS codes, and exits non-zero only if any survive.
 *
 * Dead-code codes (TS):
 *   TS6133  declared but value never read   (locals, imports, params)
 *   TS6138  property declared but never read
 *   TS6192  all imports in import declaration are unused
 *   TS6196  declared but never used
 *   TS6205  all destructured elements unused
 *   TS6385  deprecated symbol used  (kept for visibility)
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const DEAD_CODES = ['TS6133', 'TS6138', 'TS6192', 'TS6196', 'TS6205'];
const CODE_RE = new RegExp(`\\b(${DEAD_CODES.join('|')})\\b`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tscBin = path.resolve(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc');
if (!fs.existsSync(tscBin)) {
  console.error('lint-dead: typescript is not installed (run `npm install`)');
  process.exit(2);
}

const result = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

const lines = (result.stdout || '').split('\n').filter(Boolean);
const dead = lines.filter((l) => CODE_RE.test(l));

if (dead.length === 0) {
  console.log('lint-dead: clean (0 dead-code findings)');
  process.exit(0);
}

const byCode = {};
for (const line of dead) {
  const m = line.match(CODE_RE);
  const code = m ? m[1] : 'OTHER';
  (byCode[code] = byCode[code] || []).push(line);
}

console.log(`lint-dead: ${dead.length} finding${dead.length === 1 ? '' : 's'}\n`);
for (const code of Object.keys(byCode).sort()) {
  console.log(`── ${code} (${byCode[code].length}) ──`);
  for (const line of byCode[code]) console.log('  ' + line);
  console.log('');
}
process.exit(1);
