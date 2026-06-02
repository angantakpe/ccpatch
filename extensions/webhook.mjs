
export default {
    category: 'optional',
    enabled: false,

    // SECURITY: this patch egresses UNREDACTED conversation/event data
    // (args, cwd, pid, event payloads) to CC_WEBHOOK_URL. Outbound is
    // restricted to https: (or http://localhost for dev) — see scheme check
    // in the injected hook below.
    description: 'Send webhook notifications on key events. WARNING: egresses unredacted conversation/event data to CC_WEBHOOK_URL.',
    capabilities: ["network","env","telemetry"],
    // The injected hook embeds the marker string '__ccpWebhook_v1' exactly once
    // and never references __sendWebhook__ before defining it, so present+count
    // give a non-weak verify. count>1 ⇒ double-applied.
    verify: { present: '__ccpWebhook_v1', count: { present: 1 } },
    apply: (code) => {
      const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Webhook Notifications  (marker: __ccpWebhook_v1)
// ══════════════════════════════════════════════════════════════════════════
// WARNING: this sends UNREDACTED conversation/event data (CLI args, cwd, pid,
// event payloads) outbound to CC_WEBHOOK_URL. Treat that endpoint as a
// data sink with full visibility into your session.

const WEBHOOK_URL = process.env.CC_WEBHOOK_URL;

// SSRF / cloud-metadata guard: reject any host that resolves (literally) to a
// private, loopback-other-than-localhost, or link-local address. This blocks the
// obvious internal-pivot and credential-theft targets — RFC-1918
// (10/8, 172.16/12, 192.168/16), the 169.254.0.0/16 link-local range (which
// includes the 169.254.169.254 cloud-metadata endpoint on AWS/GCP/Azure), and
// bare loopback IPs other than the explicitly-allowed localhost. Hostnames that
// only resolve to internal IPs via DNS still slip through (we don't resolve
// here), but literal-IP exfil targets — the common SSRF case — are denied.
const __ccpWebhookIsBlockedHost = (host) => {
  let h = String(host || '').toLowerCase();
  // Strip IPv6 brackets and any zone id.
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.replace(/%.*$/, '');
  // IPv6 loopback / unspecified.
  if (h === '::1' || h === '::') return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) → unwrap to the v4 tail and fall through.
  const mapped = h.match(/^::ffff:(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})$/);
  if (mapped) h = mapped[1];
  // IPv6 link-local (fe80::/10) and unique-local (fc00::/7).
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  const m = h.match(/^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some(n => n > 255)) return false; // not a valid dotted-quad
    if (o[0] === 10) return true;                          // 10.0.0.0/8
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16.0.0/12
    if (o[0] === 192 && o[1] === 168) return true;         // 192.168.0.0/16
    if (o[0] === 169 && o[1] === 254) return true;         // 169.254.0.0/16 (incl. cloud metadata)
    if (o[0] === 127) return true;                         // 127.0.0.0/8 loopback
    if (o[0] === 0) return true;                           // 0.0.0.0/8
  }
  return false;
};

// Scheme allowlist + SSRF guard: only https:, or http://localhost (+127.0.0.1/
// [::1]) for local dev. Anything else (plain http:, file:, etc.) is rejected so
// secrets and conversation data can't egress over an unauthenticated/cleartext
// channel. On top of the scheme check, any private/link-local/loopback host
// (other than the explicitly-allowed dev localhost) is blocked to deny obvious
// SSRF and 169.254.169.254 cloud-metadata exfil targets.
const __ccpWebhookAllowed = (raw) => {
  try {
    const u = new URL(raw);
    const isDevLocalhost = (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1');
    if (u.protocol === 'http:') {
      // Plain http is only ever allowed for the dev localhost loopback.
      return isDevLocalhost;
    }
    if (u.protocol !== 'https:') return false;
    // https: — permitted, but deny private/link-local/loopback destinations
    // (SSRF / cloud-metadata). The dev localhost names stay allowed.
    if (isDevLocalhost) return true;
    if (__ccpWebhookIsBlockedHost(u.hostname)) return false;
    return true;
  } catch (_) { return false; }
};

// DNS-resolving SSRF guard: the literal-IP check above only catches targets
// that are *already* dotted-quads/IPv6 in the URL. A hostname like
// internal.evil.example that resolves to 169.254.169.254 (or any RFC-1918 /
// loopback / link-local address) would otherwise slip through. So resolve the
// host (all addresses) and run EACH resolved IP through the same blocklist;
// reject if ANY answer points at an internal/metadata address. The dev
// localhost exception is preserved (callers short-circuit on it before here).
// Returns true if SAFE to send, false if blocked. Best-effort: a resolution
// failure is treated as not-blocked here (fetch will fail loudly on its own).
const __ccpWebhookDnsAllowed = async (raw) => {
  try {
    const u = new URL(raw);
    const isDevLocalhost = (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1');
    if (isDevLocalhost) return true;
    const __req = (typeof globalThis.__hm_require === 'function')
      ? globalThis.__hm_require
      : (typeof require === 'function' ? require : null);
    if (!__req) return true; // can't resolve — leave it to the literal guard
    const dns = __req('node:dns');
    const lookup = dns.promises && dns.promises.lookup;
    if (!lookup) return true;
    const results = await lookup(u.hostname, { all: true });
    for (const r of (results || [])) {
      if (r && r.address && __ccpWebhookIsBlockedHost(r.address)) return false;
    }
    return true;
  } catch (_) {
    // Treat resolution errors as non-blocking; the actual fetch will surface them.
    return true;
  }
};

globalThis.__sendWebhook__ = async (event, data) => {
  if (!WEBHOOK_URL) return;
  if (!__ccpWebhookAllowed(WEBHOOK_URL)) {
    console.error('[ccpatch] webhook: refusing to POST to ' + WEBHOOK_URL + ' — only https: (or http://localhost for dev) is allowed');
    return;
  }
  // Resolve the hostname and re-check every answer against the SSRF blocklist
  // so a DNS-only internal/metadata target can't slip past the literal guard.
  if (!(await __ccpWebhookDnsAllowed(WEBHOOK_URL))) {
    console.error('[ccpatch] webhook: refusing to POST to ' + WEBHOOK_URL + ' — host resolves to a blocked internal/metadata address (SSRF guard)');
    return;
  }
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        cwd: process.cwd(),
        ...data
      })
    });
  } catch (e) {
    // Silent fail
  }
};

// Notify on startup
globalThis.__sendWebhook__('session_start', { 
  args: process.argv.slice(2) 
});

process.on('exit', (code) => {
  globalThis.__sendWebhook__('session_end', { exitCode: code });
});

`;
      const _SHEBANG_ = '#!/usr/bin/env node';
    const _CJS_IIFE_ = '(function(exports, require, module, __filename, __dirname)';
    if (code.startsWith(_SHEBANG_)) return code.replace(_SHEBANG_, _SHEBANG_ + '\n' + hook);
    if (code.includes(_CJS_IIFE_)) return code.replace(_CJS_IIFE_, () => hook + _CJS_IIFE_);
    console.warn('  [!] webhook: anchor not found — skipping');
    return code;
    }
  };
