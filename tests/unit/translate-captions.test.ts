import { describe, expect, it } from "vitest";

import type { TokenUsage } from "../../src/types";
import { aggregateTokenUsage } from "../../src/workflows/translate-captions";

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
