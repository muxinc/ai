import { APICallError, NoObjectGeneratedError, RetryError } from "ai";
import { z } from "zod";

import type { TokenUsage } from "../types.ts";

import { MuxAiError } from "./mux-ai-error.ts";
import { withRetry } from "./retry.ts";
import type { RetryOptions } from "./retry.ts";
import { getErrorTokenUsage } from "./token-usage.ts";

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
  return withRetry(
    () => withContentPolicyErrorHandling(operation),
    retryOptions,
  );
}

export function rethrowContentPolicyError(error: unknown): never {
  const block = extractContentPolicyBlock(error);
  if (!block) {
    throw error;
  }

  throwContentPolicyError(block, getContentPolicyTokenUsage(error));
}

/**
 * Reads structured output only after checking for a successful provider
 * response that stopped because of a content policy. AI SDK intentionally
 * leaves output unresolved for non-`stop` finishes, so accessing `output`
 * first would throw a metadata-free `NoOutputGeneratedError`.
 */
export function getGeneratedOutputWithContentPolicyHandling<T>(response: GeneratedOutput<T>): T {
  if (response.finishReason === "content-filter") {
    const rawReason = PolicyTokenSchema.safeParse(response.rawFinishReason);
    const reason = rawReason.success && isContentPolicyReason(rawReason.data) ?
      rawReason.data :
      "CONTENT_FILTER";

    throwContentPolicyError({ reason }, getErrorTokenUsage(response));
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

  if (NoObjectGeneratedError.isInstance(error) && error.finishReason === "content-filter") {
    return { reason: "CONTENT_FILTER" };
  }

  if (!APICallError.isInstance(error) || !error.responseBody) {
    return undefined;
  }

  try {
    const parsed = ContentPolicyResponseSchema.safeParse(JSON.parse(error.responseBody));
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
    const parsed = ContentPolicyUsageResponseSchema.safeParse(JSON.parse(error.responseBody));
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
