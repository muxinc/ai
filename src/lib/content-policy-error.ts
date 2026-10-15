import { APICallError, NoObjectGeneratedError, RetryError } from "ai";
import { z } from "zod";

import type { TokenUsage } from "../types.ts";

import { MuxAiError } from "./mux-ai-error.ts";
import { withRetry } from "./retry.ts";
import type { RetryOptions } from "./retry.ts";
import { aggregateTokenUsage, getErrorTokenUsage, rethrowWithTokenUsage } from "./token-usage.ts";

const PolicyTokenSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Z0-9_]+$/);

const SafetyRatingSchema = z.object({
  category: PolicyTokenSchema.nullish(),
  blocked: z.boolean().nullish(),
});

const ContentPolicyResponseSchema = z.object({
  promptFeedback: z.object({
    blockReason: PolicyTokenSchema.nullish(),
    safetyRatings: z.array(SafetyRatingSchema).max(32).nullish(),
  }).nullish(),
  candidates: z.array(z.object({
    finishReason: PolicyTokenSchema.nullish(),
    safetyRatings: z.array(SafetyRatingSchema).max(32).nullish(),
  })).max(8).nullish(),
});

const ContentPolicyUsageResponseSchema = z.object({
  usageMetadata: z.object({
    promptTokenCount: z.number().finite().nonnegative().nullish(),
    candidatesTokenCount: z.number().finite().nonnegative().nullish(),
    totalTokenCount: z.number().finite().nonnegative().nullish(),
    cachedContentTokenCount: z.number().finite().nonnegative().nullish(),
    thoughtsTokenCount: z.number().finite().nonnegative().nullish(),
  }).nullish(),
});

// OpenAI structured-output refusals may finish with stop and fail JSON parsing.
// Inspect the provider response shape rather than matching prose/error messages.
const OpenAIRefusalResponseSchema = z.object({
  output: z.array(z.object({
    type: z.string(),
    content: z.array(z.object({ type: z.string() })).max(32).nullish(),
  })).max(8),
});

const OpenAIUsageResponseSchema = z.object({
  usage: z.object({
    input_tokens: z.number().finite().nonnegative(),
    output_tokens: z.number().finite().nonnegative(),
    total_tokens: z.number().finite().nonnegative().optional(),
    input_tokens_details: z.object({
      cached_tokens: z.number().finite().nonnegative().nullish(),
      cache_write_tokens: z.number().finite().nonnegative().nullish(),
    }).nullish(),
    output_tokens_details: z.object({ reasoning_tokens: z.number().finite().nonnegative().nullish() }).nullish(),
  }),
});

const OpenAIPolicyErrorSchema = z.object({
  error: z.object({ code: z.enum(["content_policy_violation", "content_filter"]) }),
});

const CONTENT_POLICY_REASONS = new Set([
  "BLOCKLIST",
  "ESCALATION",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
  "IMAGE_SAFETY",
  "JAILBREAK",
  "MODEL_ARMOR",
  "PROHIBITED_CONTENT",
  "RECITATION",
  "SAFETY",
  "SPII",
]);

export interface ContentPolicyBlock {
  reason: string;
  category?: string;
}

/**
 * Thrown when the model stopped for a reason other than a normal `stop`
 * (e.g. `length` when the output token limit was reached) so the structured
 * output was never parsed. The AI SDK would otherwise surface a metadata-free
 * `NoOutputGeneratedError`. MuxAiError's custom Workflow codec preserves the
 * metadata; detect it with {@link isIncompleteGenerationError}.
 */
export class IncompleteGenerationError extends MuxAiError {
  readonly finishReason: string;
  readonly rawFinishReason?: string;
  readonly usage?: TokenUsage;

  constructor(finishReason: string, rawFinishReason?: string, usage?: TokenUsage) {
    const reason = rawFinishReason ?? finishReason;
    const message = finishReason === "length" ?
      `The model reached its output limit before producing a complete response (finish reason: ${reason}).` :
      `The model stopped before producing a complete response (finish reason: ${reason}).`;
    super(message, {
      type: "processing_error",
      retryable: finishReason !== "length",
    });
    this.finishReason = finishReason;
    this.rawFinishReason = rawFinishReason;
    this.usage = usage;
  }
}

export function isIncompleteGenerationError(error: unknown): error is IncompleteGenerationError {
  return MuxAiError.is(error) && typeof (error as { finishReason?: unknown }).finishReason === "string";
}

