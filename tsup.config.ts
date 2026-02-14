import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/primitives/index.ts", "src/workflows/index.ts"],
  format: ["esm"], // Build ESM only
  dts: true, // Generate .d.ts files
  sourcemap: true,
  clean: true,
  splitting: false,
  external: [
    "@mux/mux-node",
    "dedent",
    "dotenv",
    "ai",
    "@ai-sdk/amazon-bedrock",
    "@ai-sdk/openai",
    "@ai-sdk/anthropic",
    "@ai-sdk/google",
    "@ai-sdk/google-vertex",
    "@noble/ciphers",
    "p-retry",
    "workflow",
    "zod",
  ],
});
