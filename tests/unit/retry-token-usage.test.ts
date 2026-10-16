import { afterEach, describe, expect, it, vi } from "vitest";

import { withContentPolicyAwareRetry } from "../../src/lib/content-policy-error.ts";

const retries = { maxRetries: 2, baseDelay: 0, maxDelay: 0 };
function failure(totalTokens: number) {
  return Object.assign(new Error("No object generated"), { name: "AI_NoObjectGeneratedError", usage: { totalTokens } });
}

describe("model retry usage accounting", () => {
  afterEach(() => vi.restoreAllMocks());

  it("includes failed attempts in successful results without mutating SDK getters", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    class Result {
      get usage() {
        return { inputTokens: 10, outputTokens: 5, totalTokens: 15, inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 2 }, outputTokenDetails: { reasoningTokens: 1, textTokens: 4 } };
      }

      get totalUsage() {
        return this.usage;
      }

      get output() {
        return { content: "Finished" };
      }
    }
    const original = Object.freeze(new Result());
    const operation = vi.fn()
      .mockRejectedValueOnce(Object.assign(failure(7), { usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7, inputTokenDetails: { cacheReadTokens: 1 }, outputTokenDetails: { reasoningTokens: 2 } } }))
      .mockRejectedValueOnce(failure(9))
      .mockResolvedValueOnce(original);
    const result = await withContentPolicyAwareRetry(operation, retries);
    expect(result).toBeInstanceOf(Result);
    expect(result.output).toEqual({ content: "Finished" });
    expect(result.usage).toMatchObject({ inputTokens: 14, outputTokens: 8, totalTokens: 31, reasoningTokens: 3, cachedInputTokens: 4, cacheWriteTokens: 2, inputTokenDetails: { cacheReadTokens: 4, cacheWriteTokens: 2 }, outputTokenDetails: { reasoningTokens: 3, textTokens: 4 } });
    expect(result.totalUsage).toEqual(result.usage);
    expect(original.usage.totalTokens).toBe(15);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("includes every attempt exactly once when retries are exhausted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const last = failure(11);
    const operation = vi.fn().mockRejectedValueOnce(failure(7)).mockRejectedValueOnce(failure(9)).mockRejectedValueOnce(last);
    await expect(withContentPolicyAwareRetry(operation, retries)).rejects.toBe(last);
    expect(last.usage).toEqual({ totalTokens: 27 });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("keeps prior usage when the terminal error reports none", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const last = new Error("terminal failure");
    const operation = vi.fn().mockRejectedValueOnce(failure(7)).mockRejectedValueOnce(last);
    await expect(withContentPolicyAwareRetry(operation, retries)).rejects.toMatchObject({ usage: { totalTokens: 7 } });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("leaves successful results alone when no retry usage was reported", async () => {
    const response = { usage: { totalTokens: 15 } };
    expect(await withContentPolicyAwareRetry(async () => response, retries)).toBe(response);
  });
});
