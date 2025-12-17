import { defineConfig } from "evalite/config";

// See: https://v1.evalite.dev/guides/configuration
export default defineConfig({
  testTimeout: 120000, // 120 seconds (CI can be slower)
  maxConcurrency: 6, // Run up to 6 tests in parallel
  hideTable: false, // Show the table of results
});
