import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lifecycle hooks (optional, declared on the patch module):
 *
 *   onBeforeApply(ctx)  — called before resolveAt/compileKind/apply. May mutate
 *                          ctx.opts (the per-invocation patchOptions) or ctx.code.
 *   onAfterApply(ctx)   — called after apply() (and any fallback-diff) returns.
 *                          May mutate ctx.appliedCode for last-mile fixups.
 *   onVerifyFail(ctx)   — called when checkVerify() finds issues. Return a string
 *                          to re-run verify against that string (one retry max);
 *                          return undefined/anything else to give up.
 *
 * ctx is a single per-patch object reused across all hook invocations. Fields:
 *   name, phase, code, appliedCode, opts, verify.issues, attempt, logger.
 * Hook errors are logged ([hook] <name>.<hookName>) and treated as the
 * surrounding step's failure (apply throw / verify fail). Not swallowed.
 * Each hook fire writes one JSONL entry to storage/diagnostics/patch-lifecycle.jsonl.
 */
export async function fireHook(patch, hookName, ctx, logger) {
  const fn = patch[hookName];
  if (typeof fn !== 'function') return { ok: true, result: undefined };
  const start = Date.now();
  const beforeLen = (typeof ctx.appliedCode === 'string') ? ctx.appliedCode.length
                  : (typeof ctx.code === 'string') ? ctx.code.length : 0;
  let entry = {
    ts: new Date().toISOString(),
    patch: ctx.name,
    hook: hookName,
    attempt: ctx.attempt,
    phase: ctx.phase,
  };
  try {
    const result = await fn(ctx);
    const afterLen = (typeof ctx.appliedCode === 'string') ? ctx.appliedCode.length
                   : (typeof ctx.code === 'string') ? ctx.code.length : 0;
    entry.byteDelta = afterLen - beforeLen;
    entry.durationMs = Date.now() - start;
    writeLifecycleEntry(entry);
    return { ok: true, result };
  } catch (err) {
    entry.durationMs = Date.now() - start;
    entry.error = err && err.message ? err.message : String(err);
    writeLifecycleEntry(entry);
    logger.error(`  [hook] ${ctx.name}.${hookName} threw: ${entry.error}`);
    return { ok: false, error: err };
  }
}

export function writeLifecycleEntry(entry) {
  try {
    mkdirSync('storage/diagnostics', { recursive: true });
    appendFileSync(join('storage/diagnostics', 'patch-lifecycle.jsonl'),
                   JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) { /* non-fatal */ }
}
