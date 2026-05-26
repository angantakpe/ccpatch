// Leveled logger for the CLI. Replaces the bare console-pass-through that
// every subcommand used to inherit from `console`.
//
// Levels (lower = more important):
//   silent (0) — emit nothing
//   error  (1) — only error()
//   warn   (2) — error() + warn()
//   info   (3) — error() + warn() + log()                  ← default
//   debug  (4) — everything, including debug()
//
// The logger object intentionally exposes the same .log / .warn / .error
// surface as the console so callers that were already passing { log, warn,
// error } shaped loggers keep working untouched. We just gate each call by
// the current level.

const LEVELS = Object.freeze({
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
});

// Public list of valid level strings. Kept as a constant (not exported)
// because every consumer in-tree wants validation done by extractGlobalFlags.
const LOG_LEVEL_NAMES = Object.freeze(Object.keys(LEVELS));
// silence "declared but never used" for type-stripping lint; referenced once
// here so future TypeScript work has a single source of truth.
void LOG_LEVEL_NAMES;

/**
 * Parse `--log-level=<lvl>`, `--log-level <lvl>`, and `--quiet` out of an argv
 * array. The flags are consumed (returned removedArgs is a copy of `args`
 * with the level flags removed), so downstream parsers don't have to think
 * about them.
 *
 * Returns: { level, json, args }
 *   - level: one of LOG_LEVEL_NAMES
 *   - json:  true iff --json appears (also consumed)
 *   - args:  copy of input with global flags stripped
 */
export function extractGlobalFlags(args) {
  let level = 'info';
  let json = false;
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--quiet' || a === '-q') {
      level = 'error';
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--log-level' && args[i + 1]) {
      const v = String(args[++i]);
      if (Object.prototype.hasOwnProperty.call(LEVELS, v)) level = v;
      continue;
    }
    if (a.startsWith('--log-level=')) {
      const v = a.slice('--log-level='.length);
      if (Object.prototype.hasOwnProperty.call(LEVELS, v)) level = v;
      continue;
    }
    out.push(a);
  }
  if (process.env.CCPATCH_LOG_LEVEL
      && Object.prototype.hasOwnProperty.call(LEVELS, process.env.CCPATCH_LOG_LEVEL)) {
    level = process.env.CCPATCH_LOG_LEVEL;
  }
  return { level, json, args: out };
}

/**
 * Build a logger at the given level. Optionally wraps an underlying sink
 * (defaults to console). When `level === 'silent'`, every method becomes a
 * no-op. When `json` is true, info/log writes go to stderr so stdout stays
 * clean for the final JSON payload.
 */
export function makeLogger({ level = 'info', sink = console, json = false } = {}) {
  const n = LEVELS[level] ?? LEVELS.info;
  const noop = () => {};
  const out = (...a) => {
    if (json) {
      try { process.stderr.write(a.map(String).join(' ') + '\n'); }
      catch (_) { sink.log(...a); }
    } else {
      sink.log(...a);
    }
  };
  const warnFn = (...a) => {
    if (json) { try { process.stderr.write('WARN: ' + a.map(String).join(' ') + '\n'); } catch (_) { sink.warn(...a); } }
    else sink.warn(...a);
  };
  const errFn = (...a) => {
    if (json) { try { process.stderr.write('ERROR: ' + a.map(String).join(' ') + '\n'); } catch (_) { sink.error(...a); } }
    else sink.error(...a);
  };
  return {
    level,
    json,
    log:   n >= LEVELS.info  ? out    : noop,
    info:  n >= LEVELS.info  ? out    : noop,
    warn:  n >= LEVELS.warn  ? warnFn : noop,
    error: n >= LEVELS.error ? errFn  : noop,
    debug: n >= LEVELS.debug ? out    : noop,
  };
}
