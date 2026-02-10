import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
import { workflow } from "workflow/vite";

export default defineConfig({
  plugins: [workflow()],
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
    include: ["**/*.test.workflowdevkit.ts"],
    testTimeout: 600000,
    globalSetup: "./vitest.workflowdevkit.setup.ts",
  },
});
