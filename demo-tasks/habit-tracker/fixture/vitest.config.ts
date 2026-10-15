import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Tests run in Node by default. UI test files opt into a browser-like DOM by
// starting with the comment:  // @vitest-environment jsdom
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
