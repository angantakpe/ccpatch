#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// verify-bundle-sha.mjs — supply-chain integrity gate for the Claude Code bundle
//
// The npm wrapper package (@anthropic-ai/claude-code) and the platform binary
// (@anthropic-ai/claude-code-<os>-<arch>) are downloaded with NO checksum
// verification. The file that actually gets patched is the extracted cli.js
// (storage/archives/claude-code-v<ver>/cli.v<ver>.cjs, or an --input override).
// This script computes that file's sha256 and gates it against a pinned
// registry (storage/known-shas.json) BEFORE any patching happens.
//
// Policy:
//   - KNOWN version + sha MATCH    -> exit 0 (proceed)
//   - KNOWN version + sha MISMATCH -> FAIL CLOSED, exit 1 (loud error)
//   - UNKNOWN version (not pinned) -> TOFU warning, exit 0 (new versions still work)
//   - CCPATCH_SKIP_SHA_CHECK=1     -> intentional bypass, exit 0 (loud warning)
//
// Usage:
//   node scripts/verify-bundle-sha.mjs <cli.js> --version <x.y.z>
//        [--registry storage/known-shas.json]
//        [--expect-sha256 <hex>]   # out-of-band pin, overrides registry lookup
//        [--tarball <file.tgz> --tarball-integrity <sha512-...>]  # optional npm integrity check
//
// Exit codes: 0 = OK / proceed, 1 = integrity failure (fail closed), 2 = usage error.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';

const SKIP = process.env.CCPATCH_SKIP_SHA_CHECK === '1';

function fail(msg) {
  process.stderr.write(`\n\x1b[1;31m[verify-bundle-sha] INTEGRITY FAILURE\x1b[0m\n${msg}\n\n`);
  process.exit(1);
}
function usage(msg) {
  process.stderr.write(`[verify-bundle-sha] ${msg}\n` +
    `usage: node scripts/verify-bundle-sha.mjs <cli.js> --version <x.y.z> ` +
    `[--registry <path>] [--expect-sha256 <hex>] [--tarball <tgz> --tarball-integrity <sha512-...>]\n`);
  process.exit(2);
}
function warn(msg) { process.stderr.write(`\x1b[1;33m[verify-bundle-sha] ${msg}\x1b[0m\n`); }
function info(msg) { process.stderr.write(`[verify-bundle-sha] ${msg}\n`); }

// ── parse args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let target = null, version = null, registryPath = 'storage/known-shas.json';
let expectSha256 = null, tarball = null, tarballIntegrity = null, tarballOnly = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--version') version = argv[++i];
  else if (a.startsWith('--version=')) version = a.slice('--version='.length);
  else if (a === '--registry') registryPath = argv[++i];
  else if (a.startsWith('--registry=')) registryPath = a.slice('--registry='.length);
  else if (a === '--expect-sha256') expectSha256 = argv[++i];
  else if (a.startsWith('--expect-sha256=')) expectSha256 = a.slice('--expect-sha256='.length);
  else if (a === '--tarball') tarball = argv[++i];
  else if (a.startsWith('--tarball=')) tarball = a.slice('--tarball='.length);
  else if (a === '--tarball-integrity') tarballIntegrity = argv[++i];
  else if (a.startsWith('--tarball-integrity=')) tarballIntegrity = a.slice('--tarball-integrity='.length);
  else if (a === '--tarball-only') tarballOnly = true;
  else if (!a.startsWith('-') && !target) target = a;
  else usage(`unexpected argument: ${a}`);
}

// In --tarball-only mode we only verify the downloaded tarball against the npm
// registry integrity; there is no cli.js bundle to hash/compare yet.
if (!tarballOnly) {
  if (!target) usage('missing <cli.js> target path.');
  target = resolve(target);
  if (!existsSync(target)) fail(`target bundle not found: ${target}`);
}

// ── hash the bundle ─────────────────────────────────────────────────────────
function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
const computed = tarballOnly ? null : sha256Of(target);
const size = tarballOnly ? null : statSync(target).size;

