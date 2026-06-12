/**
 * boot-tty.test.mjs — interactive pty boot smoke.
 *
 * Every other tier (verify strings, `--version` boot smoke, daemon
 * round-trip) runs headless and exits before the interactive TUI
 * initializes — which is exactly how two real boot deadlocks shipped
 * through a fully green suite (a Bun-only fullscreen PTY host awaited
 * forever under Node; a swallowed require('ws') rejection killed the
 * IDE-connect path). This tier boots the patched bundle in a REAL pty
 * (via tests/helpers/pty-boot-probe.py — Node has no builtin pty, python3
 * does) and asserts that a substantive UI frame renders within the boot
 * window.
 *
 * The probe answers terminal capability queries (DA1, XTVERSION, OSC 11,
 * CPR, DECRQM) like a real terminal, because boot blocks awaiting them.
 *
 * Trust seeding (CRITICAL): the deadlock lived in POST-trust boot. In an
 * untrusted cwd the trust dialog renders first and masks the bug, so this
 * test fabricates a hermetic $HOME with a `.claude.json` whose
 * `projects["<cwd>"].hasTrustDialogAccepted = true` — the same schema the
 * real CLI writes — making the test cwd pre-trusted. No credentials are
 * seeded: a login/onboarding screen still counts as PASS, because the
 * assertion is "a UI frame rendered", i.e. boot did not deadlock.
 *
 * Pass/fail signal: a deadlocked boot emits ~900 bytes (banner + capability
 * queries) then eternal silence; a rendered Ink frame is several KB. We
 * assert BOTH a raw byte-count threshold AND at least one escape-stripped
 * text marker (Ink interleaves escapes mid-word, so markers are matched on
 * escape- and whitespace-stripped text only).
 *
 * Skips cleanly when python3 or a patched bundle is missing (mirrors
 * tests/boot-smoke.test.mjs). Env overrides:
 *   CCPATCH_TTY_BUNDLE — explicit bundle path (used by `make canary`)
 *   CCPATCH_TTY_PYTHON — python interpreter (also lets CI simulate
 *                        "no python3" by pointing at a bogus path)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const RELEASES = resolve(ROOT, 'releases');
const PROBE = resolve(__dirname, 'helpers', 'pty-boot-probe.py');

// Probe capture window. The hang signature is ~900 bytes then silence, so a
// 20s window with a 5s idle cutoff terminates both outcomes quickly.
const PROBE_TIMEOUT_S = 20;
const PROBE_IDLE_EXIT_S = 5;
// Hard kill-guard on the probe process itself (window + teardown slack).
const KILL_GUARD_MS = (PROBE_TIMEOUT_S + 25) * 1000;

// A deadlocked boot is ~900 raw bytes; a rendered frame measured 2.2–5KB
// depending on layout variant. 1500 splits the two with margin on each side.
const MIN_RAW_BYTES = 1500;

// Frame markers, matched against escape-stripped + whitespace-stripped text.
// All of these are produced only by a rendered Ink frame — never by the
// pre-Ink boot banner — and cover logged-in, logged-out, and first-run
// onboarding screens alike.
const FRAME_MARKERS = [
  '?forshortcuts',          // composer footer
  '/login',                 // logged-out footer hint
  'Welcomeback',            // returning-user header
  'Tipsforgettingstarted',  // tips panel
  'Choosethetextstyle',     // first-run theme picker
  'Selectloginmethod',      // first-run login picker
];

/** Find the newest patched binary by directory mtime (same as boot-smoke). */
function findPatchedBinary() {
  if (process.env.CCPATCH_TTY_BUNDLE) {
    // Resolve to absolute — the probe runs from a temp pre-trusted cwd, so a
    // relative path (e.g. from `make canary`) would dangle there.
    const p = resolve(process.env.CCPATCH_TTY_BUNDLE);
    return existsSync(p) ? p : null;
  }
  if (!existsSync(RELEASES)) return null;
  const versions = readdirSync(RELEASES)
    .map(v => ({ v, path: resolve(RELEASES, v) }))
    .filter(({ path }) => statSync(path).isDirectory())
    .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
  for (const { path } of versions) {
    const bin = readdirSync(path).find(f => /^cli\.v[\d.]+\.patched\.m?js$/.test(f));
    if (bin) return resolve(path, bin);
  }
  return null;
}

/** Resolve a usable python3 with the stdlib pty module, or null. */
function findPython() {
  const py = process.env.CCPATCH_TTY_PYTHON || 'python3';
  try {
    const r = spawnSync(py, ['-c', 'import pty, select, termios'], { stdio: 'ignore', timeout: 10_000 });
    return r.status === 0 ? py : null;
  } catch {
    return null;
  }
}

/**
 * Build a hermetic HOME + pre-trusted work cwd.
 *
 * Schema learned from a real ~/.claude.json (read-only): trust lives at
 * `projects.<absolute-cwd>.hasTrustDialogAccepted`. The sibling keys below
 * match what the CLI itself writes for a project entry; top-level
 * `hasCompletedOnboarding` skips the first-run wizard so boot heads straight
 * for the post-trust path where the deadlock lived.
 */
