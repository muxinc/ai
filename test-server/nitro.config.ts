import { fileURLToPath } from "node:url";

import { defineNitroConfig } from "nitro/config";

/*
 * Nitro automatically discovers files in the root directory where it is run
 * For that reason, we moved it to test-server because if it's in the root then
 * it tries to discover all the TS files in repo
 */
export default defineNitroConfig({
  modules: ["workflow/nitro"],
  compatibilityDate: "2024-01-01",
  alias: {
    "@mux/ai/workflows": fileURLToPath(new URL("../src/workflows/index.ts", import.meta.url)),
    "@mux/ai/primitives": fileURLToPath(new URL("../src/primitives/index.ts", import.meta.url)),
    "@mux/ai/types": fileURLToPath(new URL("../src/types.ts", import.meta.url)),
    "@mux/ai/env": fileURLToPath(new URL("../src/env.ts", import.meta.url)),
    "@mux/ai/lib": fileURLToPath(new URL("../src/lib", import.meta.url)),
    "@mux/ai": fileURLToPath(new URL("../src/index.ts", import.meta.url)),
  },
});
