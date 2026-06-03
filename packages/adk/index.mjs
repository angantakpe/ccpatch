export { defineAgent } from './agent.mjs';
export { defineTool } from './tool-registry.mjs';
export { createMemory } from './memory.mjs';
export { AgentRouter } from './handoff.mjs';

export function useAgentBus() {
  const bus = globalThis.__ccpBus;
  if (!bus) throw new Error('useAgentBus: __ccpBus not available — ensure event_bus patch is applied');
  return bus;
}
