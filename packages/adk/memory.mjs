import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cwd } from 'node:process';

export function createMemory({ path: filePath } = {}) {
  const resolved = resolve(filePath ?? `${cwd()}/.claude/adk-memory.json`);

  function load() {
    try {
      return JSON.parse(readFileSync(resolved, 'utf8'));
    } catch {
      return {};
    }
  }

  function save(data) {
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, JSON.stringify(data, null, 2), 'utf8');
  }

  return {
    get(key) {
      return load()[key];
    },
    set(key, value) {
      const data = load();
      data[key] = value;
      save(data);
    },
    delete(key) {
      const data = load();
      delete data[key];
      save(data);
    },
    keys() {
      return Object.keys(load());
    },
    snapshot() {
      return load();
    },
  };
}
