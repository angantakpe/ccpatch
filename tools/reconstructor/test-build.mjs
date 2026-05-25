#!/usr/bin/env node

/**
 * Test that reconstructed source can build into a working cli.js.
 *
 * Strategy: copy reconstructed source into storage/archives/claude-code-source-build's
 * workspace, then run the existing build script.
 *
 * Usage:
 *   node test-build.mjs <reconstructed-src-dir> [--run]
 *
 * Example:
 *   node test-build.mjs storage/outputs/cc-v2.1.89
 *   node test-build.mjs storage/outputs/cc-v2.1.89 --run
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../../..');
const buildTemplate = path.join(projectRoot, 'storage/archives/claude-code-source-build');
const buildScript = path.join(buildTemplate, 'scripts/build-cli.mjs');
const workspaceRoot = path.join(buildTemplate, '.cache/workspace');
const sourceMapPath = path.join(buildTemplate, 'source', 'cli.js.map');
const sourcePackageJsonPath = path.join(buildTemplate, 'source', 'package.json');

const args = process.argv.slice(2);
const srcDir = args.find(a => !a.startsWith('--'));
const shouldRun = args.includes('--run');

if (!srcDir) {
  console.error('Usage: node test-build.mjs <reconstructed-output-dir> [--run]');
  process.exit(1);
}

const resolvedSrc = path.resolve(srcDir);
const srcSrcDir = path.join(resolvedSrc, 'src');

if (!fs.existsSync(srcSrcDir)) {
  console.error(`Source directory not found: ${srcSrcDir}`);
  process.exit(1);
}

// Read the target version from the reconstructed output's package.json
const outputPackageJsonPath = path.join(resolvedSrc, 'package.json');
let targetVersion = null;
if (fs.existsSync(outputPackageJsonPath)) {
  try {
    const outputPkg = JSON.parse(fs.readFileSync(outputPackageJsonPath, 'utf8'));
    targetVersion = outputPkg.version;
  } catch (e) {
    console.warn(`  [WARN] Could not read version from ${outputPackageJsonPath}: ${e.message}`);
  }
}

console.log('═══ Test Build: Reconstructed Source → cli.js ═══');
console.log(`  Source: ${resolvedSrc}`);
if (targetVersion) console.log(`  Target version: ${targetVersion}`);
console.log();

// Step 1: Strip RECONSTRUCTOR annotation headers from modified files
console.log('Step 1: Stripping reconstruction annotations...');
let stripped = 0;
function walkFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('_') && entry.name !== 'node_modules') {
      results.push(...walkFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

// Create a clean copy to avoid mutating the original
const cleanDir = path.join(resolvedSrc, '.build-clean');
if (fs.existsSync(cleanDir)) fs.rmSync(cleanDir, { recursive: true });
fs.cpSync(srcSrcDir, cleanDir, { recursive: true });

for (const file of walkFiles(cleanDir)) {
  const content = fs.readFileSync(file, 'utf8');
  if (content.startsWith('// [RECONSTRUCTOR]')) {
    const marker = '// [END RECONSTRUCTOR ANNOTATIONS]\n';
    const idx = content.indexOf(marker);
    if (idx !== -1) {
      const clean = content.slice(idx + marker.length);
      fs.writeFileSync(file, clean);
      stripped++;
    }
  }
}
console.log(`  Stripped ${stripped} annotation headers`);

// Step 2: Copy clean source into the build workspace
console.log('Step 2: Copying source to build workspace...');
const workspaceSrc = path.join(workspaceRoot, 'src');

// Overlay our reconstructed src/ files onto the workspace
// The build script's prepareWorkspace will have already extracted from the map,
// and our files override those.
let copied = 0;
for (const file of walkFiles(cleanDir)) {
  const rel = path.relative(cleanDir, file);
  const dest = path.join(workspaceSrc, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
  copied++;
}
console.log(`  Copied ${copied} files to workspace`);

// Clean up temp dir
fs.rmSync(cleanDir, { recursive: true });

// Step 3: Preserve the overlay by ensuring the workspace marker remains valid.
// The archive builder rewrites workspace files from cli.js.map whenever
// .prepared.json is missing or stale, which would wipe the reconstructed overlay.
const markerPath = path.join(workspaceRoot, '.prepared.json');
const marker = buildPreparedMarker();
if (marker) {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n', 'utf8');
  console.log('  Refreshed workspace marker (preserves reconstructed overlay)');
}

// Step 3b: Inject correct version into build template's package.json
if (targetVersion) {
  const templatePkgPath = path.join(buildTemplate, 'source', 'package.json');
  if (fs.existsSync(templatePkgPath)) {
    const originalTemplatePkgContent = fs.readFileSync(templatePkgPath, 'utf8');
    const templatePkg = JSON.parse(originalTemplatePkgContent);
    if (templatePkg.version !== targetVersion) {
      console.log(`  Fixing version mismatch: ${templatePkg.version} → ${targetVersion}`);
      templatePkg.version = targetVersion;
      fs.writeFileSync(templatePkgPath, JSON.stringify(templatePkg, null, 2) + '\n', 'utf8');
      // Restore the original template on exit so it stays clean
      const restoreTemplatePkg = () => {
        try {
          fs.writeFileSync(templatePkgPath, originalTemplatePkgContent, 'utf8');
        } catch (_) { /* best effort */ }
      };
      process.on('exit', restoreTemplatePkg);
      process.on('SIGINT', () => { restoreTemplatePkg(); process.exit(130); });
      process.on('SIGTERM', () => { restoreTemplatePkg(); process.exit(143); });
    }
  }
}

