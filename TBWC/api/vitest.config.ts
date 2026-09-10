import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // scripts/ holds the catalog-image sweep; its family rules decide what
    // 400+ rows get pictured, so they are worth regression tests too.
    include: ['worker/**/*.test.ts', 'scripts/**/*.test.mjs'],
    exclude: ['node_modules', 'dist', 'dist-worker'],
    testTimeout: 10000,
  },
});
