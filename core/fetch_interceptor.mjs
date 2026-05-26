// Module-level so `preloadCode` can expose it without duplication.
const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Shared Fetch Interceptor — single tee(), fan-out to all subscribers
// ══════════════════════════════════════════════════════════════════════════

globalThis.__ccpFetchSubscribers = globalThis.__ccpFetchSubscribers || [];
globalThis.__ccpFetchBeforeSubscribers = globalThis.__ccpFetchBeforeSubscribers || [];
globalThis.__ccpFetchStreamSubscribers = globalThis.__ccpFetchStreamSubscribers || [];

globalThis.__ccpOnFetch = (name, handler) => {
  if (!globalThis.__ccpFetchSubscribers.find(s => s.name === name)) {
    globalThis.__ccpFetchSubscribers.push({ name, handler });
  }
};

// Lower priority number = called first. Default 50. Kept sorted at registration time.
globalThis.__ccpOnFetchBefore = (name, handler, priority = 50) => {
  const subs = globalThis.__ccpFetchBeforeSubscribers;
  if (!subs.find(s => s.name === name)) {
    const sub = { name, handler, priority };
    const idx = subs.findIndex(s => s.priority > priority);
    if (idx === -1) subs.push(sub);
    else subs.splice(idx, 0, sub);
  }
};

// handler(event, abortFn) called per SSE event. abortFn() terminates the stream early.
globalThis.__ccpOnFetchStream = (name, handler) => {
  if (!globalThis.__ccpFetchStreamSubscribers.find(s => s.name === name)) {
    globalThis.__ccpFetchStreamSubscribers.push({ name, handler });
  }
};

function _ccpIsApiCall(urlStr, options) {
  if ((options?.method || 'GET') !== 'POST') return false;
  const _gwBase = process.env.ANTHROPIC_BASE_URL || '';
  return urlStr.includes('anthropic.com') ||
    (_gwBase && urlStr.startsWith(_gwBase) && urlStr.includes('/messages'));
}

// Tees a Response body and fans SSE events out to all registered subscribers.
// Handles non-streaming responses (events: null) and non-ok responses gracefully.
function _ccpFanOut(resp, urlStr, options, isApi) {
  const subscribers = globalThis.__ccpFetchSubscribers;
  const streamSubscribers = globalThis.__ccpFetchStreamSubscribers;
  const hasAfter = subscribers && subscribers.length > 0;
  const hasStream = streamSubscribers && streamSubscribers.length > 0;
  if (!hasAfter && !hasStream) return resp;
  if (!isApi || !resp.ok || !resp.body) {
    if (hasAfter) {
      for (const sub of subscribers) {
        try { sub.handler({ url: urlStr, options, response: resp, isApi, events: null }); } catch(e) {}
      }
    }
    return resp;
  }
  const streamAbort = new AbortController();
  const tee = resp.body.tee();
  const reader = tee[1].getReader();
  const dec = new TextDecoder();
  (async () => {
    const events = [];
    try {
      let remainder = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (streamAbort.signal.aborted) break;
        const chunk = remainder + dec.decode(value, { stream: true });
        const lines = chunk.split('\\n');
        remainder = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            events.push(ev);
            if (hasStream) {
              for (const sub of streamSubscribers) {
                try { sub.handler(ev, () => streamAbort.abort()); } catch(e) {}
              }
            }
          } catch(e) {}
        }
      }
      if (remainder && remainder.startsWith('data: ')) {
        try {
          const ev = JSON.parse(remainder.slice(6));
          events.push(ev);
          if (hasStream) {
            for (const sub of streamSubscribers) {
              try { sub.handler(ev, () => streamAbort.abort()); } catch(e) {}
            }
          }
        } catch(e) {}
      }
    } catch(e) {}
    if (hasAfter) {
      for (const sub of subscribers) {
        try { sub.handler({ url: urlStr, options, response: resp, isApi, events }); } catch(e) {}
      }
    }
  })();
  return new Response(tee[0], { status: resp.status, statusText: resp.statusText, headers: resp.headers });
}

if (!globalThis.__ccpFetchInterceptorInstalled__) {
  globalThis.__ccpFetchInterceptorInstalled__ = true;
  const __origFetch__ = globalThis.fetch;
  globalThis.__ccpOrigFetch = __origFetch__; // exposed for patches that need raw fetch (rate_limit, steer_drain)
  globalThis.fetch = async function ccpInterceptedFetch(url, options) {
    const urlStr = String(url?.url || url || '');
    const beforeSubscribers = globalThis.__ccpFetchBeforeSubscribers;
    if (beforeSubscribers && beforeSubscribers.length > 0) {
      const ctx = { url: urlStr, options, isApi: _ccpIsApiCall(urlStr, options) };
      for (const sub of beforeSubscribers) {
        const response = await sub.handler(ctx);
        if (response) {
          // Legacy short-circuit (subscriber returned a Response directly).
          // Does NOT tee/fan-out — prefer ctx._intercept for new subscribers.
          return response;
        }
        if (ctx.options !== options) options = ctx.options;
      }
      // Recompute isApi since options may have been mutated by before-subscribers.
      const isApi = _ccpIsApiCall(urlStr, options);
      // A before-subscriber may set ctx._intercept to a pre-fetched Response
      // (e.g. rate_limit retried internally) so after-subscribers still run.
      if (ctx._intercept) {
        const resp = ctx._intercept;
        ctx._intercept = null;
        return _ccpFanOut(resp, urlStr, options, isApi);
      }
      const resp = await __origFetch__(url, options);
      return _ccpFanOut(resp, urlStr, options, isApi);
    }
    const resp = await __origFetch__(url, options);
    return _ccpFanOut(resp, urlStr, options, _ccpIsApiCall(urlStr, options));
  };
}

`;

export default {
  category: 'infrastructure',
  // required: silent failure leaves all network-subscriber patches (cost_tracker, cache_responses, etc.) with no intercept bus.
  required: true,
  description: 'Shared fetch interceptor with fan-out SSE subscriber system (applied first in output)',
  capabilities: ["network"],
  verify: {
    present: '__ccpFetchInterceptorInstalled__',
    // Hook source references the sentinel exactly twice (guard + assignment).
    count: { present: 2 },
  },
  preload: true,
  preloadCode: hook,
  apply: (code) => {
    const __shebang__ = '#!/usr/bin/env node';
    const __cjsIife__ = '(function(exports, require, module, __filename, __dirname)';
    if (code.includes(__shebang__)) {
      return code.replace(__shebang__, () => __shebang__ + hook);
    } else if (code.includes(__cjsIife__)) {
      return code.replace(__cjsIife__, () => hook + __cjsIife__);
    }
    console.warn('  [!] patch: no shebang or CJS-IIFE anchor found — skipping');
    return code;
  },
};
