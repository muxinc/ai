import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { applySwcTransform } from "@workflow/builders";
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { build, transform } from "esbuild";
import { describe, expect, it, vi } from "vitest";

import { WorkflowStorageClient } from "../../src/lib/workflow-storage-client.ts";

vi.mock("../../src/env.ts", () => ({ default: {} }));

describe("workflow storage client serialization", () => {
  const options = { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" };

  it("round-trips credentials without a Workflow compiler", () => {
    const serialized = WorkflowStorageClient[WORKFLOW_SERIALIZE](new WorkflowStorageClient(options));
    const restored = WorkflowStorageClient[WORKFLOW_DESERIALIZE](serialized);

    expect(restored).toBeInstanceOf(WorkflowStorageClient);
    expect(WorkflowStorageClient[WORKFLOW_SERIALIZE](restored)).toEqual(options);
  });

  it.each(["step", "workflow"] as const)("loads and round-trips a bundled client in %s mode", async (mode) => {
    const entryPoint = fileURLToPath(new URL("../../src/lib/workflow-storage-client.ts", import.meta.url));
    const bundled = await build({
      entryPoints: [entryPoint],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      target: "es2020",
      plugins: [{
        name: "test-env",
        setup(build) {
          build.onResolve({ filter: /\/env\.ts$/ }, () => ({ path: "env", namespace: "test-env" }));
          build.onLoad({ filter: /.*/, namespace: "test-env" }, () => ({ contents: "export default {};" }));
        },
      }],
    });
    const { code } = await applySwcTransform("workflow-storage-client.js", bundled.outputFiles[0].text, mode);
    const commonjs = await transform(code, { format: "cjs" });
    const module = { exports: {} };
    const context = { module, exports: module.exports, TextEncoder };

    // ESM is strict; preserve that behavior when evaluating the generated CommonJS.
    const { Client, registry } = runInNewContext(`"use strict";\n${commonjs.code}\n({
      Client: module.exports.WorkflowStorageClient,
      registry: globalThis[Symbol.for("workflow-class-registry")],
    })`, context) as {
      Client: typeof WorkflowStorageClient & { classId: string };
      registry: Map<string, unknown>;
    };
    expect(registry.get(Client.classId)).toBe(Client);

    const serialized = Client[WORKFLOW_SERIALIZE](new Client(options));
    const restored = Client[WORKFLOW_DESERIALIZE](serialized);
    expect(restored).toBeInstanceOf(Client);
    expect(Client[WORKFLOW_SERIALIZE](restored)).toEqual(options);
  });
});
