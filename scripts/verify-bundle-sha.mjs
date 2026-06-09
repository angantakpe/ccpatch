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
// Trust hierarchy (strongest signal wins; CCPATCH_SKIP_SHA_CHECK only ever
// waives the WEAKER checks, never an explicit operator pin):
//   1. --expect-sha256 (out-of-band operator pin) — STRONGEST. A mismatch here
//      ALWAYS fails closed, even with CCPATCH_SKIP_SHA_CHECK=1. An explicit pin
//      is an authenticity assertion the operator made by hand; an env var must
//      not be able to silently waive it.
//   2. KNOWN version + registry sha — match -> proceed; mismatch -> fail closed
//      (SKIP may waive this, loudly and unsafely).
//   3. UNKNOWN version (not pinned) — TOFU. Requires a tarball-integrity check
//      against the npm registry (see verifyTarball); if no --tarball-integrity
//      was supplied, fail closed (SKIP may waive it, loudly). When the tarball
//      ships package/cli.js (legacy releases), the on-disk bundle is BOUND to it
//      — its sha256 must equal the cli.js inside the verified tarball or we fail
//      closed. When the tarball ships only a native binary (modern releases),
//      the package is authenticated but the extracted bundle cannot be bound to
//      it; we proceed on first use and say so, recommending an --expect-sha256
//      pin for a strong guarantee. On success, a single TOFU notice; proceed so
//      new versions still work.
//
// Summary:
//   - --expect-sha256 MATCH        -> exit 0 (proceed)
//   - --expect-sha256 MISMATCH     -> FAIL CLOSED, exit 1 (NOT waivable by SKIP)
//   - KNOWN version + sha MATCH    -> exit 0 (proceed)
//   - KNOWN version + sha MISMATCH -> FAIL CLOSED, exit 1 (SKIP waives -> exit 0)
//   - UNKNOWN version, tarball OK  -> TOFU notice, exit 0
//   - UNKNOWN version, no tarball  -> FAIL CLOSED, exit 1 (SKIP waives -> exit 0)
//   - CCPATCH_SKIP_SHA_CHECK=1     -> waives the weaker checks only (loud warning)
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
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';

const SKIP = process.env.CCPATCH_SKIP_SHA_CHECK === '1';
// Loud stderr warning when the skip gate is armed — this runs unconditionally
// at startup so even tarball-only invocations are covered.
if (SKIP) {
  process.stderr.write(`\x1b[1;33m⚠ [verify-bundle-sha] integrity checks BYPASSED via env: CCPATCH_SKIP_SHA_CHECK\x1b[0m\n`);
}

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

