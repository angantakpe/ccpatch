import path from 'node:path';
import { fileURLToPath } from 'node:url';

// runner/ is one level below the project root.
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Build the canonical storage-directory paths rooted at `root`.
 * Pass a temp dir in tests to isolate storage writes from the project tree.
 *
 * @param {string} root - project root (or test tmpdir)
 * @returns {{ outputs: string, diagnostics: string, logs: string }}
 */
export function makeStoragePaths(root) {
  return {
    outputs: path.join(root, 'storage', 'outputs'),
    diagnostics: path.join(root, 'storage', 'diagnostics'),
    logs: path.join(root, 'storage', 'logs'),
  };
}
