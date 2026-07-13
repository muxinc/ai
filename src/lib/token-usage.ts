import type { TokenUsage } from "../types.ts";

const TOKEN_USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cachedInputTokens",
] as const;

type AggregatedTokenUsageField = (typeof TOKEN_USAGE_FIELDS)[number];

function isDefinedTokenUsageValue(value: number | undefined): value is number {
  return typeof value === "number";
}

export function aggregateTokenUsage(usages: TokenUsage[]): TokenUsage {
  return TOKEN_USAGE_FIELDS.reduce<TokenUsage>((aggregate, field) => {
    // Only aggregate values that were explicitly reported by the provider so
    // omitted fields stay undefined instead of being coerced to 0.
    const values = usages
      .map(usage => usage[field as AggregatedTokenUsageField])
      .filter(isDefinedTokenUsageValue);

    if (values.length > 0) {
      // Sum this field independently and write it back only when at least one
      // chunk included real data for it.
      aggregate[field] = values.reduce((total, value) => total + value, 0);
    }

    return aggregate;
  }, {});
}

/**
 * Reads token usage carried on a thrown error's plain `usage` property.
 *
 * Covers both AI SDK errors that report usage for the failed call (e.g.
 * `NoObjectGeneratedError`) and errors this package has already annotated
 * via {@link rethrowWithTokenUsage}. Only the known numeric fields are
 * extracted; AI SDK v6 nests reasoning/cache counts under
 * `outputTokenDetails`/`inputTokenDetails` when the deprecated flat fields
 * are absent, so those are used as fallbacks.
 */
export function getErrorTokenUsage(error: unknown): TokenUsage | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const usage = (error as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) {
    return undefined;
  }

  const source = usage as Record<string, unknown>;
  const extracted: TokenUsage = {};
  for (const field of TOKEN_USAGE_FIELDS) {
    const value = source[field];
    if (typeof value === "number") {
      extracted[field] = value;
    }
  }

  if (extracted.reasoningTokens === undefined) {
    const reasoningTokens = (source.outputTokenDetails as { reasoningTokens?: unknown } | undefined)?.reasoningTokens;
    if (typeof reasoningTokens === "number") {
      extracted.reasoningTokens = reasoningTokens;
    }
  }
  if (extracted.cachedInputTokens === undefined) {
    const cacheReadTokens = (source.inputTokenDetails as { cacheReadTokens?: unknown } | undefined)?.cacheReadTokens;
    if (typeof cacheReadTokens === "number") {
      extracted.cachedInputTokens = cacheReadTokens;
    }
  }

  return Object.keys(extracted).length > 0 ? extracted : undefined;
}

/**
 * Rethrows `error` with the aggregate token usage of all provider calls made
 * so far attached as a plain enumerable `usage` property, so consumers can
 * report tokens burned by failed workflows (mirrors the AI SDK's
 * `NoObjectGeneratedError.usage` convention).
 *
 * The error's own `usage` (from the failing call) is folded into the
 * aggregate. When no usage was collected and the error carries none, the
 * error is rethrown untouched — callers treat a missing `usage` as "no
 * tokens spent".
 */
export function rethrowWithTokenUsage(error: unknown, collectedUsage: TokenUsage[]): never {
  const usages = [...collectedUsage];
  const errorUsage = getErrorTokenUsage(error);
  if (errorUsage) {
    usages.push(errorUsage);
  }
  if (usages.length > 0 && typeof error === "object" && error !== null) {
    (error as { usage?: TokenUsage }).usage = aggregateTokenUsage(usages);
  }
  throw error;
}
