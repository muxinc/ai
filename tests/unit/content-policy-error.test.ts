import { APICallError, NoObjectGeneratedError, RetryError } from "ai";
import { describe, expect, it } from "vitest";

import {
  extractContentPolicyBlock,
  getGeneratedOutputWithContentPolicyHandling,
  rethrowContentPolicyError,
  withContentPolicyErrorHandling,
} from "../../src/lib/content-policy-error.ts";
import { wrapError } from "../../src/lib/mux-ai-error.ts";
import { withRetry } from "../../src/lib/retry.ts";

function createApiCallError(responseBody: string) {
  return new APICallError({
    message: "Invalid JSON response",
    url: "https://example.com/generate-content",
    requestBodyValues: {},
    statusCode: 200,
    responseBody,
  });
}

function createNoObjectGeneratedError(finishReason: "content-filter" | "error") {
  return new NoObjectGeneratedError({
    message: "No object generated",
    response: {
      id: "response-id",
      modelId: "model-id",
      timestamp: new Date("2026-07-31T00:00:00.000Z"),
    },
    usage: {
      inputTokens: 10,
      outputTokens: 0,
      totalTokens: 10,
      inputTokenDetails: {
        noCacheTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: {
        textTokens: 0,
        reasoningTokens: 0,
      },
    },
    finishReason,
  });
}

function captureThrown(operation: () => void): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw");
}

