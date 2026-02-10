import { fileURLToPath } from "node:url";

import { defineConfig } from "evalite/config";

// See: https://v1.evalite.dev/guides/configuration
export default defineConfig({
  testTimeout: 600000, // 600 seconds
  maxConcurrency: 6, // Run up to 6 tests in parallel
  hideTable: false, // Show the table of results
  viteConfig: {
    resolve: {
      alias: [
        { find: /^@mux\/ai\/workflows$/, replacement: fileURLToPath(new URL("./src/workflows/index.ts", import.meta.url)) },
        { find: /^@mux\/ai\/primitives$/, replacement: fileURLToPath(new URL("./src/primitives/index.ts", import.meta.url)) },
        { find: /^@mux\/ai\/types$/, replacement: fileURLToPath(new URL("./src/types.ts", import.meta.url)) },
        { find: /^@mux\/ai\/(.+)$/, replacement: fileURLToPath(new URL("./src/$1", import.meta.url)) },
        { find: "@mux/ai", replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
      ],
    },
  } as any,
});
