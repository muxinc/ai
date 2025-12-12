import { defineConfig } from "vitest/config";
import { workflow } from "workflow/vite";

export default defineConfig({
  plugins: [workflow()],
  test: {
    include: ["**/*.test.workflowdevkit.ts"],
    testTimeout: 300000,
    globalSetup: "./vitest.workflowdevkit.setup.ts",
  },
});
