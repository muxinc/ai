import { describe, expect, it } from "vitest";

import { classifiedErrorOf } from "../../src/lib/error-guards.ts";
import { LegacyMuxAiError } from "../../src/lib/legacy-mux-ai-error.ts";
import { MuxAiError, wrapError } from "../../src/lib/mux-ai-error.ts";
import { getErrorTokenUsage, rethrowWithTokenUsage } from "../../src/lib/token-usage.ts";

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

describe("classifiedErrorOf", () => {
  it("returns a classified error itself, including a non-transient one named FatalError", () => {
    const fatal = new MuxAiError("Bad request", { type: "validation_error", source: "request", cause: transientFailure() });
    expect(fatal.name).toBe("FatalError");
    expect(classifiedErrorOf(fatal)).toBe(fatal);
  });

  it("returns the classified error inside Workflow DevKit's retries-exhausted wrapper, whatever its message", () => {
    const failure = transientFailure();
    expect(classifiedErrorOf(retriesExhausted(failure))).toBe(failure);
    expect(classifiedErrorOf(retriesExhausted(failure, "Step \"x\" exceeded max retries (3 retries)"))).toBe(failure);
  });

  it("finds a classified error further down any cause chain", () => {
    const failure = transientFailure();
    const nested = Object.assign(new Error("outer"), { cause: Object.assign(new Error("middle"), { cause: failure }) });
    expect(classifiedErrorOf(nested)).toBe(failure);
  });

  it("stops at a legacy error: returns the SDK's (classified) one itself, and nothing for one that isn't classified", () => {
    const sdkLegacy = new LegacyMuxAiError("Unable to summarize.", { type: "processing_error", cause: transientFailure() });
    expect(classifiedErrorOf(sdkLegacy)).toBe(sdkLegacy);
    const consumerLegacy = Object.assign(new Error("Unable to render."), { __robots_error: true, publicMessage: "Unable to render.", cause: transientFailure() });
    expect(classifiedErrorOf(consumerLegacy)).toBeUndefined();
  });

  it("returns undefined with no classified error in the chain, a cycle, a chain past its depth, or a non-object", () => {
    const cyclic = new Error("a");
    Object.assign(cyclic, { cause: Object.assign(new Error("b"), { cause: cyclic }) });
    let deep: unknown = transientFailure();
    for (let i = 0; i < 5; i += 1) {
      deep = Object.assign(new Error(`level ${i}`), { cause: deep });
    }
    for (const value of [retriesExhausted(new Error("socket hang up")), cyclic, deep, "text", undefined, null]) {
      expect(classifiedErrorOf(value)).toBeUndefined();
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
