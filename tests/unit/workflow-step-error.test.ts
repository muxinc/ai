import { describe, expect, it } from "vitest";

import { LegacyMuxAiError } from "../../src/lib/legacy-mux-ai-error.ts";
import { MuxAiError, wrapError } from "../../src/lib/mux-ai-error.ts";
import { getErrorTokenUsage, rethrowWithTokenUsage } from "../../src/lib/token-usage.ts";
import { unwrapWorkflowStepError } from "../../src/lib/workflow-step-error.ts";

/** What Workflow DevKit throws into the workflow once a step's last attempt fails. */
function retriesExhausted(cause: unknown, message = "Step \"step//summarize\" failed after 3 retries: Provider unavailable") {
  return Object.assign(new Error(message), { name: "FatalError", fatal: true, cause });
}

function transientFailure() {
  return Object.assign(new MuxAiError("Provider unavailable", {
    code: "provider_unavailable",
    type: "capacity_error",
    source: "upstream",
    dependency: "ai_provider",
    facts: { call: "summarize", status: 503 },
  }), { usage: { inputTokens: 40, outputTokens: 2, totalTokens: 42 } });
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("unwrapWorkflowStepError", () => {
  it("returns the classified error inside a retries-exhausted wrapper", () => {
    const failure = transientFailure();
    expect(unwrapWorkflowStepError(retriesExhausted(failure))).toBe(failure);
  });

  it("recognizes the wrapper by shape, not by Workflow DevKit's message", () => {
    const failure = transientFailure();
    expect(unwrapWorkflowStepError(retriesExhausted(failure, "Step \"x\" exceeded max retries (3 retries)"))).toBe(failure);
  });

  it("leaves a classified error as it is, including a non-transient one named FatalError", () => {
    const fatal = new MuxAiError("Bad request", { type: "validation_error", source: "request", cause: transientFailure() });
    expect(fatal.name).toBe("FatalError");
    expect(unwrapWorkflowStepError(fatal)).toBe(fatal);
  });

  it("leaves a legacy error, a wrapper around an unclassified cause, and other values unchanged", () => {
    const legacy = new LegacyMuxAiError("Unable to summarize.", { type: "processing_error", cause: transientFailure() });
    const plainCause = retriesExhausted(new Error("socket hang up"));
    const notFatal = Object.assign(new Error("boom"), { cause: transientFailure() });
    for (const value of [legacy, plainCause, notFatal, "text", undefined, null]) {
      expect(unwrapWorkflowStepError(value)).toBe(value);
    }
  });
});

describe("a step's error after Workflow DevKit wrapped it", () => {
  it("wrapError rethrows the classified error, with the site's facts merged in", () => {
    const failure = transientFailure();
    const error = thrown(() => wrapError(retriesExhausted(failure), "Failed to summarize", { assetId: "asset_1" }));
    expect(error).toBe(failure);
    expect(error).toMatchObject({ code: "provider_unavailable", type: "capacity_error", facts: { call: "summarize", status: 503, assetId: "asset_1" } });
  });

  it("rethrowWithTokenUsage rethrows the classified error with the collected usage added", () => {
    const failure = transientFailure();
    const error = thrown(() => rethrowWithTokenUsage(retriesExhausted(failure), [{ inputTokens: 100, outputTokens: 10, totalTokens: 110 }]));
    expect(error).toBe(failure);
    expect(error).toMatchObject({ code: "provider_unavailable", usage: { inputTokens: 140, outputTokens: 12, totalTokens: 152 } });
  });

  it("getErrorTokenUsage reads the usage the step's error carries", () => {
    expect(getErrorTokenUsage(retriesExhausted(transientFailure()))).toEqual({ inputTokens: 40, outputTokens: 2, totalTokens: 42 });
  });

  it("an unclassified step failure is still wrapped as this code's own failure", () => {
    const error = thrown(() => wrapError(retriesExhausted(new Error("socket hang up")), "Failed to summarize"));
    expect(error).toMatchObject({ type: "server_error", source: "internal" });
  });
});
