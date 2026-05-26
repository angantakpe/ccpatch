export default {
    category: 'fix',

    description: 'Rate limiting: skip retries on subscription usage limits, cap Retry-After at 30s, surface error immediately',
    capabilities: ["network","env"],
    verify: { present: 'CC_RATE_LIMIT_PATCH_ENABLED', weak: true },
  dependsOn: ['fetch_interceptor'],
    apply: (code) => {
      const hook = `
// ══════════════════════════════════════════════════════════════════════════
// [PATCH] Rate Limiter + 429/529 Retry (with usage-limit fast-fail)
// ══════════════════════════════════════════════════════════════════════════

const RATE_LIMIT = {
  maxRequestsPerMinute: parseInt(process.env.CLAUDE_RATE_LIMIT) || 30,
  maxRetries: parseInt(process.env.CLAUDE_MAX_RETRIES) || 5,
  baseDelayMs: 2000,
  // Cap Retry-After to avoid silent 4-minute spins on usage limits
  maxRetryAfterMs: parseInt(process.env.CLAUDE_MAX_RETRY_AFTER_MS) || 30000,
  requests: [],
};

function _rlIsEnabled() {
  const patchEnabled = process.env.CC_RATE_LIMIT_PATCH_ENABLED;
  if (patchEnabled !== undefined && patchEnabled !== null) {
    const val = String(patchEnabled).trim().toLowerCase().split(/\\s+/)[0];
    return !['0', 'false', 'no', 'off'].includes(val);
  }
  return true;
}

// Read response body once and return both usage-limit flag and parsed reset time.
// Combines detection + extraction to avoid cloning the response body twice.
async function _rlInspectBody(response) {
  try {
    const bodyPromise = response.clone().text();
    const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000));
    const body = await Promise.race([bodyPromise, timeoutPromise]);
    const low = body.toLowerCase();

    if (process.env.CC_DEBUG && response.status >= 400) {
      process.stderr.write('[rate-limit-debug] Status ' + response.status + ' Body: ' + body.slice(0, 500) + '\\n');
    }

    const isUsage = (
      low.includes('hit your limit') ||
      low.includes('usage limit') ||
      low.includes('monthly limit') ||
      low.includes('monthly usage limit') ||
      low.includes('paused until') ||
      low.includes('exceeded your quota') ||
      low.includes('no remaining requests') ||
      low.includes('hit your org') ||
      low.includes('hit your account') ||
      low.includes('subscription limit') ||
      low.includes('credit balance') ||
      low.includes('limit reached') ||
      /resets\\s+(Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Jan|Feb|Mar|\\d)/i.test(body) ||
      /resets in \\d/.test(body)
    );

    let resetTime = null;
    if (isUsage) {
      const m = body.match(/resets\\s+([^"\\\\}\\n]{3,60})/i) || body.match(/resets in ([^"\\\\}\\n]{1,20})/i);
      resetTime = m ? m[1].trim() : null;
    }

    return { isUsage, resetTime };
  } catch (e) {
    return { isUsage: false, resetTime: null };
  }
}


// Register via __ccpOnFetchBefore at priority 5 (highest — throttle before any injection)
// Retry is done inline using globalThis.__ccpOrigFetch exposed by fetch_interceptor.
// Deferred via setTimeout(0): rate_limit is prepended after fetch_interceptor, so at runtime
// this code executes BEFORE fetch_interceptor installs __ccpOnFetchBefore. One tick defers
// past all synchronous module-level code, by which time __ccpOnFetchBefore is defined.
function _rlRegister() {
  if (typeof globalThis.__ccpOnFetchBefore !== 'function') return;
  if (globalThis.__ccpRateLimitRegistered) return;
  globalThis.__ccpRateLimitRegistered = true;
  globalThis.__ccpOnFetchBefore('rate_limit', async function(ctx) {
    // Priority 95 — runs last, after routing/context-injection/system-block-order.
    // Sets ctx._intercept (not return) so fetch_interceptor tee/fan-out still fires.
    if (!ctx.isApi || !_rlIsEnabled()) return;

    const urlStr = ctx.url;
    if (process.env.CC_DEBUG) process.stderr.write('[rate-limit-trace] POST ' + urlStr + '\\n');

    // Per-minute throttle
    const now = Date.now();
    RATE_LIMIT.requests = RATE_LIMIT.requests.filter(t => now - t < 60000);
    if (RATE_LIMIT.requests.length >= RATE_LIMIT.maxRequestsPerMinute) {
      const waitTime = 60000 - (now - RATE_LIMIT.requests[0]);
      process.stderr.write('[rate-limit] Throttling: waiting ' + Math.ceil(waitTime / 1000) + 's before next API call...\\n');
      try { if (globalThis.__ccpHooks) globalThis.__ccpHooks.fire('RateLimited', { reason: 'throttle', waitMs: waitTime, _displayContent: '⏳ Rate-throttled ' + Math.ceil(waitTime/1000) + 's' }); } catch(_) {}
      await new Promise(r => setTimeout(r, waitTime));
    }
    RATE_LIMIT.requests.push(Date.now());

    // Use raw original fetch for retry calls to avoid re-entering the interceptor
    const rawFetch = globalThis.__ccpOrigFetch || globalThis.fetch;
    let lastError;
    for (let attempt = 0; attempt <= RATE_LIMIT.maxRetries; attempt++) {
      try {
        const response = await rawFetch(ctx.url, ctx.options);
        if (response.status >= 400) {
          if (process.env.CC_DEBUG) process.stderr.write('[rate-limit-trace] Status ' + response.status + ' for ' + urlStr + '\\n');
          const retryAfterRaw = response.headers.get('retry-after');
          const retryAfterSec = retryAfterRaw ? parseInt(retryAfterRaw, 10) : 0;
          const { isUsage, resetTime } = retryAfterSec > 3600
            ? { isUsage: true, resetTime: null }
            : await _rlInspectBody(response);
          if (isUsage) {
            const msg = resetTime
              ? '\\n⚠ Daily usage limit reached · resets ' + resetTime + '\\n'
              : '\\n⚠ Daily usage limit reached — check claude.ai for reset time\\n';
            process.stderr.write(msg);
            process.stdout.write(msg);
            try { if (globalThis.__ccpHooks) globalThis.__ccpHooks.fire('RateLimited', { reason: 'usage_limit', resetTime: resetTime, fatal: true, _displayContent: '🚫 Usage limit reached' + (resetTime ? ' · resets ' + resetTime : '') }, { blocking: false }); } catch(_) {}
            process.exit(1);
          }
          if (response.status === 429 || response.status === 529) {
            const retryAfterMs = retryAfterSec
              ? Math.min(retryAfterSec * 1000, RATE_LIMIT.maxRetryAfterMs)
              : Math.min(RATE_LIMIT.baseDelayMs * Math.pow(2, attempt), 120000);
            const jitter = Math.random() * 1000;
            const totalDelay = retryAfterMs + jitter;
            if (attempt < RATE_LIMIT.maxRetries) {
              const reason = response.status === 429 ? 'rate-limited' : 'overloaded';
              process.stderr.write('[rate-limit] API ' + reason + ' (attempt ' + (attempt + 1) + '/' + RATE_LIMIT.maxRetries + '). Retrying in ' + (totalDelay / 1000).toFixed(1) + 's...\\n');
              try { if (globalThis.__ccpHooks) globalThis.__ccpHooks.fire('RateLimited', { reason: reason, status: response.status, retryAfterMs: totalDelay, attempt: attempt + 1, maxRetries: RATE_LIMIT.maxRetries, _displayContent: '⏳ API ' + reason + ' — retry ' + (attempt+1) + '/' + RATE_LIMIT.maxRetries }); } catch(_) {}
              await new Promise(r => setTimeout(r, totalDelay));
              try { if (globalThis.__ccpHooks) globalThis.__ccpHooks.fire('RateLimitRecovered', { status: response.status, attempt: attempt + 1, totalDelayMs: totalDelay, _displayContent: '✓ Rate limit recovered (attempt ' + (attempt+1) + ')' }, { silent: true }); } catch(_) {}
              continue;
            }
          }
        }
        // Set ctx._intercept so fetch_interceptor uses this response AND still
        // runs the tee/fan-out for after-subscribers (save_conversations, webhook).
        ctx._intercept = response;
        return;
      } catch (err) {
        lastError = err;
        if (attempt < RATE_LIMIT.maxRetries) {
          const delayMs = Math.min(RATE_LIMIT.baseDelayMs * Math.pow(2, attempt), 60000);
          process.stderr.write('[rate-limit] Network error (attempt ' + (attempt + 1) + '/' + RATE_LIMIT.maxRetries + '): ' + err.message + '. Retrying in ' + (delayMs / 1000).toFixed(1) + 's...\\n');
          try { if (globalThis.__ccpHooks) globalThis.__ccpHooks.fire('RateLimited', { reason: 'network_error', error: err.message, retryAfterMs: delayMs, attempt: attempt + 1, maxRetries: RATE_LIMIT.maxRetries, _displayContent: '⚠ Network error — retry ' + (attempt+1) + '/' + RATE_LIMIT.maxRetries }); } catch(_) {}
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }, 95);
}
if (typeof globalThis.__ccpOnFetchBefore === 'function') {
  _rlRegister();
} else {
  setTimeout(_rlRegister, 0);
}

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
    }
  };
