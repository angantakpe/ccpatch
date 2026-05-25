export default {
  category: 'feature',

  description: 'Lazy MCP tool list: serve cached tools/list immediately, refresh cache in background',
  capabilities: ["network","tools"],
  verify: { present: '__mcpLazyInstalled__' },
  dependsOn: ['fetch_interceptor'],
  apply: (code) => {
    const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] MCP Lazy Tool Cache
//
// Problem: 18+ MCP servers each require an initialize + tools/list round-trip
//          at startup, adding ~500ms per server even with parallel connections.
//
// Solution:
//   1. After a successful tools/list response, save tools to a local cache.
//   2. On next startup, for tools/list POSTs, serve cached tools immediately
//      and refresh the cache in the background via a parallel real request.
//   3. initialize POSTs always go through (server needs to see them).
// ══════════════════════════════════════════════════════════════════════════

(async function __mcpLazyInit() {
  if (globalThis.__mcpLazyInstalled__) return;
  globalThis.__mcpLazyInstalled__ = true;

  const { join: _join } = await import('node:path');
  const { existsSync: _existsSync, readFileSync: _readFileSync, writeFileSync: _writeFileSync, mkdirSync: _mkdirSync } = await import('node:fs');

  // ── Cache helpers ──────────────────────────────────────────────────────

  const _mcpCacheDir = (() => {
    let d = process.cwd();
    for (let i = 0; i < 8; i++) {
      if (_existsSync(_join(d, '.cc'))) return _join(d, '.cc', 'cache');
      const p = _join(d, '..');
      if (p === d) break;
      d = p;
    }
    return _join(process.cwd(), '.cc', 'cache');
  })();

  const _mcpCachePath = _join(_mcpCacheDir, 'mcp-tools.json');

  /** @type {Record<string, {tools: any[], cachedAt: string}>} */
  const _cache = (() => {
    try { return JSON.parse(_readFileSync(_mcpCachePath, 'utf8')); } catch { return {}; }
  })();

  function _saveCache() {
    try {
      _mkdirSync(_mcpCacheDir, { recursive: true });
      _writeFileSync(_mcpCachePath, JSON.stringify(_cache, null, 2));
    } catch {}
  }

  // ── SSE response builder ───────────────────────────────────────────────

  function _makeSSE(id, result) {
    const payload = 'event: message\\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n\\n';
    const bytes   = new TextEncoder().encode(payload);
    const stream  = new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  }

  // ── Parse request body ─────────────────────────────────────────────────

  function _parseBody(options) {
    try {
      const b = options?.body;
      if (!b) return null;
      const s = typeof b === 'string' ? b : (b instanceof Buffer ? b.toString() : null);
      return s ? JSON.parse(s) : null;
    } catch { return null; }
  }

  // ── Track background refreshes to avoid before-hook re-entry ──────────

  const _bgKeys = new Set();

  // ── Before-hook: serve cached tools/list immediately ──────────────────

  if (typeof globalThis.__ccpOnFetchBefore === 'function') {
    globalThis.__ccpOnFetchBefore('mcp-lazy-cache', async (ctx) => {
      if (!ctx.url.includes('mcp-proxy.anthropic.com')) return null;
      if ((ctx.options?.method || 'GET').toUpperCase() !== 'POST') return null;

      const serverId = (ctx.url.match(/mcpsrv_\\w+/) || [])[0];
      if (!serverId) return null;

      const _wsScope = process.env.CC_WORKSPACE || 'default';
      const key = serverId + ':' + _wsScope;
      if (_bgKeys.has(key)) return null; // background refresh — pass through

      const rpc = _parseBody(ctx.options);
      if (!rpc || rpc.method !== 'tools/list') return null;

      const cached = _cache[serverId];
      if (!cached) return null; // no cache — let real request through

      // H-4: TTL check — discard entries older than 3600 seconds
      const _cachedAt = cached.cachedAt ? new Date(cached.cachedAt).getTime() : 0;
      if (Date.now() - _cachedAt > 3600 * 1000) {
        delete _cache[serverId];
        process.stderr.write('[mcp-lazy] ' + serverId.slice(-8) + ' cache expired — fetching fresh\\n');
        return null;
      }

      // Serve cache immediately, fire background refresh to update cache
      _bgKeys.add(key);
      setTimeout(() => {
        globalThis.fetch(ctx.url, ctx.options)
          .catch(() => {})
          .finally(() => { _bgKeys.delete(key); });
      }, 0);

      process.stderr.write('[mcp-lazy] ' + serverId.slice(-8) + ' tools/list → cache (' + cached.tools.length + ' tools)\\n');
      return _makeSSE(rpc.id, { tools: cached.tools });
    });
  }

  // ── After-hook: capture real tools/list responses → update cache ───────

  if (typeof globalThis.__ccpOnFetch === 'function') {
    globalThis.__ccpOnFetch('mcp-lazy-updater', ({ url, options, events }) => {
      if (!url || !url.includes('mcp-proxy.anthropic.com')) return;
      if ((options?.method || 'GET').toUpperCase() !== 'POST') return;
      if (!Array.isArray(events)) return;

      const serverId = (url.match(/mcpsrv_\\w+/) || [])[0];
      if (!serverId) return;

      for (const ev of events) {
        if (ev && ev.result && Array.isArray(ev.result.tools)) {
          const prev = _cache[serverId]?.tools?.length ?? '?';
          _cache[serverId] = { tools: ev.result.tools, cachedAt: new Date().toISOString() };
          _saveCache();
          process.stderr.write('[mcp-lazy] ' + serverId.slice(-8) + ' cache updated: ' + prev + ' → ' + ev.result.tools.length + ' tools\\n');
          break;
        }
      }
    });
  }
})().catch(() => {});

`;
        const _CJS_IIFE = '(function(exports, require, module, __filename, __dirname) {';
    if (code.includes('#!/usr/bin/env node')) {
      return code.replace('#!/usr/bin/env node', '#!/usr/bin/env node' + hook);
    } else if (code.includes(_CJS_IIFE)) {
      return code.replace(_CJS_IIFE, () => _CJS_IIFE + hook);
    } else {
      console.warn('  [!] anchor not found (no shebang, no CJS-IIFE) — skipping');
      return code;
    }
  },
};