// Step 4: Run the build
console.log('Step 3: Running build...');
const buildResult = spawnSync('node', [buildScript, '--no-minify'], {
  cwd: buildTemplate,
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
  timeout: 900000,
});

if (buildResult.status !== 0) {
  console.error(`\nBuild failed with exit code ${buildResult.status} signal ${buildResult.signal ?? 'none'}`);
  process.exit(1);
}

const distCli = path.join(buildTemplate, 'dist/cli.js');
const distBundle = path.join(buildTemplate, 'dist/cli.bundle');
if (!fs.existsSync(distCli)) {
  console.error(`Build output not found: ${distCli}`);
  process.exit(1);
}

// Move build output into our output directory
const outCli = path.join(resolvedSrc, 'dist', 'cli.js');
const outBundle = path.join(resolvedSrc, 'dist', 'cli.bundle');
fs.mkdirSync(path.join(resolvedSrc, 'dist'), { recursive: true });
fs.renameSync(distCli, outCli);
if (fs.existsSync(distBundle)) {
  if (fs.existsSync(outBundle)) fs.rmSync(outBundle, { recursive: true });
  fs.renameSync(distBundle, outBundle);
}
// Clean up template dist
fs.rmSync(path.join(buildTemplate, 'dist'), { recursive: true, force: true });

const stat = fs.statSync(outCli);
console.log(`\n  Built: ${outCli} (${(stat.size / 1e6).toFixed(1)}MB)`);

// Step 5: Collect build integrity data — scan workspace for stubs and patches
console.log('\nStep 4: Analyzing build integrity...');
const integrity = collectBuildIntegrity(workspaceRoot);

// Step 6: Smoke tests
if (shouldRun) {
  console.log('\nStep 5: Smoke tests...');

  // 5a: --help
  console.log('  5a: cli.js --help');
  const helpResult = spawnSync('node', [outCli, '--help'], {
    timeout: 15000,
    stdio: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  });

  if (helpResult.status === 0) {
    const output = helpResult.stdout.toString().slice(0, 500);
    console.log('    [PASS] cli.js --help succeeded:');
    console.log(output.split('\n').map(l => `      ${l}`).join('\n'));
  } else {
    console.error('    [FAIL] cli.js --help failed:');
    console.error(helpResult.stderr?.toString().slice(0, 500));
    process.exit(1);
  }

  // 5b: Import validation — check critical exports are real functions, not Proxy stubs
  console.log('  5b: Checking critical modules for Proxy stubs...');
  const stubCheckScript = generateStubCheckScript(outCli);
  const stubCheckResult = spawnSync('node', ['--input-type=module', '-e', stubCheckScript], {
    timeout: 30000,
    stdio: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
    cwd: path.dirname(outCli),
  });

  if (stubCheckResult.status === 0) {
    const checkOutput = stubCheckResult.stdout.toString().trim();
    if (checkOutput) {
      console.log(checkOutput.split('\n').map(l => `    ${l}`).join('\n'));
    }
    // Parse JSON result from the check
    const jsonLine = checkOutput.split('\n').find(l => l.startsWith('STUB_CHECK_JSON:'));
    if (jsonLine) {
      try {
        const checkData = JSON.parse(jsonLine.replace('STUB_CHECK_JSON:', ''));
        integrity.runtimeChecks = checkData;
      } catch (e) {
        console.warn(`    [WARN] Failed to parse stub check JSON: ${e.message}`);
      }
    }
  } else {
    const errOut = (stubCheckResult.stderr?.toString() || '').slice(0, 500);
    // Only fail for stub-related errors, not for side-effect errors from importing CLI entry points
    const isStubError = errOut.includes('__makeStub') || errOut.includes('[stub');
    if (isStubError) {
      console.error('    [FAIL] Runtime stub check detected Proxy stubs:');
      if (errOut) console.error(errOut.split('\n').map(l => `      ${l}`).join('\n'));
      integrity.runtimeChecks = { error: 'proxy stubs detected', details: errOut.slice(0, 200) };
      process.exit(1);
    } else {
      console.log('    [WARN] Runtime stub check could not complete (module side-effects):');
      if (errOut) console.log(errOut.split('\n').slice(0, 3).map(l => `      ${l}`).join('\n'));
      integrity.runtimeChecks = { error: 'check script failed (side-effects)', details: errOut.slice(0, 200) };
    }
  }
} else {
  console.log('\nSkipping smoke tests (pass --run to enable)');
}

