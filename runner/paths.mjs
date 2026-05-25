import path from 'node:path';
import { fileURLToPath } from 'node:url';

// runner/ is one level below the project root.
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
