
export default {
    category: 'optional',
    enabled: false,

    description: 'Cache API responses for faster development/testing',
    capabilities: ["network","fs","env"],
    verify: { present: "'cache_responses'", count: { present: 1 } },
  dependsOn: ['fetch_interceptor'],
    apply: (code) => {
      const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Response Cache (for development)
// Registered via __ccpOnFetchBefore so cache hits still trigger the
// after-subscriber fan-out (__ccpOnFetch) for cost tracking etc.
// ══════════════════════════════════════════════════════════════════════════
(async () => {
  const { readFileSync: _readFileSync, writeFileSync: _writeFileSync, existsSync: _existsSync, mkdirSync: _mkdirSync2 } = await import('fs');
  const { createHash: _createHash } = await import('crypto');
  const { join: _join2 } = await import('path');
  
  const CACHE_DIR = _join2(process.env.HOME || '.', '.cc-cache');
  // SECURITY: env-var name follows the CC_ convention (CC_CACHE_RESPONSES).
  // The legacy CLAUDE_CACHE name is still accepted as a deprecated fallback.
  const CACHE_ENABLED = process.env.CC_CACHE_RESPONSES === '1' || process.env.CLAUDE_CACHE === '1';

  // SECURITY: dev/testing ONLY. The cache directory and its contents are
  // trusted by the running CLI — a writable ~/.cc-cache is a response-injection
  // (cache-poisoning) surface, so treat it as you would any code-equivalent
  // input. Mitigations applied here:
  //   - sha256 (not md5) keys → no collision-trivial predictable-path poisoning.
  //   - an auth/identity dimension is mixed into the key (sha256 of the
  //     Authorization / x-api-key header) so a response cached under one
  //     account can never be replayed to a different account/credential. We
  //     hash the secret; the raw token never lands in any on-disk path.
  //   - cache files are written 0600 (owner read/write only), like auth_token.

  // SECURITY: when a request carries NO Authorization / x-api-key header the
  // per-request auth dimension would otherwise collapse to sha256('') — a single
  // constant shared by every uncredentialed caller, breaking the "never replayed
  // across credentials" guarantee for that edge. We fold in a stable
  // per-account/per-process discriminator instead:
  //   1. the credential that the real fetch would actually use (the
  //      ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE env the SDK reads),
  //      so two accounts on the same box still get distinct keys; failing that
  //   2. a per-process random salt generated once at load, so distinct processes
  //      never share an uncredentialed cache entry. (2) sacrifices cross-run
  //      cache reuse for header-less requests in exchange for the safety
  //      property — acceptable for a dev-only cache. The discriminator is hashed
  //      with the same one-way sha256; no raw secret is stored.
  const _envCredential = () =>
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    '';
  // Generated once per process; only consulted when neither a request auth
  // header nor an env credential is available.
  const _processSalt = _createHash('sha256')
    .update('ccpatch-cache:' + process.pid + ':' + Date.now() + ':' + Math.random())
    .digest('hex');
  const _hashHeaders = (headers) => {
    // Pull the auth-bearing header out of whatever shape headers arrives in
    // (plain object, Headers instance, or array of pairs), then return a
    // sha256 of it. Never returns or stores the raw secret.
    let auth = '';
    try {
      if (headers) {
        const _get = (h, k) => {
          if (typeof h.get === 'function') return h.get(k);
          if (Array.isArray(h)) { const f = h.find(p => String(p[0]).toLowerCase() === k); return f ? f[1] : undefined; }
          for (const kk of Object.keys(h)) { if (kk.toLowerCase() === k) return h[kk]; }
          return undefined;
        };
        auth = _get(headers, 'authorization') || _get(headers, 'x-api-key') || '';
      }
    } catch {}
    // No request-level credential → fall back to the env credential, then to a
    // per-process salt, so the auth dimension is never a shared constant.
    if (!auth) auth = 'env:' + _envCredential();
    if (auth === 'env:') auth = 'proc:' + _processSalt;
    return _createHash('sha256').update(String(auth)).digest('hex');
  };
  const _cacheKey = (url, body, headers) =>
    _createHash('sha256').update(JSON.stringify({ url, body, auth: _hashHeaders(headers) })).digest('hex');
  const _writeCacheEntry = (file, payload) => {
    _writeFileSync(file, payload, { mode: 0o600 });
  };

  try { _mkdirSync2(CACHE_DIR, { recursive: true }); } catch {}

  if (CACHE_ENABLED && typeof globalThis.__ccpOnFetchBefore === 'function') {
    globalThis.__ccpOnFetchBefore('cache_responses', async (ctx) => {
      // Only cache API POST requests
      if (!ctx.isApi || ctx.options?.method !== 'POST') return;

      const hash = _cacheKey(ctx.url, ctx.options?.body, ctx.options?.headers);
      const cacheFile = _join2(CACHE_DIR, hash + '.json');
      
      if (_existsSync(cacheFile)) {
        console.log('[CACHE] HIT:', hash.slice(0, 8));
        const cached = JSON.parse(_readFileSync(cacheFile, 'utf-8'));
        // Return a synthetic Response — the fetch_interceptor before-subscriber
        // contract: returning a Response short-circuits the real fetch, but
        // after-subscribers still need to fire for fan-out. Since returning a
        // Response from a before-subscriber bypasses the real fetch entirely
        // (and thus the tee), we signal cache hit via a standard Response.
        // After-subscribers that need SSE events won't get them on cache hits —
        // this is acceptable for dev caching; cost_tracker/turn_budget will
        // simply skip the cached turn.
        return new Response(cached.body, { status: cached.status, headers: cached.headers });
      }

      // No cache hit — let the real request through and capture in after-subscriber
    });

    globalThis.__ccpOnFetch('cache_responses_writer', async ({ url, options, events, isApi }) => {
      if (!isApi || options?.method !== 'POST' || !events || events.length === 0) return;
      // Re-serialize parsed SSE events back into SSE text and write to cache.
      const hash = _cacheKey(url, options?.body, options?.headers);
      const cacheFile = _join2(CACHE_DIR, hash + '.json');
      if (_existsSync(cacheFile)) return; // already cached (e.g. from a parallel call)
      try {
        const sseText = events.map(e => 'data: ' + JSON.stringify(e) + '\\n\\n').join('');
        _writeCacheEntry(cacheFile, JSON.stringify({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sseText }));
        console.log('[CACHE] WRITE:', hash.slice(0, 8), '(' + events.length + ' events)');
      } catch (_e) {}
    });

    // Fallback: if __ccpOnFetch is not available, use direct fetch wrapper
  } else if (CACHE_ENABLED) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function cachedFetch(url, options) {
      if (options?.method !== 'POST' || !String(url).includes('anthropic.com')) {
        return originalFetch.apply(this, arguments);
      }
      
      const hash = _cacheKey(url, options?.body, options?.headers);
      const cacheFile = _join2(CACHE_DIR, hash + '.json');

      if (_existsSync(cacheFile)) {
        console.log('[CACHE] HIT:', hash.slice(0, 8));
        const cached = JSON.parse(_readFileSync(cacheFile, 'utf-8'));
        return new Response(cached.body, { status: cached.status, headers: cached.headers });
      }

      const response = await originalFetch.apply(this, arguments);
      const body = await response.text();

      _writeCacheEntry(cacheFile, JSON.stringify({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body
      }));
      console.log('[CACHE] MISS:', hash.slice(0, 8));
      
      return new Response(body, { status: response.status, headers: response.headers });
    };
  }
})();
`;
      // Idempotency guard (rule 2): the hook embeds this unique banner; if it's
      // already present the bundle is patched — return unchanged.
      if (code.includes('[PATCH] Response Cache (for development)')) return code;
      return code.replace('(function(exports, require, module, __filename, __dirname) {', '(function(exports, require, module, __filename, __dirname) {' + hook);
    }
  };
