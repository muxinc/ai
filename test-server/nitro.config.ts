import { defineNitroConfig } from "nitro/config";

/*
 * Nitro automatically discovers files in the root directory where it is run
 * For that reason, we moved it to test-server because if it's in the root then
 * it tries to discover all the TS files in repo
 */
export default defineNitroConfig({
  modules: ["workflow/nitro"],
  compatibilityDate: "2024-01-01",
  rootDir: "./",
  serverDir: "./",
});
