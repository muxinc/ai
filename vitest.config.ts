import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60000, // 60 seconds for integration tests
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true, // Run test files sequentially to avoid rate limits and reduce API costs
      },
    },
  },
});