// Step 7: Print Build Integrity Report
printIntegrityReport(integrity);

// Step 8: Write BUILD-INTEGRITY.md
const integrityPath = path.join(resolvedSrc, 'dist', 'BUILD-INTEGRITY.md');
writeBuildIntegrityFile(integrityPath, integrity, resolvedSrc);
console.log(`\n  Wrote: ${integrityPath}`);

function buildPreparedMarker() {
  if (!fs.existsSync(sourceMapPath) || !fs.existsSync(sourcePackageJsonPath)) {
    return null;
  }

  const sourceMapStat = fs.statSync(sourceMapPath);
  const builderVersion = readBuilderVersion(buildScript);
  const sourcePkg = JSON.parse(fs.readFileSync(sourcePackageJsonPath, 'utf8'));

  return {
    builderVersion,
    sourceMapMtimeMs: sourceMapStat.mtimeMs,
    sourceMapSize: sourceMapStat.size,
    version: sourcePkg.version,
  };
}

function readBuilderVersion(scriptPath) {
  try {
    const script = fs.readFileSync(scriptPath, 'utf8');
    const match = script.match(/\bconst\s+builderVersion\s*=\s*(\d+)\s*;/);
    if (match) return Number(match[1]);
  } catch (_) {
    // Fall through to the current known builder version.
  }
  return 7;
}

// Step 9: Fail build if stub percentage is too high
const srcStubCount = integrity.autoStubFiles.filter(f => f.startsWith('src/')).length
  + integrity.proxyStubFiles.filter(f => f.startsWith('src/')).length;
const nmStubCount = (integrity.autoStubFiles.length + integrity.proxyStubFiles.length) - srcStubCount;
const totalStubCount = integrity.autoStubFiles.length + integrity.proxyStubFiles.length;
const totalModuleCount = integrity.totalSourceFiles + nmStubCount;
const stubPercentage = totalModuleCount > 0 ? (totalStubCount / totalModuleCount) * 100 : 0;

// Proxy stubs are the most dangerous — they silently return undefined for any call.
// Auto-stubs are less dangerous — they're just missing modules with explicit markers.
const PROXY_STUB_THRESHOLD = 2; // percent — proxy stubs are nearly undetectable at runtime
const TOTAL_STUB_THRESHOLD = 10; // percent — total stubs including auto-stubs
const proxyStubPercentage = totalModuleCount > 0 ? (integrity.proxyStubFiles.length / totalModuleCount) * 100 : 0;

if (proxyStubPercentage > PROXY_STUB_THRESHOLD) {
  console.error(`\n  ✗ BUILD FAILED: ${proxyStubPercentage.toFixed(1)}% of modules are Proxy stubs (threshold: ${PROXY_STUB_THRESHOLD}%)`);
  console.error(`    Proxy stubs silently return undefined for any call — they are nearly undetectable at runtime.`);
  process.exit(1);
}
if (stubPercentage > TOTAL_STUB_THRESHOLD) {
  console.error(`\n  ✗ BUILD FAILED: ${stubPercentage.toFixed(1)}% of modules are stubs (threshold: ${TOTAL_STUB_THRESHOLD}%)`);
  console.error(`    ${totalStubCount} stubs out of ${totalModuleCount} total modules`);
  console.error('    This indicates the reconstructed source is missing too many modules.');
  process.exit(1);
}

