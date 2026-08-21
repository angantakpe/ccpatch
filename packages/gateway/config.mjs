/**
 * Minimal env-based config loader for the gateway entrypoint (run.mjs).
 * Kept separate from run.mjs so tests can exercise config parsing without
 * spawning a process or touching real env vars.
 */
export function loadConfig(env = process.env) {
  const adapters = (env.GATEWAY_ADAPTERS || 'telegram')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    bridge: {
      addr: env.CC_BRIDGE_ADDR,
      token: env.CC_BRIDGE_TOKEN,
    },
    adapters,
  };
}

export default loadConfig;
