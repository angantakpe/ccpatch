import { EventEmitter } from 'node:events';
import { getAgent } from './agent.mjs';
import { defineTool } from './tool-registry.mjs';

let _handoffSeq = 0;
let _swapWarned = false;

function busEmit(topic, payload) {
  const bus = globalThis.__ccpBus;
  if (bus) try { bus.emit(topic, payload); } catch (_) {}
}

/**
 * Convert an ADK agent definition (defineAgent shape) into the Claude Code
 * agent-definition shape that __ccpAgentTool.invoke can merge into
 * options.agentDefinitions.activeAgents. Returns null if `def` is falsy.
 *
 * CC consumes `getSystemPrompt({ toolUseContext })` (a function), not a
 * `systemPrompt` string; `source` must not be "built-in"/"plugin" so the def is
 * treated as user-provided.
 */
function toCcAgentDef(def) {
  if (!def || !def.name) return null;
  const systemPrompt = typeof def.systemPrompt === 'string' ? def.systemPrompt : '';
  return {
    agentType: def.name,
    whenToUse: def.description || `The ${def.name} agent.`,
    tools: Array.isArray(def.tools) && def.tools.length ? def.tools : ['*'],
    source: 'user',
    baseDir: 'ccpatch-adk',
    getSystemPrompt: () => systemPrompt,
    ...(def.model ? { model: def.model } : {}),
  };
}

/**
 * defineHandoff — register a tool-call-driven handoff to `target`.
 *
 * The model triggers the handoff by calling the injected `transfer_to_<target>`
 * tool. See HANDOFF.md for the protocol and the two transfer modes.
 *
 *   defineHandoff({ target, mode, description, toolName, inputSchema, promptKey })
 *
 * mode 'delegate' (default): spawn `target` as an isolated subagent via
 *   __ccpAgentTool.invoke and return its final text into the caller's tool_result.
 * mode 'swap': true in-place persona swap — gated on globalThis.__ccpSetSystemPrompt.
 *   When that primitive is absent, degrades to 'delegate' and emits handoff.degraded.
 *
 * Returns the injected tool definition.
 */
export function defineHandoff({
  target,
  mode = 'delegate',
  description,
  toolName,
  inputSchema,
  promptKey = 'task',
} = {}) {
  if (typeof target !== 'string' || !target) {
    throw new Error('defineHandoff: `target` must be a non-empty string');
  }
  if (mode !== 'delegate' && mode !== 'swap') {
    throw new Error(`defineHandoff: unknown mode "${mode}" (expected 'delegate' | 'swap')`);
  }

  const name = toolName || `transfer_to_${target}`;
  const schema = inputSchema || {
    type: 'object',
    properties: {
      [promptKey]: { type: 'string', description: `What to hand to the ${target} agent.` },
    },
    required: [promptKey],
  };

  return defineTool({
    name,
    description: description || `Hand off the current work to the "${target}" agent.`,
    inputSchema: schema,
    execute: async (input) => {
      const id = `ho-${++_handoffSeq}`;
      const from = globalThis.__ccp_path || 'root';
      const prompt = (input && typeof input[promptKey] === 'string') ? input[promptKey] : '';
      const startMs = Date.now();

      // Resolve effective mode: 'swap' degrades to 'delegate' when the
      // system-prompt-override primitive is missing.
      let effectiveMode = mode;
      if (mode === 'swap' && typeof globalThis.__ccpSetSystemPrompt !== 'function') {
        effectiveMode = 'delegate';
        busEmit('handoff.degraded', {
          id, target, requested: 'swap', used: 'delegate',
          reason: '__ccpSetSystemPrompt not available',
        });
        if (!_swapWarned) {
          _swapWarned = true;
          try {
            console.warn(`[adk:handoff] swap mode unavailable (no __ccpSetSystemPrompt) — using delegate for "${target}"`);
          } catch (_) {}
        }
      }

      busEmit('handoff.start', { id, from, target, mode: effectiveMode });

      try {
        let resultText;

        if (effectiveMode === 'swap') {
          const def = getAgent(target);
          if (!def || typeof def.systemPrompt !== 'string') {
            throw new Error(`swap handoff: agent "${target}" has no systemPrompt (define it via defineAgent)`);
          }
          globalThis.__ccpSetSystemPrompt(def.systemPrompt);
          resultText = `Handed off to "${target}" — persona swapped in place.`;
        } else {
          const agentTool = globalThis.__ccpAgentTool;
          if (!agentTool || typeof agentTool.invoke !== 'function') {
            throw new Error('delegate handoff: __ccpAgentTool.invoke not available (enable expose_agent_tool)');
          }
          // If `target` is an ADK-registered agent, bridge its definition into
          // the dispatch ctx so the non-native subagent_type resolves. Native
          // CC subagent types (no ADK registration) pass agentDef: undefined and
          // resolve against the live activeAgents list as before.
          const adkDef = toCcAgentDef(getAgent(target));
          const res = await agentTool.invoke({
            subagent_type: target,
            prompt,
            description: `handoff to ${target}`,
            background: false,
            ...(adkDef ? { agentDef: adkDef } : {}),
          });
          resultText = (res && typeof res.text === 'string') ? res.text : String(res ?? '');
        }

        busEmit('handoff.end', { id, target, mode: effectiveMode, ok: true, ms: Date.now() - startMs });
        return resultText;
      } catch (err) {
        busEmit('handoff.end', { id, target, mode: effectiveMode, ok: false, ms: Date.now() - startMs });
        const msg = err && err.message ? err.message : String(err);
        return `Handoff to "${target}" failed: ${msg}`;
      }
    },
  });
}

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
