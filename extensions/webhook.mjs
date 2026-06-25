
export default {
    category: 'optional',
    enabled: false,

    // SECURITY: this patch egresses session/event data to CC_WEBHOOK_URL.
    // By default the payload is REDACTED (secret-looking values masked,
    // full process.argv not shipped verbatim, cwd dropped) — set
    // CC_WEBHOOK_RAW=1 to opt out (dev only). Outbound is restricted to
    // https: (or http://localhost for dev) and the destination IP is
    // resolved + SSRF-validated + pinned at send time (DNS-rebinding safe).
    // See the injected hook below.
    description: 'Send webhook notifications on key events. Payload is redacted by default (set CC_WEBHOOK_RAW=1 to send raw); destination is SSRF-validated and IP-pinned at send time.',
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
// WARNING: this sends session/event data outbound to CC_WEBHOOK_URL. By
// default the payload is run through redact() before egress (secret-looking
// values masked, full process.argv not shipped verbatim, cwd dropped). Set
// CC_WEBHOOK_RAW=1 to send everything unredacted (dev only). Even redacted,
// treat that endpoint as a data sink with visibility into your session.

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

const __ccpWebhookRequire = () => (typeof globalThis.__hm_require === 'function')
  ? globalThis.__hm_require
  : (typeof require === 'function' ? require : null);

// DNS-rebinding / TOCTOU-resistant resolve-and-pin: resolve the hostname at
// SEND time (not startup), validate EVERY resolved address against the SSRF
// blocklist, and hand back the validated IP so the actual connection is made
// to the same address we just checked. This closes the classic rebinding
// window where a host resolves to a safe IP at check time and then flips to
// 169.254.169.254 / RFC-1918 / loopback before the connection.
//
// Returns one of:
//   { ok: true,  pin: '<ip>', family: 4|6 }  — safe, connect to this exact IP
//   { ok: true,  pin: null }                  — dev localhost (skip pinning)
//   { ok: false, reason: '<string>' }         — blocked / could not validate
//
// We FAIL CLOSED on resolution errors and on a missing resolver: if we cannot
// prove the target is safe, we do not send. (The literal-IP guard in
// __ccpWebhookAllowed has already run by the time callers reach here.)
const __ccpWebhookResolveAndPin = async (raw) => {
  let u;
  try { u = new URL(raw); } catch (_) { return { ok: false, reason: 'invalid URL' }; }
  const isDevLocalhost = (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1');
  if (isDevLocalhost) return { ok: true, pin: null };
  // A literal IP in the URL was already vetted by __ccpWebhookAllowed; pin it
  // directly so there is nothing left to resolve (and nothing to rebind).
  let litHost = u.hostname;
  if (litHost.startsWith('[') && litHost.endsWith(']')) litHost = litHost.slice(1, -1);
  if (/^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$/.test(litHost) || litHost.includes(':')) {
    if (__ccpWebhookIsBlockedHost(litHost)) return { ok: false, reason: 'literal IP is internal/metadata' };
    return { ok: true, pin: litHost, family: litHost.includes(':') ? 6 : 4 };
  }
  const __req = __ccpWebhookRequire();
  if (!__req) return { ok: false, reason: 'no resolver available' };
  let dns;
  try { dns = __req('node:dns'); } catch (_) { return { ok: false, reason: 'no resolver available' }; }
  const lookup = dns.promises && dns.promises.lookup;
  if (!lookup) return { ok: false, reason: 'no resolver available' };
  let results;
  try {
    results = await lookup(u.hostname, { all: true });
  } catch (_) {
    return { ok: false, reason: 'DNS resolution failed' };
  }
  if (!results || !results.length) return { ok: false, reason: 'no DNS answers' };
  // Validate ALL answers; if any points at an internal/metadata address, refuse
  // (an attacker could otherwise race us onto the bad one).
  for (const r of results) {
    if (!r || !r.address || __ccpWebhookIsBlockedHost(r.address)) {
      return { ok: false, reason: 'host resolves to a blocked internal/metadata address' };
    }
  }
  // Pin the first validated answer. We connect to THIS ip and set the Host /
  // TLS servername to the original hostname (below), so the IP we validated is
  // exactly the IP we connect to — DNS cannot be re-queried between check and
  // connect.
  const chosen = results[0];
  return { ok: true, pin: chosen.address, family: chosen.family };
};

// Redaction: this patch's whole risk is that it egresses session data, so we
// scrub the payload before it leaves the process. Default is REDACTED; set
// CC_WEBHOOK_RAW=1 to opt out and send everything unredacted (dev only).
const __ccpWebhookRedactEnabled = () => process.env.CC_WEBHOOK_RAW !== '1';

// Patterns for values that look like credentials regardless of key name.
const __ccpSecretValueRe = [
  /\\bsk-[A-Za-z0-9_-]{8,}/,                 // OpenAI/Anthropic-style secret keys
  /\\bsk-ant-[A-Za-z0-9_-]{8,}/,            // Anthropic keys
  /\\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}/, // GitHub tokens
  /\\bAKIA[0-9A-Z]{12,}/,                    // AWS access key id
  /\\bxox[baprs]-[A-Za-z0-9-]{8,}/,         // Slack tokens
  /\\bey[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{6,}/, // JWT
  /\\bBearer\\s+[A-Za-z0-9._-]{8,}/i,       // bearer tokens
];
// Key names whose VALUE should always be masked.
const __ccpSecretKeyRe = /(authorization|api[-_]?key|secret|token|password|passwd|credential|cookie|session|private[-_]?key|access[-_]?key)/i;

const __ccpMaskString = (s) => {
  let out = String(s);
  for (const re of __ccpSecretValueRe) {
    out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), '[REDACTED]');
  }
  return out;
};

