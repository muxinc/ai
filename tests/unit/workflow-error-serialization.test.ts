import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { applySwcTransform } from "@workflow/builders";
import { dehydrateStepError, hydrateStepError } from "@workflow/core/serialization";
import { build, transform } from "esbuild";
import { describe, expect, it } from "vitest";

import type { IncompleteGenerationError, isIncompleteGenerationError } from "../../src/lib/content-policy-error.ts";
import type { MuxAiError } from "../../src/lib/mux-ai-error.ts";

async function loadErrors(mode: "step" | "workflow") {
  const bundled = await build({
    stdin: {
      contents: `export { MuxAiError } from "./src/lib/mux-ai-error.ts";
        export { IncompleteGenerationError, isIncompleteGenerationError } from "./src/lib/content-policy-error.ts";`,
      resolveDir: fileURLToPath(new URL("../..", import.meta.url)),
      sourcefile: "workflow-errors.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    external: ["ai", "zod"],
    plugins: [{
      name: "test-env",
      setup(build) {
        build.onResolve({ filter: /\/env\.ts$/ }, () => ({ path: "env", namespace: "test-env" }));
        build.onLoad({ filter: /.*/, namespace: "test-env" }, () => ({ contents: "export default {};" }));
      },
    }],
  });
  const { code } = await applySwcTransform("workflow-errors.js", bundled.outputFiles[0].text, mode);
  const commonjs = await transform(code, { format: "cjs" });
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    console,
    TextEncoder,
    TextDecoder,
    ReadableStream,
    WritableStream,
    TransformStream,
    Headers,
    Request,
    Response,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
  };
  runInNewContext(`"use strict";\n${commonjs.code}`, context);
  return {
    global: runInNewContext("globalThis", context),
    ...module.exports as {
      MuxAiError: typeof MuxAiError;
      IncompleteGenerationError: typeof IncompleteGenerationError;
      isIncompleteGenerationError: typeof isIncompleteGenerationError;
    },
  };
}

describe("sDK errors across Workflow step boundaries", () => {
  it("preserves incomplete-generation metadata through the compiler and real serializer", async () => {
    const [step, workflow] = await Promise.all([loadErrors("step"), loadErrors("workflow")]);
    const usage = { inputTokens: 100, outputTokens: 1024, totalTokens: 1124, cachedInputTokens: 20 };
    const error = new step.IncompleteGenerationError("length", "MAX_TOKENS", usage);
    error.diagnostics = { phase: "length_repair", provider: "openai", modelId: "test-model", maxOutputTokens: 1024 };
    Object.defineProperty(error, "cause", { value: { prompt: "private source", headers: { authorization: "secret" } } });

    const bytes = await dehydrateStepError(error, "wrun_offline", undefined, [], step.global);
    const restored = await hydrateStepError(bytes, "wrun_offline", undefined, workflow.global);
    expect(workflow.isIncompleteGenerationError(restored)).toBe(true);
    expect(restored).toMatchObject({
      __robots_error: true,
      name: "FatalError",
      publicType: "processing_error",
      publicMessage: error.publicMessage,
      retryable: false,
      finishReason: "length",
      rawFinishReason: "MAX_TOKENS",
      usage,
      diagnostics: error.diagnostics,
      stack: error.stack,
    });
    expect(restored).not.toHaveProperty("cause");
    expect(JSON.stringify(restored)).not.toContain("private source");

    // The SDK's workflow catch rethrows into Robots: preserve a second crossing.
    const rethrown = await hydrateStepError(await dehydrateStepError(restored, "wrun_offline", undefined, [], workflow.global), "wrun_offline", undefined, step.global);
    expect(step.isIncompleteGenerationError(rethrown)).toBe(true);
    expect(rethrown).toMatchObject({ usage, diagnostics: error.diagnostics });
  });

  it("preserves customer-safe error classification and attached usage", async () => {
    const [step, workflow] = await Promise.all([loadErrors("step"), loadErrors("workflow")]);
    const error = new step.MuxAiError("Unable to complete text generation.", { type: "processing_error", retryable: true });
    error.usage = { totalTokens: 300 };
    const restored = await hydrateStepError(await dehydrateStepError(error, "wrun_offline", undefined, [], step.global), "wrun_offline", undefined, workflow.global);
    expect(workflow.MuxAiError.is(restored)).toBe(true);
    expect(restored).toMatchObject({ retryable: true, publicType: "processing_error", usage: { totalTokens: 300 } });
    expect(workflow.isIncompleteGenerationError(restored)).toBe(false);
  });
});
