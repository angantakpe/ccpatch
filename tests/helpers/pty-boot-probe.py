#!/usr/bin/env python3
"""pty-boot-probe.py — boot a JS bundle under node inside a REAL pty and act
as a minimal-but-honest terminal so the boot sequence can complete.

Why this exists: Claude Code's interactive boot blocks awaiting answers to
terminal capability queries (DA1, XTVERSION, OSC 11 background, CPR, DECRQM
sync-mode probes). A plain pipe — or even a pty that never answers — leaves
boot parked forever, which is exactly the deadlock class the headless test
tiers can never see. This probe forks the bundle in a pty, ANSWERS those
queries like xterm would, captures everything the app writes, and streams the
raw bytes to stdout for the calling test to assert on.

Usage:
    pty-boot-probe.py <bundle.js> [--timeout SECS] [--enough-bytes N]
                                  [--cols N] [--rows N] [--node PATH]

Protocol with the caller:
    stdout  — raw captured pty bytes (binary; ANSI escapes included)
    stderr  — probe diagnostics (one '[probe] ...' line per event)
    exit 0  — probe ran: child spawned, capture window completed
    exit 3  — usage / environment error (bad args, bundle missing)

The probe deliberately does NOT judge the output. Deciding whether boot
deadlocked (~900 bytes of banner + queries, then silence) or rendered a real
UI frame (multi-KB Ink repaints) is the calling test's job.
"""

import argparse
import errno
import fcntl
import os
import re
import select
import signal
import struct
import sys
import termios
import time

# ── Capability query → reply table ─────────────────────────────────────────
# Each entry: (compiled pattern over the raw byte stream, reply builder).
# Patterns are matched incrementally against a sliding scan buffer so queries
# split across read() boundaries are still caught. Every occurrence is
# answered — apps may re-issue queries and expect a reply each time.

def _decrqm_reply(m):
    mode = m.group(1)
    # 2026 (synchronized output) and 2031 (color-scheme notify): report
    # "reset" (2) — recognized, currently off. Anything else: "not
    # recognized" (0) so the app falls back instead of waiting on us.
    setting = b"2" if mode in (b"2026", b"2031") else b"0"
    return b"\x1b[?" + mode + b";" + setting + b"$y"

QUERY_REPLIES = [
    # DA1 — primary device attributes. \x1b[c (and the equivalent \x1b[0c).
    # Reply: VT220 with sixel — what a normal modern terminal claims.
    (re.compile(rb"\x1b\[0?c"), lambda m: b"\x1b[?62;4c"),
    # XTVERSION — \x1b[>0q (also \x1b[>q). Reply: DCS > | text ST.
    (re.compile(rb"\x1b\[>0?q"), lambda m: b"\x1bP>|probe 1.0\x1b\\"),
    # OSC 11 — background color query \x1b]11;? (BEL- or ST-terminated).
    (re.compile(rb"\x1b\]11;\?(?:\x07|\x1b\\)?"),
     lambda m: b"\x1b]11;rgb:1e1e/1e1e/1e1e\x07"),
    # CPR — cursor position report. DEC private \x1b[?6n and plain \x1b[6n.
    (re.compile(rb"\x1b\[\??6n"), lambda m: b"\x1b[1;1R"),
    # DECRQM — request mode \x1b[?<mode>$p.
    (re.compile(rb"\x1b\[\?(\d+)\$p"), _decrqm_reply),
]

# Keep this many trailing bytes when sliding the scan buffer — longer than
# any query sequence, so a query split across reads is never lost.
SCAN_TAIL = 64


def log(msg):
    sys.stderr.write("[probe] %s\n" % msg)
    sys.stderr.flush()


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("bundle")
    ap.add_argument("--timeout", type=float, default=20.0,
                    help="max capture window in seconds (default 20)")
    ap.add_argument("--enough-bytes", type=int, default=16384,
                    help="stop early once this many bytes are captured")
    ap.add_argument("--idle-exit", type=float, default=0.0,
                    help="stop after this many seconds with no new output "
                         "(0 = disabled). A rendered-then-idle UI and a "
                         "deadlocked boot both go quiet — the caller's "
                         "assertions tell them apart; this just stops the "
                         "capture window early in both cases.")
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--rows", type=int, default=40)
    ap.add_argument("--node", default=os.environ.get("CCPATCH_TTY_NODE", "node"))
    args = ap.parse_args()

    if not os.path.isfile(args.bundle):
        log("bundle not found: %s" % args.bundle)
        return 3

    import pty  # stdlib; import here so --help works on exotic platforms
    pid, master = pty.fork()

    if pid == 0:
        # ── Child: become the bundle under node, inside the pty ──
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        env.setdefault("COLORTERM", "truecolor")
        try:
            os.execvpe(args.node, [args.node, args.bundle], env)
        except OSError as e:
            os.write(2, b"[probe-child] exec failed: %s\n" % str(e).encode())
            os._exit(127)

    # ── Parent: be the terminal ──
    # Size the pty — Ink reads the winsize to lay out frames.
    winsz = struct.pack("HHHH", args.rows, args.cols, 0, 0)
    fcntl.ioctl(master, termios.TIOCSWINSZ, winsz)

    captured = bytearray()
    scan = b""
    answered = 0
    deadline = time.monotonic() + args.timeout
    last_data = time.monotonic()
    out = sys.stdout.buffer
    eof_reason = "timeout"

    try:
        while True:
            now = time.monotonic()
            if now >= deadline:
                break
            if len(captured) >= args.enough_bytes:
                eof_reason = "enough-bytes"
                break
            if args.idle_exit > 0 and captured and (now - last_data) >= args.idle_exit:
                eof_reason = "idle"
                break
            try:
                r, _, _ = select.select([master], [], [], min(deadline - now, 0.25))
            except InterruptedError:
                continue
            if master not in r:
                # No data this tick. If the child already exited AND the pty
                # has drained, stop — anything else is just a quiet stretch.
                done, _ = os.waitpid(pid, os.WNOHANG)
                if done == pid:
                    eof_reason = "child-exited"
                    break
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError as e:
                # EIO on Linux == child side of the pty closed.
                if e.errno == errno.EIO:
                    eof_reason = "pty-eof"
                    break
                raise
            if not chunk:
                eof_reason = "pty-eof"
                break

            captured.extend(chunk)
            last_data = time.monotonic()
            out.write(chunk)
            out.flush()

            # Answer any capability queries present in the stream.
            scan = (scan + chunk)[-(SCAN_TAIL + len(chunk)):]
            for pat, reply in QUERY_REPLIES:
                for m in pat.finditer(scan):
                    os.write(master, reply(m))
                    answered += 1
                # Strip what we've answered so a sliding window can't
                # re-answer the same occurrence on the next chunk.
                scan = pat.sub(b"", scan)
            scan = scan[-SCAN_TAIL:]
    finally:
        log("captured=%dB answered=%d reason=%s" % (len(captured), answered, eof_reason))
        # Tear the child down — boot smoke only; we never interact.
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        for _ in range(20):  # up to ~1s of grace
            try:
                done, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                done = pid
            if done == pid:
                break
            time.sleep(0.05)
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass
        os.close(master)

    return 0


if __name__ == "__main__":
    sys.exit(main())
