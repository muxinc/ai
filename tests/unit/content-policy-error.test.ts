import { APICallError, generateText, NoObjectGeneratedError, Output, RetryError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  classifyModelCallError,
  extractContentPolicyBlock,
  getGeneratedOutputWithContentPolicyHandling,
  IncompleteGenerationError,
  isIncompleteGenerationError,
  modelCallError,
  modelStepError,
  rethrowContentPolicyError,
  withContentPolicyAwareRetry,
  withContentPolicyErrorHandling,
} from "../../src/lib/content-policy-error.ts";
import { legacyWrapError } from "../../src/lib/legacy-mux-ai-error.ts";
import { MuxAiError } from "../../src/lib/mux-ai-error.ts";
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

function createNoObjectGeneratedError(finishReason: "content-filter" | "error" | "stop") {
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

  it("does not retry a content-policy API error marked retryable by the provider", async () => {
    const error = new APICallError({
      message: "Provider rejected the content",
      url: "https://example.com/generate-content",
      requestBodyValues: {},
      statusCode: 500,
      isRetryable: true,
      responseBody: JSON.stringify({
        promptFeedback: {
          blockReason: "PROHIBITED_CONTENT",
        },
      }),
    });
    let attempts = 0;

    await expect(withContentPolicyAwareRetry(async () => {
      attempts++;
      throw error;
    }, {
      maxRetries: 3,
      baseDelay: 0,
      maxDelay: 0,
    })).rejects.toMatchObject({
      publicType: "content_policy_error",
      retryable: false,
    });

    expect(attempts).toBe(1);
  });

  it.each(["structured-output", "provider-api"] as const)("does not retry a refusal with nullable reasoning content (%s)", async (kind) => {
    const body = {
      output: [
        { type: "reasoning", content: null },
        { type: "message", content: [{ type: "refusal", refusal: "Unable to help." }] },
      ],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    };
    const error = kind === "structured-output" ?
        createNoObjectGeneratedError("stop") :
        new APICallError({
          message: "Invalid provider response",
          url: "https://example.com/generate-content",
          requestBodyValues: {},
          statusCode: 200,
          isRetryable: true,
          responseBody: JSON.stringify(body),
        });
    if (NoObjectGeneratedError.isInstance(error))
      Object.assign(error.response!, { body });
    let attempts = 0;

    await expect(withContentPolicyAwareRetry(async () => {
      attempts++;
      throw error;
    }, { maxRetries: 3, baseDelay: 0, maxDelay: 0 })).rejects.toMatchObject({
      publicType: "content_policy_error",
      retryable: false,
      usage: { totalTokens: kind === "structured-output" ? 10 : 12 },
    });
    expect(attempts).toBe(1);
  });

  it("continues retrying transient provider API errors", async () => {
    const error = new APICallError({
      message: "Service unavailable",
      url: "https://example.com/generate-content",
      requestBodyValues: {},
      statusCode: 503,
      isRetryable: true,
    });
    let attempts = 0;

    const result = await withContentPolicyAwareRetry(async () => {
      attempts++;
      if (attempts === 1) {
        throw error;
      }
      return "generated";
    }, {
      maxRetries: 1,
      baseDelay: 0,
      maxDelay: 0,
    });

    expect(result).toBe("generated");
    expect(attempts).toBe(2);
  });

  it("retries invalid structured JSON and returns the recovered output", async () => {
    let attempts = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        attempts++;
        return {
          content: [{
            type: "text",
            text: attempts === 1 ? "{\"result\":" : "{\"result\":\"recovered\"}",
          }],
          finishReason: { unified: "stop", raw: "STOP" },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });

    const response = await withContentPolicyAwareRetry(() => generateText({
      model,
      maxRetries: 0,
      output: Output.object({ schema: z.object({ result: z.string() }) }),
      prompt: "Return structured output",
    }), {
      maxRetries: 1,
      baseDelay: 0,
      maxDelay: 0,
    });

    expect(response.output).toEqual({ result: "recovered" });
    expect(attempts).toBe(2);
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

  it("throws a finish-reason error instead of reading unresolved output", () => {
    let outputRead = false;
    const response = {
      finishReason: "length",
      rawFinishReason: "MAX_TOKENS",
      usage: { inputTokens: 23182, outputTokens: 65521, totalTokens: 88703 },
      get output(): never {
        outputRead = true;
        throw new Error("structured output getter should not be read");
      },
    };

    const error = captureThrown(() => getGeneratedOutputWithContentPolicyHandling(response));

    expect(outputRead).toBe(false);
    expect(error).toBeInstanceOf(IncompleteGenerationError);
    expect(isIncompleteGenerationError(error)).toBe(true);
    expect(error).toMatchObject({
      name: "FatalError",
      publicType: "processing_error",
      publicMessage: "The model reached its output limit before producing a complete response (finish reason: MAX_TOKENS).",
      retryable: false,
      finishReason: "length",
      rawFinishReason: "MAX_TOKENS",
      usage: response.usage,
    });
  });

  it("marks non-length incomplete generations as retryable and ignores unsafe raw reasons", () => {
    const error = captureThrown(() => getGeneratedOutputWithContentPolicyHandling({
      finishReason: "error",
      rawFinishReason: "<script>alert(1)</script>",
      output: undefined,
    }));

    expect(error).toMatchObject({
      publicMessage: "The model stopped before producing a complete response (finish reason: error).",
      retryable: true,
      finishReason: "error",
      rawFinishReason: undefined,
    });
  });

  it("returns structured output for a normal stop", () => {
    const output = getGeneratedOutputWithContentPolicyHandling({
      finishReason: "stop",
      output: { translation: "hola" },
    });

    expect(output).toEqual({ translation: "hola" });
  });

  it("preserves content policy metadata across a serialized workflow step boundary", () => {
    const serializedError = {
      __robots_error: true,
      message: "The supplied content was blocked by a content policy (reason: PROHIBITED_CONTENT).",
      publicMessage: "The supplied content was blocked by a content policy (reason: PROHIBITED_CONTENT).",
      publicType: "content_policy_error",
      retryable: false,
    };

    expect(captureThrown(() => legacyWrapError(serializedError, "Failed to analyze video content")))
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
    expect(captureThrown(() => legacyWrapError(errorAfterRetry, "Failed to analyze video content")))
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

describe("modelStepError", () => {
  function providerError(statusCode: number, url = "https://api.example.test/v1/chat") {
    return new APICallError({ message: `HTTP ${statusCode}`, url, requestBodyValues: {}, statusCode });
  }

  it("classifies a Google failure with the call's facts", () => {
    const error = modelStepError(providerError(429, "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent"), "Detection failed", {
      call: "detect_profanity",
      provider: "google",
      model: "gemini-2.5-flash",
    });

    expect(error).toMatchObject({ dependency: "ai_provider", facts: { call: "detect_profanity", provider: "google", model: "gemini-2.5-flash" } });
  });

  it("keeps a provider without a classifier internal, step-retried only when the AI SDK judges it retryable", () => {
    const facts = { call: "detect_profanity", provider: "anthropic" };

    expect(modelStepError(providerError(503), "Detection failed", facts)).toMatchObject({ message: "Detection failed", source: "internal", transient: true });
    expect(modelStepError(providerError(400), "Detection failed", facts)).toMatchObject({ source: "internal", transient: false });
  });

  it("adds the call's facts to an error that is already classified", () => {
    const classified = new MuxAiError("blocked", { type: "validation_error", source: "request", facts: { reason: "x" } });

    expect(modelStepError(classified, "Detection failed", { call: "detect_profanity", provider: "openai" })).toBe(classified);
    expect(classified.facts).toMatchObject({ reason: "x", call: "detect_profanity", provider: "openai" });
  });
});

describe("openAI's intermittent prompt flag", () => {
  const context = { call: "translate_vtt_chunk", provider: "openai", model: "gpt-test" };
  const flagMessage = "Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt.";

  function openAIError(statusCode: number, message: string) {
    return new APICallError({
      message,
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode,
      responseBody: JSON.stringify({ error: { message, type: "invalid_request_error", code: "invalid_prompt" } }),
    });
  }

  function thrownBy(fn: () => unknown): unknown {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it("is a content-policy block that the step runner retries", () => {
    expect(thrownBy(() => rethrowContentPolicyError(openAIError(400, flagMessage), context))).toMatchObject({
      code: "content_policy_blocked",
      type: "content_policy_error",
      transient: true,
      retryable: true,
      facts: { ...context, reason: "PROMPT_FLAGGED" },
      causes: [{ name: "AI_APICallError", status: 400, message: expect.stringContaining("flagged as potentially violating") }],
    });
  });

  it("is never retried inside the call, so each step attempt sends one request", async () => {
    let calls = 0;
    await expect(withContentPolicyAwareRetry(async () => {
      calls++;
      throw openAIError(400, flagMessage);
    }, { baseDelay: 0 }, context)).rejects.toMatchObject({ code: "content_policy_blocked", transient: true });
    expect(calls).toBe(1);
  });

  it("leaves every other failure as it was", () => {
    // Unclassified callers get the raw error back, as before.
    expect(APICallError.isInstance(thrownBy(() => rethrowContentPolicyError(openAIError(400, flagMessage))))).toBe(true);
    // Another provider, another OpenAI 400 and another status are not the flag.
    expect(APICallError.isInstance(thrownBy(() => rethrowContentPolicyError(openAIError(400, flagMessage), { ...context, provider: "anthropic" })))).toBe(true);
    expect(APICallError.isInstance(thrownBy(() => rethrowContentPolicyError(openAIError(400, "Invalid prompt: too long"), context)))).toBe(true);
    expect(APICallError.isInstance(thrownBy(() => rethrowContentPolicyError(openAIError(500, flagMessage), context)))).toBe(true);
  });
});

describe("classifyModelCallError timeouts", () => {
  it("codes our own abortSignal deadline as the provider timing out, step-retried as before", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");

    expect(classifyModelCallError(timeout, { call: "repair_length", provider: "openai", model: "gpt-test" })).toMatchObject({
      code: "dependency_timeout",
      type: "timeout_error",
      source: "upstream",
      dependency: "ai_provider",
      transient: true,
      retryable: true,
      facts: { call: "repair_length", provider: "openai", model: "gpt-test" },
    });
  });

  it("leaves a caller's own abort unclassified", () => {
    expect(classifyModelCallError(new DOMException("aborted", "AbortError"), { call: "c", provider: "openai" })).toBeUndefined();
  });
});

describe("modelCallError", () => {
  const context = { call: "analyze_structure", provider: "google", model: "gemini-test" };

  it("codes a content-policy block, with the call's facts", () => {
    const error = modelCallError(createApiCallError(JSON.stringify({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } })), context);

    expect(error).toMatchObject({ code: "content_policy_blocked", source: "asset", dependency: "ai_provider", transient: false, facts: { ...context, reason: "PROHIBITED_CONTENT" } });
  });

  it("codes output that doesn't match its schema, keeping its usage", () => {
    const error = modelCallError(createNoObjectGeneratedError("stop"), context);

    expect(error).toMatchObject({ code: "model_output_invalid", dependency: "ai_provider", facts: context, usage: { inputTokens: 10, totalTokens: 10 } });
  });

  it("codes a provider failure by that provider's rules", () => {
    const quota = new APICallError({
      message: "quota",
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }] }] } }),
    });

    expect(modelCallError(quota, context)).toMatchObject({ code: "provider_quota_exhausted", transient: false, retryable: false, facts: { ...context, status: 429 } });
  });

  it("codes OpenAI's spent quota by its rules, not as a rate limit", () => {
    const spent = new APICallError({
      message: "You exceeded your current quota",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: JSON.stringify({ error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } }),
      isRetryable: true,
    });

    expect(modelCallError(spent, { call: "synthesis", provider: "openai", model: "gpt-test" })).toMatchObject({ code: "provider_quota_exhausted", transient: false, retryable: false });
  });

  it("accepts the AI SDK model's own provider id", () => {
    const quota = new APICallError({
      message: "quota",
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }] }] } }),
    });
    const spent = new APICallError({
      message: "quota",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: JSON.stringify({ error: { message: "quota", type: "insufficient_quota", code: "insufficient_quota" } }),
    });

    expect(modelCallError(quota, { call: "x", provider: "google.generative-ai", model: "gemini-test" })).toMatchObject({ code: "provider_quota_exhausted", facts: { provider: "google" } });
    expect(modelCallError(spent, { call: "x", provider: "openai.chat", model: "gpt-test" })).toMatchObject({ code: "provider_quota_exhausted", facts: { provider: "openai" } });
  });

  it("codes a provider without rules of its own by status, not uncoded", () => {
    const outage = new APICallError({
      message: "overloaded",
      url: "https://api.anthropic.com/v1/messages",
      requestBodyValues: {},
      statusCode: 529,
      responseHeaders: { "request-id": "req_a" },
      isRetryable: true,
    });
    const rejected = new APICallError({ message: "bad", url: "https://api.anthropic.com/v1/messages", requestBodyValues: {}, statusCode: 400, isRetryable: false });
    const anthropic = { call: "synthesis", provider: "anthropic", model: "claude-test" };

    expect(modelCallError(outage, anthropic)).toMatchObject({ code: "dependency_server_error", source: "upstream", dependency: "ai_provider", transient: true, facts: { ...anthropic, status: 529 } });
    expect(modelCallError(rejected, anthropic)).toMatchObject({ code: "dependency_request_rejected", source: "internal", transient: false });
  });

  it("codes anything else as internal, with a default message", () => {
    const error = modelCallError(new Error("socket hang up"), context);

    expect(error).toMatchObject({ type: "server_error", source: "internal", facts: context, message: expect.stringContaining("analyze_structure failed") });
  });

  it("keeps an error that's already classified", () => {
    const classified = new MuxAiError("already", { code: "model_output_missing", type: "processing_error", source: "upstream", dependency: "ai_provider", facts: { call: "x" } });

    expect(modelCallError(classified, context)).toBe(classified);
  });
});