function makeTrustedHome() {
  const base = mkdtempSync(join(tmpdir(), 'ccpatch-tty-'));
  const home = join(base, 'home');
  const work = join(base, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    numStartups: 5,
    installMethod: 'unknown',
    autoUpdates: false,
    theme: 'dark',
    hasCompletedOnboarding: true,
    projects: {
      [work]: {
        allowedTools: [],
        mcpServers: {},
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
        hasTrustDialogAccepted: true,
        projectOnboardingSeenCount: 3,
        hasClaudeMdExternalIncludesApproved: false,
        hasClaudeMdExternalIncludesWarningShown: false,
      },
    },
  }, null, 2));
  return { base, home, work };
}

/** Spawn the probe; resolve { code, raw (Buffer), probeLog, timedOut }. */
function runProbe(python, bundle, { home, work }, extraEnv = {}) {
  return new Promise((resolveFn) => {
    const env = { ...process.env, HOME: home, ...extraEnv };
    // Hermeticity: no inherited credentials — a deterministic logged-out
    // frame is still a frame, and real creds must never leak into the test.
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!('CLAUDE_CODE_NO_FLICKER' in extraEnv)) delete env.CLAUDE_CODE_NO_FLICKER;

    const child = spawn(python, [
      PROBE, bundle,
      '--timeout', String(PROBE_TIMEOUT_S),
      '--idle-exit', String(PROBE_IDLE_EXIT_S),
    ], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });

    const out = [];
    let probeLog = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, KILL_GUARD_MS);
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => { probeLog += d.toString(); });
    child.on('close', code => {
      clearTimeout(timer);
      resolveFn({ code, raw: Buffer.concat(out), probeLog, timedOut });
    });
  });
}

/**
 * Strip ANSI/VT escapes (OSC, DCS, CSI, bare ESC finals) and control bytes.
 * Ink interleaves escapes mid-word, so downstream matching additionally
 * removes ALL whitespace — markers are written in that normal form.
 */
function stripAnsi(raw) {
  return raw.toString('utf8')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC ... BEL|ST
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')                  // DCS ... ST
    .replace(/\x1b\[[0-9;:?<=> $"'\-/]*[@-~]/g, '')       // CSI sequences
    .replace(/\x1b[@-_]/g, '')                            // bare ESC finals
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');            // stray controls
}

function assertRenderedFrame(t, { code, raw, probeLog, timedOut }, label) {
  t.diagnostic(`${label}: probe exit=${code} rawBytes=${raw.length} ${probeLog.trim()}`);
  assert.equal(timedOut, false, `${label}: probe never returned — runaway child?\n${probeLog}`);
  assert.equal(code, 0, `${label}: probe failed (exit ${code})\n${probeLog}`);

  assert.ok(raw.length >= MIN_RAW_BYTES,
    `${label}: only ${raw.length} bytes captured (< ${MIN_RAW_BYTES}) — boot ` +
    `likely deadlocked after the banner/capability queries (the v2.1.175 hang ` +
    `signature). Probe log:\n${probeLog}`);

  const text = stripAnsi(raw).replace(/\s+/g, '');
  const hit = FRAME_MARKERS.find(m => text.includes(m));
  assert.ok(hit,
    `${label}: no UI frame marker found in escape-stripped output — bytes ` +
    `flowed but no recognizable frame rendered.\nLooked for any of: ` +
    `${FRAME_MARKERS.join(', ')}\nStripped output (first 1500 chars):\n` +
    `${stripAnsi(raw).slice(0, 1500)}`);
  t.diagnostic(`${label}: frame marker hit: "${hit}"`);
}

const binPath = findPatchedBinary();
const python = findPython();

function skipIfMissing(t) {
  if (!binPath) {
    t.skip('no patched binary found in releases/ — run `make patch-claude-code` first');
    return true;
  }
  if (!python) {
    t.skip('python3 (with pty module) not available — pty boot smoke needs it');
    return true;
  }
  return false;
}

test('tty boot — interactive boot renders a UI frame in a real pty', async (t) => {
  if (skipIfMissing(t)) return;
  t.diagnostic(`booting in pty: ${binPath}`);
  const dirs = makeTrustedHome();
  try {
    const res = await runProbe(python, binPath, dirs);
    assertRenderedFrame(t, res, 'default');
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});

test('tty boot — fullscreen-forced variant (CLAUDE_CODE_NO_FLICKER=1) renders', async (t) => {
  // The fullscreen TUI is normally behind a server-side per-account gate
  // (e.g. tengu_pewter_brook), so a plain boot can't deterministically reach
  // the code path that deadlocked. CLAUDE_CODE_NO_FLICKER=1 forces it: on a
  // fixed bundle the bun_shim's alternate-screen opt-out wins and a frame
  // renders; on a broken bundle boot hangs awaiting the Bun-only PTY host.
  if (skipIfMissing(t)) return;
  const dirs = makeTrustedHome();
  try {
    const res = await runProbe(python, binPath, dirs, { CLAUDE_CODE_NO_FLICKER: '1' });
    assertRenderedFrame(t, res, 'no-flicker');
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
});
