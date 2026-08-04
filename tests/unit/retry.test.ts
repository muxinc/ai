import { DownloadError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withRetry } from "../../src/lib/retry";

describe("withRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries a network-level AI SDK download failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempts = 0;

    const result = await withRetry(async () => {
      attempts++;
      if (attempts === 1) {
        throw new DownloadError({
          url: "https://image.example.com/storyboard.png",
          cause: new TypeError("fetch failed"),
        });
      }
      return "downloaded";
    }, {
      maxRetries: 1,
      baseDelay: 0,
      maxDelay: 0,
    });

    expect(result).toBe("downloaded");
    expect(attempts).toBe(2);
  });

  it.each([408, 425, 429, 500, 503])("retries a transient HTTP %i download failure", async (statusCode) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempts = 0;

    await withRetry(async () => {
      attempts++;
      if (attempts === 1) {
        throw new DownloadError({
          url: "https://image.example.com/storyboard.png",
          statusCode,
          statusText: "Transient failure",
        });
      }
    }, {
      maxRetries: 1,
      baseDelay: 0,
      maxDelay: 0,
    });

    expect(attempts).toBe(2);
  });

  it("does not retry a non-retryable HTTP download failure", async () => {
    const error = new DownloadError({
      url: "https://image.example.com/missing.png",
      statusCode: 404,
      statusText: "Not Found",
    });
    let attempts = 0;

    await expect(withRetry(async () => {
      attempts++;
      throw error;
    }, {
      maxRetries: 3,
      baseDelay: 0,
      maxDelay: 0,
    })).rejects.toBe(error);

    expect(attempts).toBe(1);
  });
});