describe("content policy errors", () => {
  it("extracts a prompt block reason from an API call response body", () => {
    const error = createApiCallError(JSON.stringify({
      promptFeedback: {
        blockReason: "PROHIBITED_CONTENT",
        safetyRatings: [],
      },
      usageMetadata: {
        promptTokenCount: 100,
        totalTokenCount: 100,
      },
    }));

    expect(extractContentPolicyBlock(error)).toEqual({
      reason: "PROHIBITED_CONTENT",
      category: undefined,
    });
  });

  it("includes an explicitly blocked safety category", () => {
    const error = createApiCallError(JSON.stringify({
      promptFeedback: {
        blockReason: "SAFETY",
        safetyRatings: [
          {
            category: "HARM_CATEGORY_HARASSMENT",
            probability: "NEGLIGIBLE",
            blocked: false,
          },
          {
            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            probability: "HIGH",
            blocked: true,
          },
        ],
      },
    }));

    expect(extractContentPolicyBlock(error)).toEqual({
      reason: "SAFETY",
      category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    });
  });

  it("extracts candidate-side content policy finish reasons", () => {
    const error = createApiCallError(JSON.stringify({
      candidates: [
        {
          content: {},
          finishReason: "PROHIBITED_CONTENT",
          safetyRatings: [],
        },
      ],
    }));

    expect(extractContentPolicyBlock(error)).toEqual({
      reason: "PROHIBITED_CONTENT",
      category: undefined,
    });
  });

  it("normalizes provider-agnostic content-filter finish reasons", () => {
    expect(extractContentPolicyBlock(createNoObjectGeneratedError("content-filter"))).toEqual({
      reason: "CONTENT_FILTER",
    });
  });

  it("throws a provider-agnostic non-retryable content policy error", async () => {
    const error = createApiCallError(JSON.stringify({
      promptFeedback: {
        blockReason: "PROHIBITED_CONTENT",
      },
    }));

    await expect(withContentPolicyErrorHandling(async () => {
      throw error;
    })).rejects.toMatchObject({
      name: "FatalError",
      publicType: "content_policy_error",
      publicMessage: "The supplied content was blocked by a content policy (reason: PROHIBITED_CONTENT).",
      retryable: false,
    });
  });

  it("preserves token usage when normalizing content policy errors", async () => {
    const normalizedError = await withContentPolicyErrorHandling(async () => {
      throw createNoObjectGeneratedError("content-filter");
    }).catch(error => error);

    expect(normalizedError).toMatchObject({
      publicType: "content_policy_error",
      usage: {
        inputTokens: 10,
        outputTokens: 0,
        totalTokens: 10,
        reasoningTokens: 0,
        cachedInputTokens: 0,
      },
    });
  });

  it("preserves response-body usage when normalizing API content policy errors", async () => {
    const normalizedError = await withContentPolicyErrorHandling(async () => {
      throw createApiCallError(JSON.stringify({
        promptFeedback: {
          blockReason: "PROHIBITED_CONTENT",
        },
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 4,
          totalTokenCount: 106,
          cachedContentTokenCount: 25,
          thoughtsTokenCount: 2,
        },
      }));
    }).catch(error => error);

    expect(normalizedError).toMatchObject({
      publicType: "content_policy_error",
      usage: {
        inputTokens: 100,
        outputTokens: 6,
        totalTokens: 106,
        reasoningTokens: 2,
        cachedInputTokens: 25,
      },
    });
  });

  it("normalizes a content policy error returned after an AI SDK retry", async () => {
    const transientError = new APICallError({
      message: "Service unavailable",
      url: "https://example.com/generate-content",
      requestBodyValues: {},
      statusCode: 503,
    });
    const contentPolicyError = createApiCallError(JSON.stringify({
      promptFeedback: {
        blockReason: "PROHIBITED_CONTENT",
      },
      usageMetadata: {
        promptTokenCount: 100,
        totalTokenCount: 100,
      },
    }));
    const retryError = new RetryError({
      message: "Failed after retrying",
      reason: "errorNotRetryable",
      errors: [transientError, contentPolicyError],
    });

    const normalizedError = await withContentPolicyErrorHandling(async () => {
      throw retryError;
    }).catch(error => error);

    expect(normalizedError).toMatchObject({
      publicType: "content_policy_error",
      publicMessage: "The supplied content was blocked by a content policy (reason: PROHIBITED_CONTENT).",
      retryable: false,
      usage: {
        inputTokens: 100,
        outputTokens: 0,
        totalTokens: 100,
        reasoningTokens: 0,
        cachedInputTokens: 0,
      },
    });
  });

  it("normalizes content-filter responses before reading structured output", () => {
    let outputRead = false;
    const response = {
      finishReason: "content-filter",
      rawFinishReason: "PROHIBITED_CONTENT",
      usage: {
        inputTokens: 100,
        outputTokens: 0,
        totalTokens: 100,
        reasoningTokens: 0,
        cachedInputTokens: 20,
      },
      get output(): never {
        outputRead = true;
        throw new Error("structured output getter should not be read");
      },
    };

    const normalizedError = captureThrown(() =>
      getGeneratedOutputWithContentPolicyHandling(response),
    );

    expect(outputRead).toBe(false);
    expect(normalizedError).toMatchObject({
      publicType: "content_policy_error",
      publicMessage: "The supplied content was blocked by a content policy (reason: PROHIBITED_CONTENT).",
      retryable: false,
      usage: response.usage,
    });
  });

  it("preserves content policy metadata across a serialized workflow step boundary", () => {
    const serializedError = {
      __robots_error: true,
      message: "The supplied content was blocked by a content policy (reason: PROHIBITED_CONTENT).",
      publicMessage: "The supplied content was blocked by a content policy (reason: PROHIBITED_CONTENT).",
      publicType: "content_policy_error",
      retryable: false,
    };

    expect(captureThrown(() => wrapError(serializedError, "Failed to analyze video content")))
      .toBe(serializedError);
  });

  it("preserves serialized content policy errors through the retry wrapper", async () => {
    const serializedError = {
      __robots_error: true,
      message: "The supplied content was blocked by a content policy (reason: PROHIBITED_CONTENT).",
      publicMessage: "The supplied content was blocked by a content policy (reason: PROHIBITED_CONTENT).",
      publicType: "content_policy_error",
      retryable: false,
    };

    const errorAfterRetry = await withRetry(async () => {
      throw serializedError;
    }).catch(error => error);

    expect(errorAfterRetry).toBe(serializedError);
    expect(captureThrown(() => wrapError(errorAfterRetry, "Failed to analyze video content")))
      .toBe(serializedError);
  });

  it("preserves unrelated API failures", () => {
    const error = createApiCallError("upstream temporarily unavailable");

    expect(() => rethrowContentPolicyError(error)).toThrow(error);
  });

  it("preserves unrelated object generation failures", () => {
    const error = createNoObjectGeneratedError("error");

    expect(() => rethrowContentPolicyError(error)).toThrow(error);
  });

  it("preserves unrelated retry failures", () => {
    const apiError = createApiCallError("upstream temporarily unavailable");
    const retryError = new RetryError({
      message: "Retries exhausted",
      reason: "maxRetriesExceeded",
      errors: [apiError],
    });

    expect(() => rethrowContentPolicyError(retryError)).toThrow(retryError);
  });
});
