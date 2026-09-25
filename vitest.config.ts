import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'MeterItPro/frontend/vitest.config.ts',
      'MeterItPro/api/vitest.config.ts',
      'MeterItProSync/api/vitest.config.ts',
      'MeterItProSync/mcp/vitest.config.ts',
      'TBWC/frontend/vitest.config.ts',
      'TBWC/api/vitest.config.ts',
    ],
  },
});
