import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/primitives/index.ts", "src/workflows/index.ts"],
  format: ["esm"], // Build ESM only
  dts: true, // Generate .d.ts files
  sourcemap: true,
  clean: true,
  splitting: false,
  external: [
    "@aws-sdk/client-s3",
    "@aws-sdk/lib-storage",
    "@aws-sdk/s3-request-presigner",
    "@mux/mux-node",
    "dedent",
    "dotenv",
    "ai",
    "@ai-sdk/openai",
    "@ai-sdk/anthropic",
    "@ai-sdk/google",
    "p-retry",
    "workflow",
    "zod",
  ],
});