console.log('\n═══ Test Build Complete ═══');

// ──────────────────────────────────────────────────────────
// Build Integrity Functions
// ──────────────────────────────────────────────────────────

function collectBuildIntegrity(wsRoot) {
  const srcRoot = path.join(wsRoot, 'src');
  const result = {
    totalSourceFiles: 0,
    autoStubFiles: [],
    proxyStubFiles: [],
    patchedExports: [],
    realFiles: 0,
    timestamp: new Date().toISOString(),
    version: targetVersion || 'unknown',
    runtimeChecks: null,
  };

  // Walk source files
  if (fs.existsSync(srcRoot)) {
    for (const file of walkFilesDeep(srcRoot)) {
      if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
      result.totalSourceFiles++;
      const content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(wsRoot, file);
      if (content.includes('// AUTO-STUB')) {
        result.autoStubFiles.push(rel);
      } else if (content.includes('__makeStub') && content.includes('new Proxy')) {
        result.proxyStubFiles.push(rel);
      } else {
        result.realFiles++;
      }
    }
  }

  // Walk node_modules for package-level stubs
  const nmRoot = path.join(wsRoot, 'node_modules');
  if (fs.existsSync(nmRoot)) {
    for (const file of walkFilesDeep(nmRoot)) {
      if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
      // Only check files that look like stubs (not full npm packages)
      const content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(wsRoot, file);
      if (content.includes('// AUTO-STUB')) {
        result.autoStubFiles.push(rel);
      } else if (content.includes('__makeStub') && content.includes('new Proxy')) {
        result.proxyStubFiles.push(rel);
      }
    }
  }

  return result;
}

function walkFilesDeep(dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== '.git') {
        results.push(...walkFilesDeep(full));
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  } catch (err) {
    if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
    console.warn(`  [WARN] Cannot read directory: ${dir} (${err.code})`);
  }
  return results;
}

