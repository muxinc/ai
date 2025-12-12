import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 120000, // 120 seconds for integration tests
    fileParallelism: false, // Run test files sequentially to avoid rate limits and reduce API costs
  },
});
