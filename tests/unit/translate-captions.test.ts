import {
  APICallError,
  NoObjectGeneratedError,
  RetryError,
  TypeValidationError,
} from "ai";
import { describe, expect, it } from "vitest";

import type { TokenUsage } from "../../src/types";
import {
  aggregateTokenUsage,
  shouldSplitChunkTranslationError,
} from "../../src/workflows/translate-captions";

describe("aggregateTokenUsage", () => {
  it("preserves undefined for token fields that were never reported", () => {
    const usages: TokenUsage[] = [
      {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      {
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 10,
      },
    ];

    const result = aggregateTokenUsage(usages);

    expect(result).toEqual({
      inputTokens: 14,
      outputTokens: 11,
      totalTokens: 25,
    });
    expect(result.reasoningTokens).toBeUndefined();
    expect(result.cachedInputTokens).toBeUndefined();
  });

  it("sums optional token fields when at least one usage reports them", () => {
    const usages: TokenUsage[] = [
      {
        inputTokens: 10,
        reasoningTokens: 2,
      },
      {
        inputTokens: 6,
        cachedInputTokens: 3,
      },
    ];

    const result = aggregateTokenUsage(usages);

    expect(result).toEqual({
      inputTokens: 16,
      reasoningTokens: 2,
      cachedInputTokens: 3,
    });
  });
});

describe("shouldSplitChunkTranslationError", () => {
  it("fails fast for provider API errors like rate limits", () => {
    const apiCallError = new APICallError({
      message: "Rate limited",
      requestBodyValues: {},
      statusCode: 429,
      url: "https://api.example.test/v1/messages",
    });

    expect(shouldSplitChunkTranslationError(apiCallError)).toBe(false);
  });

  it("fails fast when retries still end in provider API errors", () => {
    const apiCallError = new APICallError({
      message: "Service unavailable",
      requestBodyValues: {},
      statusCode: 503,
      url: "https://api.example.test/v1/messages",
    });
    const retryError = new RetryError({
      message: "Retries exhausted",
      reason: "maxRetriesExceeded",
      errors: [apiCallError],
    });

    expect(shouldSplitChunkTranslationError(retryError)).toBe(false);
  });

  it("still allows splitting when object generation fails locally", () => {
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
          noCacheTokens: 50,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 10,
        outputTokenDetails: {
          textTokens: 10,
          reasoningTokens: undefined,
        },
        totalTokens: 60,
      },
    });

    expect(shouldSplitChunkTranslationError(error)).toBe(true);
  });

  it("does not split no-object errors caused by provider outages", () => {
    const error = new NoObjectGeneratedError({
      cause: new APICallError({
        message: "Gateway timeout",
        requestBodyValues: {},
        statusCode: 504,
        url: "https://api.example.test/v1/messages",
      }),
      finishReason: "error",
      response: {
        id: "resp_456",
        modelId: "test-model",
        timestamp: new Date("2026-03-10T00:00:00.000Z"),
      },
      usage: {
        inputTokens: 50,
        inputTokenDetails: {
          noCacheTokens: 50,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 0,
        outputTokenDetails: {
          textTokens: 0,
          reasoningTokens: undefined,
        },
        totalTokens: 50,
      },
    });

    expect(shouldSplitChunkTranslationError(error)).toBe(false);
  });

  it("allows splitting for schema validation failures", () => {
    const error = new TypeValidationError({
      value: { translations: ["hola"] },
      cause: new Error("Expected array to contain 2 items"),
    });

    expect(shouldSplitChunkTranslationError(error)).toBe(true);
  });
});
