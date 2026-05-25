import fs from 'node:fs';
import path from 'node:path';

export function readText(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

export function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function fileExists(filePath) {
  return fs.existsSync(filePath);
}

export function writeJSON(filePath, data) {
  writeText(filePath, JSON.stringify(data, null, 2));
}

export function elapsed(startMs) {
  const ms = Date.now() - startMs;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

let _verbose = false;
export function setVerbose(v) { _verbose = v; }

export function log(phase, msg) {
  console.log(`[${phase}] ${msg}`);
}

export function verbose(phase, msg) {
  if (_verbose) console.log(`[${phase}] ${msg}`);
}
