import { EventEmitter } from 'node:events';
import { getAgent } from './agent.mjs';

export class AgentRouter extends EventEmitter {
  #agents = new Map();
  #active = null;

  register(agentDef) {
    this.#agents.set(agentDef.name, agentDef);
  }

  async start(agentName) {
    const def = this.#agents.get(agentName) ?? getAgent(agentName);
    if (!def) throw new Error(`AgentRouter: unknown agent "${agentName}"`);

    this.#active = agentName;

    const submit = globalThis.__ccpSubmitInput;
    if (typeof submit === 'function') {
      await submit(def.systemPrompt);
    }

    this.#scheduleHandoff(def);
  }

  #scheduleHandoff(def) {
    if (typeof def.handoff !== 'function') return;

    const context = { active: this.#active, agents: [...this.#agents.keys()] };

    Promise.resolve(def.handoff(context)).then(next => {
      if (typeof next === 'string' && next !== this.#active) {
        this.emit('transition', { from: this.#active, to: next });
        this.start(next);
      }
    }).catch(() => {});
  }
}
