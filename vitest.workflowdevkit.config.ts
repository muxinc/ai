import { defineConfig } from 'vitest/config';
import { workflow } from "workflow/vite";

export default defineConfig({
  plugins: [workflow()],
  test: {
    include: ['**/*.test.workflowdevkit.ts'],
    testTimeout: 30000,
    globalSetup: './vitest.workflowdevkit.setup.ts',
  },
});

