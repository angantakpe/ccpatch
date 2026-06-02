import { readFileSync } from 'node:fs';
import { firstOffsetOf } from './runner/ast-anchor.mjs';

const code = readFileSync('storage/archives/claude-code-v2.1.159/cli.v2.1.159.cjs', 'utf8');

// Extract candidate named-function specs: real `function NAME(` names in bundle,
// plus some that don't exist, plus tricky substrings.
const names = new Set();
const re = /function ([A-Za-z_$][A-Za-z0-9_$]*)\(/g;
let m, c = 0;
while ((m = re.exec(code)) !== null && c < 20000) { names.add(m[1]); c++; }
// Add some non-existent / edge names.
for (const n of ['__definitely_not_here__', 'zzzNope', 'x', 'a', 'process', 'require']) names.add(n);

let tested = 0, mism = 0;
for (const spec of names) {
  const needle = `function ${spec}(`;
  const a = code.indexOf(needle);           // OLD path
  const b = firstOffsetOf(code, needle);    // NEW path
  tested++;
  if (a !== b) { mism++; if (mism <= 5) console.log('MISMATCH', spec, a, b); }
  // Call twice to exercise memoization returning same value.
  if (firstOffsetOf(code, needle) !== b) { mism++; console.log('NONDET', spec); }
}
console.log(`tested=${tested} mismatches=${mism}`);