// ── optional: verify downloaded tarball against npm registry integrity (sha512) ─
// npm's `npm pack --json` emits an authoritative `integrity` field straight from
// the registry. Verifying the tarball against it is a cheap primary check that
// the download wasn't tampered with in transit.
async function streamSha512Base64(path) {
  return await new Promise((res, rej) => {
    const h = createHash('sha512');
    createReadStream(path).on('data', d => h.update(d)).on('end', () => res(h.digest('base64'))).on('error', rej);
  });
}
async function verifyTarball() {
  if (!tarball && !tarballIntegrity) return;
  if (!tarball || !tarballIntegrity) usage('--tarball and --tarball-integrity must be given together.');
  if (!existsSync(tarball)) fail(`tarball not found: ${tarball}`);
  const m = /^sha512-(.+)$/.exec(tarballIntegrity.trim());
  if (!m) {
    if (SKIP) { warn(`tarball-integrity not in sha512-<base64> form; skipping (CCPATCH_SKIP_SHA_CHECK=1).`); return; }
    fail(`--tarball-integrity must be a Subresource-Integrity 'sha512-<base64>' string (got: ${tarballIntegrity.slice(0, 24)}…).`);
  }
  const want = m[1];
  const got = await streamSha512Base64(tarball);
  if (got !== want) {
    if (SKIP) { warn(`tarball integrity MISMATCH but CCPATCH_SKIP_SHA_CHECK=1 set — proceeding.`); return; }
    fail(`npm tarball integrity MISMATCH for ${tarball}\n` +
      `  registry sha512: ${want.slice(0, 32)}…\n` +
      `  computed sha512: ${got.slice(0, 32)}…\n` +
      `  The downloaded tarball does not match the npm registry. Refusing to proceed.`);
  }
  info(`npm tarball integrity OK (sha512 matches registry).`);
}

// ── registry lookup + the core gate ──────────────────────────────────────────
function loadRegistry(path) {
  const p = resolve(path);
  if (!existsSync(p)) {
    warn(`registry not found at ${p} — treating all versions as UNKNOWN (TOFU).`);
    return { versions: {} };
  }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return { versions: j.versions || {}, _path: p };
  } catch (err) {
    fail(`registry ${p} is not valid JSON: ${err.message}`);
  }
}

function pinHint() {
  return `  To pin this version, add to ${registryPath} under "versions":\n` +
    `    "${version || '<x.y.z>'}": {\n` +
    `      "cliSha256": "${computed}",\n` +
    `      "sizeBytes": ${size},\n` +
    `      "source": "describe origin (npm cli.cjs | bun-native)"\n` +
    `    }`;
}

async function main() {
  await verifyTarball();

  if (tarballOnly) { return done(); }

  // Out-of-band pin always wins — it's the strongest signal (authenticity, not
  // just integrity), mirroring the third-party `--expect-sha256` path.
  if (expectSha256) {
    if (!/^[0-9a-f]{64}$/i.test(expectSha256)) usage('--expect-sha256 must be a 64-char hex sha256.');
    if (computed.toLowerCase() !== expectSha256.toLowerCase()) {
      if (SKIP) { warn(`--expect-sha256 MISMATCH but CCPATCH_SKIP_SHA_CHECK=1 set — proceeding.`); return done(); }
      fail(`--expect-sha256 MISMATCH for ${target}\n` +
        `  expected: ${expectSha256}\n` +
        `  computed: ${computed}\n` +
        `  Refusing to patch a bundle that does not match the out-of-band pin.`);
    }
    info(`bundle sha256 OK (verified against out-of-band --expect-sha256): ${computed}`);
    return done();
  }

  if (!version) usage('missing --version (needed for registry lookup).');

  const { versions } = loadRegistry(registryPath);
  const pinned = versions[version];

  if (!pinned) {
    // TOFU: unknown/new version — warn loudly, but proceed so new versions work.
    warn(`UNKNOWN version v${version} — no pinned sha in ${registryPath} (Trust On First Use).`);
    warn(`  computed sha256: ${computed}  (${size} bytes)`);
    if (SKIP) warn(`  CCPATCH_SKIP_SHA_CHECK=1 set.`);
    process.stderr.write(pinHint() + '\n');
    warn(`Proceeding (new version). Pin the sha above once you trust this bundle.`);
    return done();
  }

  const want = String(pinned.cliSha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) fail(`registry entry for v${version} has no valid cliSha256.`);

  if (computed.toLowerCase() !== want) {
    if (SKIP) {
      warn(`sha256 MISMATCH for KNOWN v${version} but CCPATCH_SKIP_SHA_CHECK=1 set — proceeding UNSAFELY.`);
      warn(`  expected: ${want}`);
      warn(`  computed: ${computed}`);
      return done();
    }
    fail(`sha256 MISMATCH for KNOWN version v${version}\n` +
      `  bundle:   ${target}\n` +
      `  expected: ${want}  (pinned in ${registryPath})\n` +
      `  computed: ${computed}  (${size} bytes)\n` +
      `  This bundle does NOT match the known-good upstream for v${version}.\n` +
      `  It may have been modified or tampered with. Refusing to patch.\n` +
      `  If this is an intentional re-pin, update ${registryPath}, or bypass with\n` +
      `  CCPATCH_SKIP_SHA_CHECK=1 (NOT recommended).`);
  }

  info(`bundle sha256 OK for v${version} (matches pinned registry): ${computed}`);
  return done();
}

function done() {
  if (SKIP) warn(`NOTE: CCPATCH_SKIP_SHA_CHECK=1 — integrity gate was in bypass mode.`);
  process.exit(0);
}

main().catch(err => fail(err.stack || String(err)));