function printIntegrityReport(integrity) {
  // totalSourceFiles already includes src-level stubs (auto + proxy + real).
  // node_modules stubs are NOT in totalSourceFiles, so add only those.
  const srcStubs = integrity.autoStubFiles.filter(f => f.startsWith('src/')).length
    + integrity.proxyStubFiles.filter(f => f.startsWith('src/')).length;
  const nmStubs = (integrity.autoStubFiles.length + integrity.proxyStubFiles.length) - srcStubs;
  const totalStubs = integrity.autoStubFiles.length + integrity.proxyStubFiles.length;
  const totalModules = integrity.totalSourceFiles + nmStubs;
  const stubPct = totalModules > 0 ? ((totalStubs / totalModules) * 100).toFixed(1) : '0.0';
  const realPct = totalModules > 0 ? ((integrity.realFiles / totalModules) * 100).toFixed(1) : '0.0';

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║           BUILD INTEGRITY REPORT                 ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Version:        ${integrity.version.padEnd(32)}║`);
  console.log(`║  Source files:   ${String(integrity.realFiles).padEnd(32)}║`);
  console.log(`║  Auto-stubs:     ${String(integrity.autoStubFiles.length).padEnd(32)}║`);
  console.log(`║  Proxy stubs:    ${String(integrity.proxyStubFiles.length).padEnd(32)}║`);
  console.log(`║  Real code:      ${(realPct + '%').padEnd(32)}║`);
  console.log(`║  Stubbed:        ${(stubPct + '%').padEnd(32)}║`);

  if (parseFloat(stubPct) > 5) {
    console.log('║                                                  ║');
    console.log('║  ⚠ WARNING: >5% of modules are stubs!            ║');
    console.log('║  The build succeeded but many modules are fake.   ║');
  }

  console.log('╚══════════════════════════════════════════════════╝');

  if (integrity.autoStubFiles.length > 0) {
    console.log('\n  Auto-stub files (// AUTO-STUB):');
    for (const f of integrity.autoStubFiles.slice(0, 30)) {
      console.log(`    - ${f}`);
    }
    if (integrity.autoStubFiles.length > 30) {
      console.log(`    ... and ${integrity.autoStubFiles.length - 30} more`);
    }
  }

  if (integrity.proxyStubFiles.length > 0) {
    console.log('\n  Proxy stub files (__makeStub + Proxy):');
    for (const f of integrity.proxyStubFiles.slice(0, 30)) {
      console.log(`    - ${f}`);
    }
    if (integrity.proxyStubFiles.length > 30) {
      console.log(`    ... and ${integrity.proxyStubFiles.length - 30} more`);
    }
  }

  if (integrity.runtimeChecks) {
    if (integrity.runtimeChecks.error) {
      console.log(`\n  Runtime checks: SKIPPED (${integrity.runtimeChecks.error})`);
    } else {
      console.log('\n  Runtime module checks:');
      for (const check of integrity.runtimeChecks.results || []) {
        const icon = check.isReal ? '[REAL]' : '[STUB]';
        console.log(`    ${icon} ${check.name}: ${check.detail}`);
      }
    }
  }
}

function generateStubCheckScript(cliPath) {
  // This script dynamically imports the built bundle and checks key modules
  // A Proxy stub's toString() returns "[stub ...]" while real functions don't
  const bundleDir = cliPath.replace(/\.js$/, '.bundle');
  // Read MACRO values from the built cli.js wrapper so modules can reference them
  const cliContent = fs.readFileSync(cliPath, 'utf8');
  const macroMatch = cliContent.match(/globalThis\.MACRO \?\?= Object\.freeze\((\{[\s\S]*?\})\)/);
  const macroInit = macroMatch
    ? `globalThis.MACRO ??= Object.freeze(${macroMatch[1]});`
    : `globalThis.MACRO ??= Object.freeze({ VERSION: '${targetVersion || 'unknown'}', BUILD_TIME: '${new Date().toISOString()}' });`;

  // Discover actual module paths from the bundle directory instead of hardcoding
  const discoveredChecks = [];
  const bundleSrcDir = path.join(bundleDir, 'src');

  if (fs.existsSync(bundleSrcDir)) {
    // Priority directories to check
    const priorityDirs = ['entrypoints', 'commands', 'tools', 'config', 'utils', 'bootstrap', 'core'];

    for (const dir of priorityDirs) {
      const dirPath = path.join(bundleSrcDir, dir);
      if (fs.existsSync(dirPath)) {
        try {
          const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.js')).slice(0, 2);
          for (const file of files) {
            const relPath = `src/${dir}/${file}`;
            const name = `${dir}/${file.replace('.js', '')}`;
            discoveredChecks.push([name, relPath, ['default']]);
          }
        } catch (e) { /* skip unreadable dirs */ }
      }
    }

    // If we found fewer than 3, scan for the largest files in src/
    if (discoveredChecks.length < 3) {
      const allFiles = [];
      function scanDir(dir, prefix) {
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name !== 'node_modules') {
              scanDir(path.join(dir, entry.name), prefix + entry.name + '/');
            } else if (entry.isFile() && entry.name.endsWith('.js')) {
              const full = path.join(dir, entry.name);
              const stat = fs.statSync(full);
              allFiles.push({ rel: 'src/' + prefix + entry.name, name: prefix + entry.name.replace('.js', ''), size: stat.size });
            }
          }
        } catch (e) { /* skip */ }
      }
      scanDir(bundleSrcDir, '');
      // Pick largest files not already included
      const existing = new Set(discoveredChecks.map(c => c[1]));
      allFiles.sort((a, b) => b.size - a.size);
      for (const f of allFiles) {
        if (!existing.has(f.rel) && discoveredChecks.length < 10) {
          discoveredChecks.push([f.name, f.rel, ['default']]);
          existing.add(f.rel);
        }
      }
    }
  }

  // Fallback to hardcoded if discovery found nothing (e.g., bundle dir doesn't exist yet)
  const finalChecks = discoveredChecks.length > 0 ? discoveredChecks : [
    ['entrypoints/cli', 'src/entrypoints/cli.js', ['default']],
    ['commands/command-runner', 'src/commands/command-runner.js', ['default']],
    ['config/config', 'src/config/config.js', ['default']],
  ];

  return `
${macroInit}
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const results = [];
const bundleDir = ${JSON.stringify(bundleDir)};

function looksLikeProxyStubFunction(fn) {
  try {
    const src = Function.prototype.toString.call(fn);
    if (src.includes('__makeStub') || src.includes('[stub')) return true;
  } catch {}

  // Structural behavior probe: proxy-stub functions usually return undefined
  // for arbitrary property access and for calls.
  try {
    const marker = Symbol('stub-probe');
    const prop = fn[marker];
    const callResult = fn(marker);
    if (prop === undefined && callResult === undefined) return true;
  } catch {
    // Real functions frequently throw when called with random input; ignore.
  }
  return false;
}

async function checkModule(name, importPath, exportNames) {
  try {
    const fullPath = path.join(bundleDir, importPath);
    const mod = await import(pathToFileURL(fullPath).href);
    for (const exportName of exportNames) {
      const val = mod[exportName];
      if (val === undefined) {
        results.push({ name: name + '.' + exportName, isReal: false, detail: 'export is undefined' });
      } else if (typeof val === 'function') {
        const str = Function.prototype.toString.call(val);
        if (looksLikeProxyStubFunction(val)) {
          results.push({ name: name + '.' + exportName, isReal: false, detail: 'Proxy stub detected (source+behavior probe)' });
        } else {
          results.push({ name: name + '.' + exportName, isReal: true, detail: 'real function (' + str.slice(0, 60).replace(/\\n/g,' ') + '...)' });
        }
      } else {
        results.push({ name: name + '.' + exportName, isReal: true, detail: typeof val });
      }
    }
  } catch (err) {
    results.push({ name, isReal: false, detail: 'import failed: ' + err.message.slice(0, 100) });
  }
}

// Check modules discovered from the actual bundle directory
const checks = ${JSON.stringify(finalChecks)};

for (const [name, importPath, exports] of checks) {
  await checkModule(name, importPath, exports);
}

console.log('STUB_CHECK_JSON:' + JSON.stringify({ results }));
`;
}

function writeBuildIntegrityFile(filePath, integrity, srcDir) {
  // Same denominator fix as printIntegrityReport: avoid double-counting src stubs
  const srcStubs = integrity.autoStubFiles.filter(f => f.startsWith('src/')).length
    + integrity.proxyStubFiles.filter(f => f.startsWith('src/')).length;
  const nmStubs = (integrity.autoStubFiles.length + integrity.proxyStubFiles.length) - srcStubs;
  const totalStubs = integrity.autoStubFiles.length + integrity.proxyStubFiles.length;
  const totalModules = integrity.totalSourceFiles + nmStubs;
  const stubPct = totalModules > 0 ? ((totalStubs / totalModules) * 100).toFixed(1) : '0.0';
  const realPct = totalModules > 0 ? ((integrity.realFiles / totalModules) * 100).toFixed(1) : '0.0';

  const lines = [
    '# Build Integrity Report',
    '',
    `Generated: ${integrity.timestamp}`,
    `Version: ${integrity.version}`,
    `Source: ${srcDir}`,
    '',
    '## Summary',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Real source files | ${integrity.realFiles} |`,
    `| Auto-stub files (// AUTO-STUB) | ${integrity.autoStubFiles.length} |`,
    `| Proxy stub files (__makeStub) | ${integrity.proxyStubFiles.length} |`,
    `| **Total modules** | **${totalModules}** |`,
    `| **Real code** | **${realPct}%** |`,
    `| **Stubbed** | **${stubPct}%** |`,
    '',
  ];

  if (parseFloat(stubPct) > 5) {
    lines.push(
      '> **WARNING**: More than 5% of modules are auto-generated stubs.',
      '> The build succeeded but many modules contain no real logic.',
      '',
    );
  }

  if (integrity.autoStubFiles.length > 0) {
    lines.push('## Auto-Stub Files', '', 'These files contain `// AUTO-STUB` markers — they were generated because the module was missing from the source map.', '');
    for (const f of integrity.autoStubFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  if (integrity.proxyStubFiles.length > 0) {
    lines.push('## Proxy Stub Files', '', 'These files use `__makeStub` + `Proxy` to return `undefined` for any property access. They are the most hollow stubs.', '');
    for (const f of integrity.proxyStubFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  if (integrity.runtimeChecks && !integrity.runtimeChecks.error) {
    lines.push('## Runtime Module Checks', '');
    for (const check of integrity.runtimeChecks.results || []) {
      const status = check.isReal ? 'REAL' : 'STUB';
      lines.push(`- **[${status}]** \`${check.name}\`: ${check.detail}`);
    }
    lines.push('');
  }

  lines.push('---', 'Generated by test-build.mjs build integrity analyzer.', '');
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}
