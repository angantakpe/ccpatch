/**
 * ChannelAdapter contract — the interface every gateway channel adapter
 * (telegram.mjs, and future discord/slack/stdio adapters) must satisfy.
 *
 * Deliberately minimal: a name plus start/stop. Everything channel-specific
 * (auth, allowlisting, message formatting) lives inside the adapter itself;
 * everything session-specific (submit/dispatch/subscribe, the event stream)
 * comes in through the shared BridgeClient instance passed to start().
 *
 * @typedef {object} GatewayContext
 * @property {import('./bridge-client.mjs').BridgeClient} bridge - shared, already-connected bridge client
 * @property {(...args: any[]) => void} log - adapter-scoped logger
 *
 * @typedef {object} ChannelAdapter
 * @property {string} name
 * @property {(ctx: GatewayContext) => Promise<void> | void} start
 * @property {() => Promise<void> | void} stop
 */

/** Runtime shape check — used by run.mjs before wiring an adapter in. */
export const isChannelAdapter = (obj) =>
  !!obj &&
  typeof obj.name === 'string' &&
  typeof obj.start === 'function' &&
  typeof obj.stop === 'function';
