import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@mux\/ai\/workflows$/, replacement: fileURLToPath(new URL("./src/workflows/index.ts", import.meta.url)) },
      { find: /^@mux\/ai\/primitives$/, replacement: fileURLToPath(new URL("./src/primitives/index.ts", import.meta.url)) },
      { find: /^@mux\/ai\/types$/, replacement: fileURLToPath(new URL("./src/types.ts", import.meta.url)) },
      { find: /^@mux\/ai\/(.+)$/, replacement: fileURLToPath(new URL("./src/$1", import.meta.url)) },
      { find: "@mux/ai", replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
    ],
  },
  test: {
    globals: true,
    environment: "node",
    testTimeout: 300000, // 300 seconds for integration tests
    fileParallelism: false, // Run test files sequentially to avoid rate limits and reduce API costs
  },
});