interface GeneratedOutput<T> {
  finishReason: string;
  rawFinishReason?: string;
  output: T;
  usage?: unknown;
}

export async function withContentPolicyErrorHandling<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    rethrowContentPolicyError(error);
  }
}

/**
 * Owns provider retries outside the AI SDK so content-policy errors can be
 * normalized to a non-retryable MuxAiError before another request is made.
 * Callers must pass `maxRetries: 0` to the AI SDK operation.
 */
export async function withContentPolicyAwareRetry<T>(
  operation: () => Promise<T>,
  retryOptions?: RetryOptions,
): Promise<T> {
  const retriedUsage: TokenUsage[] = [];
  try {
    const response = await withRetry(
      () => withContentPolicyErrorHandling(operation),
      {
        ...retryOptions,
        onRetry: (error, attempt) => {
          const usage = getErrorTokenUsage(error);
          if (usage) {
            retriedUsage.push(usage);
          }
          retryOptions?.onRetry?.(error, attempt);
        },
      },
    );
    return includeRetriedUsage(response, retriedUsage);
  } catch (error) {
    rethrowWithTokenUsage(error, retriedUsage);
  }
}

/** Preserve the SDK result's getters/prototype and provider-specific usage fields. */
function includeRetriedUsage<T>(response: T, retriedUsage: TokenUsage[]): T {
  if (!retriedUsage.length || typeof response !== "object" || response === null) {
    return response;
  }
  const result = response as T & { usage?: Record<string, unknown>; totalUsage?: Record<string, unknown> };
  const merge = (usage?: Record<string, unknown>) => {
    const combined = aggregateTokenUsage([...retriedUsage, getErrorTokenUsage({ usage }) ?? {}]);
    return {
      ...usage,
      ...combined,
      ...(combined.cachedInputTokens !== undefined || combined.cacheWriteTokens !== undefined ?
          {
            inputTokenDetails: {
              ...(usage?.inputTokenDetails as object | undefined),
              ...(combined.cachedInputTokens !== undefined && { cacheReadTokens: combined.cachedInputTokens }),
              ...(combined.cacheWriteTokens !== undefined && { cacheWriteTokens: combined.cacheWriteTokens }),
            },
          } :
          {}),
      ...(combined.reasoningTokens !== undefined ?
          {
            outputTokenDetails: { ...(usage?.outputTokenDetails as object | undefined), reasoningTokens: combined.reasoningTokens },
          } :
          {}),
    };
  };
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(response);
  descriptors.usage = { value: merge(result.usage), enumerable: true, configurable: true };
  if ("totalUsage" in result) {
    descriptors.totalUsage = { value: merge(result.totalUsage), enumerable: true, configurable: true };
  }
  return Object.create(Object.getPrototypeOf(response), descriptors);
}

export function rethrowContentPolicyError(error: unknown): never {
  const block = extractContentPolicyBlock(error);
  if (!block) {
    throw error;
  }

  throwContentPolicyError(block, getContentPolicyTokenUsage(error));
}

/**
 * Reads structured output only after checking the finish reason. AI SDK
 * intentionally leaves output unresolved for non-`stop` finishes, so
 * accessing `output` first would throw a metadata-free
 * `NoOutputGeneratedError`. Content-policy stops become a
 * `content_policy_error`; every other non-`stop` finish (`length`, `error`,
 * `other`, ...) becomes an {@link IncompleteGenerationError} that keeps the
 * finish reason and token usage.
 */
export function getGeneratedOutputWithContentPolicyHandling<T>(response: GeneratedOutput<T>): T {
  if (response.finishReason === "content-filter") {
    const rawReason = PolicyTokenSchema.safeParse(response.rawFinishReason);
    const reason = rawReason.success && isContentPolicyReason(rawReason.data) ?
      rawReason.data :
      "CONTENT_FILTER";

    throwContentPolicyError({ reason }, getErrorTokenUsage(response));
  }

  if (response.finishReason !== "stop") {
    const rawReason = PolicyTokenSchema.safeParse(response.rawFinishReason);
    throw new IncompleteGenerationError(
      response.finishReason,
      rawReason.success ? rawReason.data : undefined,
      getErrorTokenUsage(response),
    );
  }

  return response.output;
}

