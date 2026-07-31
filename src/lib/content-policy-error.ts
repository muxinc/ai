import { APICallError, NoObjectGeneratedError } from "ai";
import { z } from "zod";

import type { TokenUsage } from "../types.ts";

import { MuxAiError } from "./mux-ai-error.ts";
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

export async function withContentPolicyErrorHandling<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    rethrowContentPolicyError(error);
  }
}

export function rethrowContentPolicyError(error: unknown): never {
  const block = extractContentPolicyBlock(error);
  if (!block) {
    throw error;
  }

  const category = block.category ? `; category: ${block.category}` : "";
  const contentPolicyError = new MuxAiError(
    `The supplied content was blocked by a content policy (reason: ${block.reason}${category}).`,
    {
      type: "content_policy_error",
      retryable: false,
    },
  );
  const usage = getErrorTokenUsage(error);
  if (usage) {
    (contentPolicyError as MuxAiError & { usage?: TokenUsage }).usage = usage;
  }
  throw contentPolicyError;
}

export function extractContentPolicyBlock(error: unknown): ContentPolicyBlock | undefined {
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

function findBlockedCategory(
  ratings: Array<z.infer<typeof SafetyRatingSchema>> | null | undefined,
): string | undefined {
  return ratings?.find(rating => rating.blocked === true)?.category ?? undefined;
}
