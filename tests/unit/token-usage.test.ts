import { NoObjectGeneratedError } from "ai";
import { describe, expect, it } from "vitest";

import { MuxAiError, wrapError } from "../../src/lib/mux-ai-error";
import { getErrorTokenUsage, rethrowWithTokenUsage } from "../../src/lib/token-usage";
import type { TokenUsage } from "../../src/types";

function captureThrown(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected fn to throw");
}

describe("getErrorTokenUsage", () => {
  it("returns undefined for non-object errors and errors without usage", () => {
    expect(getErrorTokenUsage("boom")).toBeUndefined();
    expect(getErrorTokenUsage(null)).toBeUndefined();
    expect(getErrorTokenUsage(new Error("boom"))).toBeUndefined();
  });

  it("extracts the known numeric fields from a plain usage object", () => {
    const error = Object.assign(new Error("boom"), {
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, extraneous: "x" },
    });

    expect(getErrorTokenUsage(error)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it("falls back to nested AI SDK token details when flat fields are absent", () => {
    const error = new NoObjectGeneratedError({
      finishReason: "length",
      response: {
        id: "resp_123",
        modelId: "test-model",
        timestamp: new Date("2026-03-10T00:00:00.000Z"),
      },
      usage: {
        inputTokens: 50,
        inputTokenDetails: {
          noCacheTokens: 43,
          cacheReadTokens: 5,
          cacheWriteTokens: 2,
        },
        outputTokens: 10,
        outputTokenDetails: {
          textTokens: 7,
          reasoningTokens: 3,
        },
        totalTokens: 60,
      },
    });

    expect(getErrorTokenUsage(error)).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      reasoningTokens: 3,
      cachedInputTokens: 5,
      cacheWriteTokens: 2,
    });
  });
});

describe("rethrowWithTokenUsage", () => {
  it("rethrows the same error with aggregate usage attached", () => {
    const error = new Error("boom");
    const collected: TokenUsage[] = [
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
    ];

    const thrown = captureThrown(() => rethrowWithTokenUsage(error, collected));

    expect(thrown).toBe(error);
    expect((thrown as { usage?: TokenUsage }).usage).toEqual({
      inputTokens: 14,
      outputTokens: 11,
      totalTokens: 25,
    });
  });

  it("folds the error's own usage into the aggregate", () => {
    const error = Object.assign(new Error("boom"), {
      usage: { inputTokens: 3, totalTokens: 3 },
    });

    const thrown = captureThrown(() =>
      rethrowWithTokenUsage(error, [{ inputTokens: 10, outputTokens: 5, totalTokens: 15 }]));

    expect((thrown as { usage?: TokenUsage }).usage).toEqual({
      inputTokens: 13,
      outputTokens: 5,
      totalTokens: 18,
    });
  });

  it("leaves the error untouched when no usage was collected", () => {
    const error = new Error("boom");

    const thrown = captureThrown(() => rethrowWithTokenUsage(error, []));

    expect(thrown).toBe(error);
    expect(Object.hasOwn(thrown as object, "usage")).toBe(false);
  });

  it("rethrows non-object errors unchanged", () => {
    const thrown = captureThrown(() =>
      rethrowWithTokenUsage("boom", [{ inputTokens: 1 }]));

    expect(thrown).toBe("boom");
  });
});

describe("wrapError usage propagation", () => {
  it("carries usage from the original error onto the wrapped error", () => {
    const original = Object.assign(new Error("provider exploded"), {
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    const thrown = captureThrown(() => wrapError(original, "Failed to analyze"));

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Failed to analyze: provider exploded");
    expect((thrown as { usage?: TokenUsage }).usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it("does not add a usage property when the original error carries none", () => {
    const thrown = captureThrown(() => wrapError(new Error("boom"), "Failed"));

    expect(Object.hasOwn(thrown as object, "usage")).toBe(false);
  });

  it("rethrows MuxAiError instances as-is, preserving any attached usage", () => {
    const error = Object.assign(new MuxAiError("customer-safe"), {
      usage: { totalTokens: 7 },
    });

    const thrown = captureThrown(() => wrapError(error, "context"));

    expect(thrown).toBe(error);
    expect((thrown as { usage?: TokenUsage }).usage).toEqual({ totalTokens: 7 });
  });
});
