const registry = new Map();

export function defineAgent({ name, description, systemPrompt, tools = [], handoff = null }) {
  const def = { name, description, systemPrompt, tools, handoff };
  registry.set(name, def);
  return def;
}

export function getAgent(name) {
  return registry.get(name) ?? null;
}

export function listAgents() {
  return [...registry.values()];
}