// Recursively redact: mask secret-looking values, mask values under
// secret-looking keys, and drop anything under ANTHROPIC_* keys. Best-effort
// and conservative — when in doubt, over-redact. Guards against cycles/depth.
const __ccpWebhookRedactValue = (val, keyHint, depth, seen) => {
  if (depth > 8) return '[REDACTED:depth]';
  if (val == null) return val;
  if (typeof val === 'string') {
    if (keyHint && (__ccpSecretKeyRe.test(keyHint) || /^anthropic[_-]/i.test(keyHint))) return '[REDACTED]';
    return __ccpMaskString(val);
  }
  if (typeof val === 'number' || typeof val === 'boolean') {
    if (keyHint && (__ccpSecretKeyRe.test(keyHint) || /^anthropic[_-]/i.test(keyHint))) return '[REDACTED]';
    return val;
  }
  if (typeof val === 'object') {
    if (seen.has(val)) return '[REDACTED:circular]';
    seen.add(val);
    if (Array.isArray(val)) return val.map((v) => __ccpWebhookRedactValue(v, keyHint, depth + 1, seen));
    const out = {};
    for (const k of Object.keys(val)) {
      if (/^anthropic[_-]/i.test(k)) { out[k] = '[REDACTED]'; continue; }
      out[k] = __ccpWebhookRedactValue(val[k], k, depth + 1, seen);
    }
    return out;
  }
  return '[REDACTED:unserializable]';
};

const __ccpWebhookRedact = (obj) => {
  if (!__ccpWebhookRedactEnabled()) return obj;
  try { return __ccpWebhookRedactValue(obj, null, 0, new WeakSet()); }
  catch (_) { return { redacted: true, note: 'redaction failed; payload withheld' }; }
};

globalThis.__sendWebhook__ = async (event, data) => {
  if (!WEBHOOK_URL) return;
  if (!__ccpWebhookAllowed(WEBHOOK_URL)) {
    console.error('[ccpatch] webhook: refusing to POST to ' + WEBHOOK_URL + ' — only https: (or http://localhost for dev) is allowed');
    return;
  }
  // Resolve + validate the hostname RIGHT NOW (send time, not startup) and pin
  // the validated IP so the connection goes to exactly the address we vetted.
  // This is what defeats DNS rebinding / TOCTOU: re-resolution between check and
  // connect is no longer possible because we connect to the literal pinned IP.
  const __pin = await __ccpWebhookResolveAndPin(WEBHOOK_URL);
  if (!__pin.ok) {
    console.error('[ccpatch] webhook: refusing to POST to ' + WEBHOOK_URL + ' — ' + __pin.reason + ' (SSRF guard)');
    return;
  }

  // Build the payload, then redact before egress. Notable: we do NOT ship the
  // full process.argv (only a redacted copy via redact()), and we drop cwd and
  // narrow pid usage — see below.
  const __payload = __ccpWebhookRedact({
    event,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    ...data
  });
  const __body = JSON.stringify(__payload);

  try {
    if (__pin.pin === null) {
      // Dev localhost: no pinning needed, send straight through.
      await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: __body
      });
      return;
    }
    // Pin the connection to the validated IP using node's http(s).request. We
    // pass the original hostname for the Host header + TLS servername (so SNI /
    // virtual-hosting + cert validation still work against the real name) but
    // override the dialed address via the lookup hook, which forces the socket
    // onto the IP we just validated — DNS is never consulted again.
    const u = new URL(WEBHOOK_URL);
    const __req = __ccpWebhookRequire();
    const transport = u.protocol === 'https:' ? __req('node:https') : __req('node:http');
    const pinnedLookup = (_hostname, _opts, cb) => {
      // Always hand back the single validated IP regardless of what was asked.
      if (typeof _opts === 'function') { cb = _opts; }
      process.nextTick(() => cb(null, __pin.pin, __pin.family || (String(__pin.pin).includes(':') ? 6 : 4)));
    };
    await new Promise((resolve) => {
      const reqObj = transport.request({
        protocol: u.protocol,
        hostname: u.hostname,        // real name → Host header + cert checks
        servername: u.hostname,      // SNI / TLS servername stays the real host
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: (u.pathname || '/') + (u.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(__body),
          'Host': u.host
        },
        lookup: pinnedLookup,        // force the socket onto the validated IP
      }, (res) => { res.resume(); res.on('end', resolve); res.on('error', () => resolve()); });
      reqObj.on('error', () => resolve()); // silent fail, like before
      reqObj.write(__body);
      reqObj.end();
    });
  } catch (e) {
    // Silent fail
  }
};

// Notify on startup. argv goes through redact() — full process.argv is never
// shipped verbatim; token/key/secret-looking args are masked.
globalThis.__sendWebhook__('session_start', {
  args: process.argv.slice(2)
});

process.on('exit', (code) => {
  globalThis.__sendWebhook__('session_end', { exitCode: code });
});

`;
      // Idempotency guard (rule 2): the hook embeds this sentinel marker; if
      // it's already present the bundle is patched — return unchanged.
      if (code.includes('__ccpWebhook_v1')) return code;
      const _SHEBANG_ = '#!/usr/bin/env node';
    const _CJS_IIFE_ = '(function(exports, require, module, __filename, __dirname)';
    if (code.startsWith(_SHEBANG_)) return code.replace(_SHEBANG_, _SHEBANG_ + '\n' + hook);
    if (code.includes(_CJS_IIFE_)) return code.replace(_CJS_IIFE_, () => hook + _CJS_IIFE_);
    console.warn('  [!] webhook: anchor not found — skipping');
    return code;
    }
  };
