
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
  const CACHE_ENABLED = process.env.CLAUDE_CACHE === '1';
  
  try { _mkdirSync2(CACHE_DIR, { recursive: true }); } catch {}
  
  if (CACHE_ENABLED && typeof globalThis.__ccpOnFetchBefore === 'function') {
    globalThis.__ccpOnFetchBefore('cache_responses', async (ctx) => {
      // Only cache API POST requests
      if (!ctx.isApi || ctx.options?.method !== 'POST') return;

      const hash = _createHash('md5').update(JSON.stringify({ url: ctx.url, body: ctx.options?.body })).digest('hex');
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
      const hash = _createHash('md5').update(JSON.stringify({ url, body: options?.body })).digest('hex');
      const cacheFile = _join2(CACHE_DIR, hash + '.json');
      if (_existsSync(cacheFile)) return; // already cached (e.g. from a parallel call)
      try {
        const sseText = events.map(e => 'data: ' + JSON.stringify(e) + '\\n\\n').join('');
        _writeFileSync(cacheFile, JSON.stringify({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sseText }));
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
      
      const hash = _createHash('md5').update(JSON.stringify({ url, body: options?.body })).digest('hex');
      const cacheFile = _join2(CACHE_DIR, hash + '.json');
      
      if (_existsSync(cacheFile)) {
        console.log('[CACHE] HIT:', hash.slice(0, 8));
        const cached = JSON.parse(_readFileSync(cacheFile, 'utf-8'));
        return new Response(cached.body, { status: cached.status, headers: cached.headers });
      }
      
      const response = await originalFetch.apply(this, arguments);
      const body = await response.text();
      
      _writeFileSync(cacheFile, JSON.stringify({
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
      return code.replace('(function(exports, require, module, __filename, __dirname) {', '(function(exports, require, module, __filename, __dirname) {' + hook);
    }
  };
