import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
    "@ai-sdk/openai",
    "@ai-sdk/anthropic",
    "@ai-sdk/google",
    "@noble/ciphers",
    "p-retry",
    "workflow",
    "zod",
  ],
  async onSuccess() {
    // esbuild emits anonymous class expressions for classes that don't
    // self-reference (e.g. `var Foo = class { ... }`). The Nitro workflow
    // bundler relies on the class expression name to register serialization
    // classes. Without a name it falls back to "AnonymousClass" which is
    // undefined at runtime. Re-insert the class name so the output becomes
    // `var Foo = class Foo { ... }` — semantically identical but gives Nitro
    // the identifier it needs.
    const distDir = resolve("dist");
    const files = ["index.js", "workflows/index.js", "primitives/index.js"];
    for (const file of files) {
      const filePath = join(distDir, file);
      try {
        let content = readFileSync(filePath, "utf-8");
        content = content.replace(
          /var (\w+) = class \{/g,
          "var $1 = class $1 {",
        );
        writeFileSync(filePath, content);
      } catch {
        // File may not exist yet (e.g. during incremental builds)
      }
    }
  },
});