// Walk a (already-gunzipped) tar buffer and return the raw bytes of `entryName`,
// or null if it isn't present. Minimal ustar reader: 512-byte header blocks, file
// size at octal offset 124..135, content padded to the next 512-byte boundary.
// Enough for an npm pack tarball (regular files only, names well under 100 chars).
function readTarEntry(buf, entryName) {
  let off = 0;
  while (off + 512 <= buf.length) {
    const nameField = buf.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (nameField === '') break; // two zero blocks => end of archive
    const sizeOctal = buf.toString('utf8', off + 124, off + 136).replace(/[\0 ]/g, '');
    const size = parseInt(sizeOctal, 8) || 0;
    const dataStart = off + 512;
    if (nameField === entryName) return buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

// Extract `package/cli.js` from the npm tarball and return its sha256, or null
// when the tarball ships no JS bundle (modern native-binary releases ship only
// a wrapper + bin/claude.exe — the patched bundle is then extracted from the
// binary and has no byte-identical counterpart inside this tarball).
function tarballBundleSha256(path) {
  try {
    const entry = readTarEntry(gunzipSync(readFileSync(path)), 'package/cli.js');
    if (!entry) return null;
    return createHash('sha256').update(entry).digest('hex');
  } catch (err) {
    // A parse/gunzip failure must not be read as "no bundle present" (which
    // would silently skip the binding) — surface it as a hard error.
    fail(`could not read package/cli.js from tarball ${path}: ${err.message}`);
  }
}

// Returns { ok: true, boundSha256: string|null }:
//   boundSha256 = the sha256 of package/cli.js inside the integrity-verified
//   tarball, which the TOFU path compares against the on-disk bundle to prove
//   the bytes being patched actually came from the authenticated package.
//   null  => tarball carries no JS bundle (native-binary release); the integrity
//   check proves the PACKAGE is authentic but does NOT bind the extracted bundle.
async function verifyTarball() {
  if (!tarball && !tarballIntegrity) return { ok: false, boundSha256: null };
  if (!tarball || !tarballIntegrity) usage('--tarball and --tarball-integrity must be given together.');
  if (!existsSync(tarball)) fail(`tarball not found: ${tarball}`);
  const m = /^sha512-(.+)$/.exec(tarballIntegrity.trim());
  if (!m) {
    if (SKIP) { warn(`tarball-integrity not in sha512-<base64> form; skipping (CCPATCH_SKIP_SHA_CHECK=1).`); return { ok: false, boundSha256: null }; }
    fail(`--tarball-integrity must be a Subresource-Integrity 'sha512-<base64>' string (got: ${tarballIntegrity.slice(0, 24)}…).`);
  }
  const want = m[1];
  const got = await streamSha512Base64(tarball);
  if (got !== want) {
    if (SKIP) { warn(`tarball integrity MISMATCH but CCPATCH_SKIP_SHA_CHECK=1 set — proceeding.`); return { ok: false, boundSha256: null }; }
    fail(`npm tarball integrity MISMATCH for ${tarball}\n` +
      `  registry sha512: ${want.slice(0, 32)}…\n` +
      `  computed sha512: ${got.slice(0, 32)}…\n` +
      `  The downloaded tarball does not match the npm registry. Refusing to proceed.`);
  }
  info(`npm tarball integrity OK (sha512 matches registry).`);
  // tarballOnly has no on-disk bundle to bind yet; skip the (here-pointless) extract.
  return { ok: true, boundSha256: tarballOnly ? null : tarballBundleSha256(tarball) };
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
  return `run \`ccpatch pin ${version || '<x.y.z>'}\` to record it`;
}

async function main() {
  const { boundSha256 } = await verifyTarball();

  if (tarballOnly) { return done(); }

  // Out-of-band pin always wins — it's the strongest signal (authenticity, not
  // just integrity), mirroring the third-party `--expect-sha256` path.
  if (expectSha256) {
    if (!/^[0-9a-f]{64}$/i.test(expectSha256)) usage('--expect-sha256 must be a 64-char hex sha256.');
    if (computed.toLowerCase() !== expectSha256.toLowerCase()) {
      // An explicit out-of-band pin is the strongest authenticity signal there
      // is. It is NOT waivable by CCPATCH_SKIP_SHA_CHECK — SKIP only relaxes the
      // weaker registry/TOFU checks. A mismatch here always fails closed.
      fail(`--expect-sha256 MISMATCH for ${target}\n` +
        `  expected: ${expectSha256}\n` +
        `  computed: ${computed}\n` +
        `  Refusing to patch a bundle that does not match the out-of-band pin.\n` +
        `  (This explicit pin is NOT waivable by CCPATCH_SKIP_SHA_CHECK.)`);
    }
    info(`bundle sha256 OK (verified against out-of-band --expect-sha256): ${computed}`);
    return done();
  }

  if (!version) usage('missing --version (needed for registry lookup).');

  const { versions } = loadRegistry(registryPath);
  const pinned = versions[version];

  if (!pinned) {
    // TOFU: unknown/new version. There is no registry sha and no --expect-sha256
    // to vouch for this bundle, so the ONE remaining authenticity anchor is the
    // npm tarball integrity (sha512-vs-registry, verified in verifyTarball). It
    // is therefore MANDATORY here: accepting an unverified ~16MB blob on disk
    // with zero checks is not TOFU, it's blind trust. Fail closed if it's absent.
    if (!tarballIntegrity) {
      if (SKIP) {
        warn(`TOFU: v${version} is unpinned and no --tarball-integrity given, but CCPATCH_SKIP_SHA_CHECK=1 — proceeding UNVERIFIED.`);
        warn(`  bundle sha256: ${computed}  (${size} bytes) — NOT authenticated against any source.`);
        return done();
      }
      fail(`TOFU: v${version} is not pinned and has NO integrity anchor.\n` +
        `  bundle:   ${target}\n` +
        `  sha256:   ${computed}  (${size} bytes)\n` +
        `  A brand-new version must be verified against the npm registry on first use.\n` +
        `  Re-run with --tarball <tgz> --tarball-integrity <sha512-...> (from \`npm pack --json\`),\n` +
        `  or pass an out-of-band --expect-sha256 pin. Refusing to patch an unverified bundle.`);
    }
    // The tarball's sha512 was verified against the registry (verifyTarball
    // fails closed on mismatch). But that only proves the PACKAGE is authentic —
    // it does not, on its own, prove the bundle on disk came from that package.
    // Bind the two when we can:
    if (boundSha256 !== null) {
      // The tarball ships package/cli.js. The bundle being patched MUST be those
      // exact bytes, or it was not extracted from the authenticated package.
      if (computed.toLowerCase() !== boundSha256.toLowerCase()) {
        if (SKIP) {
          warn(`TOFU: v${version} bundle does NOT match package/cli.js in the verified tarball, but CCPATCH_SKIP_SHA_CHECK=1 — proceeding UNSAFELY.`);
          warn(`  bundle sha256:  ${computed}`);
          warn(`  tarball cli.js: ${boundSha256}`);
          return done();
        }
        fail(`TOFU: v${version} on-disk bundle is NOT the cli.js from the verified npm tarball.\n` +
          `  bundle:        ${target}\n` +
          `  bundle sha256: ${computed}  (${size} bytes)\n` +
          `  tarball cli.js sha256: ${boundSha256}\n` +
          `  The tarball matched the npm registry, but the bundle being patched did\n` +
          `  not come from it. Refusing to patch a bundle that the authenticated\n` +
          `  package does not vouch for.`);
      }
      info(`TOFU: v${version} unpinned — bundle bound to verified npm tarball (cli.js sha256 matches). Proceeding. ${pinHint()}`);
      return done();
    }
    // boundSha256 === null: a native-binary release. The tarball ships only a
    // wrapper + bin/claude.exe; the bundle is extracted from that binary and has
    // no byte-identical counterpart in the tarball, so tarball integrity CANNOT
    // authenticate it. Say so honestly rather than implying the bundle is vouched
    // for. This is still TOFU (proceed on first use), but the strong anchor for
    // such versions is an out-of-band --expect-sha256 pin.
    info(`TOFU: v${version} unpinned — npm package authenticated, but this is a native-binary release so the extracted bundle is NOT bound to the tarball. Proceeding on first use; sha256 ${computed.slice(0, 16)}… · for a stronger guarantee re-run with --expect-sha256, then ${pinHint()}`);
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
