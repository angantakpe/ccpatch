const queue = [];
let drained = false;

function tryInject(toolDef) {
  const getRaw = globalThis.__ccpRawTools;
  // __ccpRawTools is an array reference stashed by expose_tool_dispatch.
  // Mutating it in-place makes the injected tool visible to the live formatter
  // without requiring a re-patch of the tool pipeline.
  if (Array.isArray(getRaw)) {
    const existing = getRaw.findIndex(t => t && t.name === toolDef.name);
    const toolObj = {
      name: toolDef.name,
      description: toolDef.description,
      inputSchema: toolDef.inputSchema,
      // Matches the call(input, toolUseContext, toolUseId, extra, progressCb) shape.
      call: async (input) => {
        const result = await toolDef.execute(input);
        return typeof result === 'string' ? [{ type: 'text', text: result }] : result;
      },
    };
    if (existing >= 0) {
      getRaw[existing] = toolObj;
    } else {
      getRaw.push(toolObj);
    }
    return true;
  }
  return false;
}

function drainQueue() {
  if (drained) return;
  drained = true;
  for (const def of queue) tryInject(def);
  queue.length = 0;
}

// Poll until __ccpRawTools is available, then drain. Runs at most once.
let pollHandle = null;
function scheduleDrain() {
  if (pollHandle !== null) return;
  pollHandle = setInterval(() => {
    if (Array.isArray(globalThis.__ccpRawTools)) {
      clearInterval(pollHandle);
      pollHandle = null;
      drainQueue();
    }
  }, 50);
}

export function defineTool({ name, description, inputSchema, execute }) {
  const def = { name, description, inputSchema, execute };
  if (!tryInject(def)) {
    queue.push(def);
    scheduleDrain();
  }
  return def;
}
