import type { TokenUsage } from "../types.ts";

const TOKEN_USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
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
 * Reads token usage from a thrown error's plain `usage` property (AI SDK
 * errors like `NoObjectGeneratedError`, or errors annotated by
 * {@link rethrowWithTokenUsage}). Falls back to AI SDK v6's nested
 * `inputTokenDetails`/`outputTokenDetails` for cache/reasoning counts.
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
  if (extracted.cacheWriteTokens === undefined) {
    const cacheWriteTokens = (source.inputTokenDetails as { cacheWriteTokens?: unknown } | undefined)?.cacheWriteTokens;
    if (typeof cacheWriteTokens === "number") {
      extracted.cacheWriteTokens = cacheWriteTokens;
    }
  }

  return Object.keys(extracted).length > 0 ? extracted : undefined;
}

/**
 * Rethrows `error` with the aggregate of `collectedUsage` plus the error's
 * own usage attached as a plain enumerable `usage` property (mirrors the AI
 * SDK's `NoObjectGeneratedError.usage` convention). Rethrows untouched when
 * there is no usage to attach.
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
