#!/usr/bin/env node

/**
 * Standalone beautifier for minified JavaScript files
 * Usage: node beautify.mjs <input> [output] [--no-lebab] [--fast]
 * 
 * Options:
 *   --no-lebab   Skip lebab transforms (much faster for large files)
 *   --fast       Skip lebab and use fast prettier settings
 */

import fs from 'node:fs';
import path from 'node:path';
import prettier from 'prettier';
import { transform as lebabTransform } from 'lebab';

const LEBAB_TRANSFORMS = [
  'let',
  'arrow',
  'arrow-return',
  'template',
  'obj-shorthand',
  'obj-method',
];

// Size threshold for lebab (1 MB) - lebab is very slow on large files
const LEBAB_SIZE_LIMIT = 1 * 1024 * 1024;

async function beautify(inputPath, outputPath, options = {}) {
  console.log(`Reading ${inputPath}...`);
  const code = fs.readFileSync(inputPath, 'utf-8');
  const sizeMB = code.length / 1024 / 1024;
  console.log(`  Size: ${sizeMB.toFixed(2)} MB`);

  let result = code;

  // Step 1: Lebab modernization (skip for large files or if --no-lebab)
  const skipLebab = options.noLebab || options.fast || code.length > LEBAB_SIZE_LIMIT;
  
  if (skipLebab) {
    if (code.length > LEBAB_SIZE_LIMIT && !options.noLebab && !options.fast) {
      console.log(`  Skipping lebab (file > ${LEBAB_SIZE_LIMIT / 1024 / 1024} MB - would be too slow)`);
      console.log(`  Use --no-lebab to skip explicitly or pass a smaller file`);
    } else {
      console.log(`  Skipping lebab (${options.fast ? '--fast mode' : '--no-lebab specified'})`);
    }
  } else {
    console.log('Modernizing with lebab...');
    const startTime = Date.now();
    try {
      const { code: modernized, warnings } = lebabTransform(result, LEBAB_TRANSFORMS);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (modernized && modernized !== result) {
        result = modernized;
        console.log(`  Lebab completed in ${elapsed}s`);
      }
      if (warnings?.length > 0) {
        console.log(`  Warnings: ${warnings.length}`);
      }
    } catch (e) {
      console.log(`  Lebab failed: ${e.message}`);
    }
  }

  // Step 2: Prettier formatting
  console.log('Formatting with prettier...');
  const prettierStart = Date.now();
  
  try {
    const prettierOptions = options.fast 
      ? {
          parser: 'babel',
          printWidth: 120,
          tabWidth: 2,
          singleQuote: true,
          semi: true,
        }
      : {
          parser: 'babel',
          printWidth: 100,
          tabWidth: 2,
          singleQuote: true,
          trailingComma: 'es5',
          semi: true,
          bracketSpacing: true,
          arrowParens: 'avoid',
        };
    
    result = await prettier.format(result, prettierOptions);
    const elapsed = ((Date.now() - prettierStart) / 1000).toFixed(1);
    console.log(`  Prettier completed in ${elapsed}s`);
  } catch (e) {
    console.log(`  Prettier failed: ${e.message}`);
    console.log('  Output will be unformatted');
  }

  // Write output
  fs.writeFileSync(outputPath, result);
  const outputSizeMB = result.length / 1024 / 1024;
  console.log(`\nDone! Written to: ${outputPath}`);
  console.log(`  Output size: ${outputSizeMB.toFixed(2)} MB`);
  
  if (outputSizeMB > sizeMB) {
    console.log(`  (File grew ${((outputSizeMB / sizeMB - 1) * 100).toFixed(0)}% due to formatting)`);
  }
}

// CLI
const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
const positional = args.filter(a => !a.startsWith('--'));

if (positional.length === 0 || flags.includes('--help')) {
  console.log(`
Beautify minified JavaScript files

Usage: node beautify.mjs <input.js> [output.js] [options]

Options:
  --no-lebab   Skip lebab transforms (faster, no ES5→ES6 conversion)
  --fast       Fast mode: skip lebab + simplified prettier config
  --help       Show this help

Notes:
  - Files > 1 MB automatically skip lebab (too slow)
  - For large files, use --fast for best performance
  - Output defaults to <input>.beautified.js

Examples:
  node beautify.mjs cli.js                      # Auto-skip lebab if large
  node beautify.mjs cli.js out.js --fast        # Fastest option
  node beautify.mjs small.js out.js             # Full beautification
`);
  process.exit(0);
}

const inputPath = path.resolve(positional[0]);
const defaultOutput = inputPath.replace(/(\.[^.]+)$/, '.beautified$1');
const outputPath = positional[1]
  ? path.resolve(positional[1])
  : defaultOutput !== inputPath ? defaultOutput : inputPath + '.beautified.js';

const options = {
  noLebab: flags.includes('--no-lebab'),
  fast: flags.includes('--fast'),
};

if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

beautify(inputPath, outputPath, options).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