function throwContentPolicyError(block: ContentPolicyBlock, usage?: TokenUsage): never {
  const category = block.category ? `; category: ${block.category}` : "";
  const contentPolicyError = new MuxAiError(
    `The supplied content was blocked by a content policy (reason: ${block.reason}${category}).`,
    {
      type: "content_policy_error",
      retryable: false,
    },
  );
  if (usage) {
    (contentPolicyError as MuxAiError & { usage?: TokenUsage }).usage = usage;
  }
  throw contentPolicyError;
}

export function extractContentPolicyBlock(error: unknown): ContentPolicyBlock | undefined {
  if (RetryError.isInstance(error)) {
    return extractContentPolicyBlock(error.lastError);
  }

  if (NoObjectGeneratedError.isInstance(error)) {
    if (error.finishReason === "content-filter")
      return { reason: "CONTENT_FILTER" };
    const body = (error.response as { body?: unknown } | undefined)?.body;
    const refusal = OpenAIRefusalResponseSchema.safeParse(body);
    if (refusal.success && refusal.data.output.some(message => message.type === "message" && message.content?.some(part => part.type === "refusal")))
      return { reason: "REFUSAL" };
  }

  if (!APICallError.isInstance(error) || !error.responseBody) {
    return undefined;
  }

  try {
    const body: unknown = JSON.parse(error.responseBody);
    // Some provider versions reject refusal parts before returning a result,
    // surfacing a 200 APICallError with the original body instead.
    const refusal = OpenAIRefusalResponseSchema.safeParse(body);
    if (refusal.success && refusal.data.output.some(message => message.type === "message" && message.content?.some(part => part.type === "refusal")))
      return { reason: "REFUSAL" };
    if (OpenAIPolicyErrorSchema.safeParse(body).success)
      return { reason: "CONTENT_FILTER" };
    const parsed = ContentPolicyResponseSchema.safeParse(body);
    if (!parsed.success) {
      return undefined;
    }

    const promptReason = parsed.data.promptFeedback?.blockReason;
    if (isContentPolicyReason(promptReason)) {
      return {
        reason: promptReason,
        category: findBlockedCategory(parsed.data.promptFeedback?.safetyRatings),
      };
    }

    for (const candidate of parsed.data.candidates ?? []) {
      if (isContentPolicyReason(candidate.finishReason)) {
        return {
          reason: candidate.finishReason,
          category: findBlockedCategory(candidate.safetyRatings),
        };
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function isContentPolicyReason(reason: string | null | undefined): reason is string {
  return Boolean(reason && CONTENT_POLICY_REASONS.has(reason));
}

function getContentPolicyTokenUsage(error: unknown): TokenUsage | undefined {
  const errorUsage = getErrorTokenUsage(error);
  if (errorUsage) {
    return errorUsage;
  }

  if (RetryError.isInstance(error)) {
    return getContentPolicyTokenUsage(error.lastError);
  }

  if (!APICallError.isInstance(error) || !error.responseBody) {
    return undefined;
  }

  try {
    const body: unknown = JSON.parse(error.responseBody);
    const openai = OpenAIUsageResponseSchema.safeParse(body);
    if (openai.success) {
      const usage = openai.data.usage;
      return {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        totalTokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
        cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? undefined,
        cacheWriteTokens: usage.input_tokens_details?.cache_write_tokens ?? undefined,
        reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? undefined,
      };
    }
    const parsed = ContentPolicyUsageResponseSchema.safeParse(body);
    const usage = parsed.success ? parsed.data.usageMetadata : undefined;
    if (!usage) {
      return undefined;
    }

    // Match @ai-sdk/google's normalization: reasoning tokens are included in
    // output tokens, while cached input tokens are part of prompt tokens.
    const inputTokens = usage.promptTokenCount ?? 0;
    const reasoningTokens = usage.thoughtsTokenCount ?? 0;
    const outputTokens = (usage.candidatesTokenCount ?? 0) + reasoningTokens;

    return {
      inputTokens,
      outputTokens,
      totalTokens: usage.totalTokenCount ?? inputTokens + outputTokens,
      reasoningTokens,
      cachedInputTokens: usage.cachedContentTokenCount ?? 0,
    };
  } catch {
    return undefined;
  }
}

function findBlockedCategory(
  ratings: Array<z.infer<typeof SafetyRatingSchema>> | null | undefined,
): string | undefined {
  return ratings?.find(rating => rating.blocked === true)?.category ?? undefined;
}
