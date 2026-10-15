// Self-contained Vitest config used ONLY by grade.sh. It deliberately ignores the
// workspace's vite/vitest/postcss config so grading cannot be affected by edits to them.
// grade.sh copies this directory into the workspace copy, one level below its root.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hiddenDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(hiddenDir, '..');
const hiddenDirName = path.basename(hiddenDir);

export default {
  root,
  // Transform JSX with the automatic runtime regardless of the workspace tsconfig.
  esbuild: { jsx: 'automatic' },
  // Inline PostCSS config: never load the workspace's postcss/tailwind config.
  css: { postcss: { plugins: [] } },
  test: {
    root,
    include: [`${hiddenDirName}/**/*.hidden.test.{ts,tsx}`],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    globals: false,
    setupFiles: [],
    watch: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    unstubGlobals: true,
    restoreMocks: true,
  },
};
