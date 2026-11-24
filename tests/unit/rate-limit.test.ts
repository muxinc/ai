import { RetryableError } from "@workflow/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MUX_AI_ERROR_CODES, MuxAiError } from "../../src/lib/mux-ai-error.ts";
import { muxVideoCallError } from "../../src/lib/mux-video-errors.ts";
import {
  isRateLimitedError,
  MUX_VIDEO_RATE_LIMIT_POLICY,
  rateLimitFacts,
  rateLimitRetryDelayMs,
  rateLimitStepRetry,
  readRateLimit,
} from "../../src/lib/rate-limit.ts";

vi.mock("workflow", () => ({ getStepMetadata: vi.fn() }));
const { getStepMetadata } = await import("workflow");

function muxError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`${status} from Mux`), { status, headers: new Headers(headers) });
}

const RATE_LIMITED = muxError(429, { "retry-after": "2", "x-ratelimit-limit": "20", "x-ratelimit-remaining": "0" });

beforeEach(() => {
  vi.mocked(getStepMetadata).mockReset();
});

describe("readRateLimit", () => {
  it("reads retry-after seconds and the x-ratelimit headers", () => {
    expect(readRateLimit(RATE_LIMITED)).toEqual({ retryAfterMs: 2000, limit: 20, remaining: 0 });
  });

  it("prefers retry-after-ms, and reads a plain header record (as revived across a step boundary)", () => {
    const error = { status: 429, headers: { "retry-after-ms": "1500", "retry-after": "9" } };
    expect(readRateLimit(error)).toEqual({ retryAfterMs: 1500 });
  });

  it("reads retry-after as an HTTP date", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    const error = muxError(429, { "retry-after": "Tue, 24 Nov 2026 12:00:05 GMT" });
    expect(readRateLimit(error, now)).toEqual({ retryAfterMs: 5000 });
  });

  it("ignores missing and malformed headers", () => {
    expect(readRateLimit(muxError(429, { "retry-after": "soon", "x-ratelimit-limit": "-1" }))).toEqual({});
    expect(readRateLimit(new Error("no response"))).toEqual({});
  });
});

describe("rateLimitFacts", () => {
  it("records the headers as facts on a 429 only", () => {
    expect(rateLimitFacts(RATE_LIMITED, 429)).toEqual({ retryAfterMs: 2000, rateLimitLimit: 20, rateLimitRemaining: 0 });
    expect(rateLimitFacts(muxError(503, { "retry-after": "2" }), 503)).toEqual({});
  });

  it("is recorded by the Mux classifier", () => {
    const error = muxVideoCallError("Failed to create the text track on Mux", "create_track", RATE_LIMITED, { assetId: "asset-1" });
    expect(error.code).toBe(MUX_AI_ERROR_CODES.DEPENDENCY_RATE_LIMITED);
    expect(error.transient).toBe(true);
    expect(error.facts).toMatchObject({ assetId: "asset-1", status: 429, retryAfterMs: 2000, rateLimitLimit: 20, rateLimitRemaining: 0 });
  });
});

describe("rateLimitRetryDelayMs", () => {
  const policy = MUX_VIDEO_RATE_LIMIT_POLICY;

  it("never waits less than Retry-After", () => {
    expect(rateLimitRetryDelayMs(2000, 1, policy, () => 0)).toBe(2000);
  });

  it("adds full jitter over a window that doubles per attempt, up to the cap", () => {
    expect(rateLimitRetryDelayMs(2000, 1, policy, () => 1)).toBe(2000 + 4000);
    expect(rateLimitRetryDelayMs(2000, 3, policy, () => 1)).toBe(2000 + 16_000);
    expect(rateLimitRetryDelayMs(2000, 8, policy, () => 1)).toBe(2000 + policy.jitterCapMs);
  });

  it("falls back to the policy's floor without a Retry-After", () => {
    expect(rateLimitRetryDelayMs(undefined, 1, policy, () => 0)).toBe(policy.defaultRetryAfterMs);
  });

  it("keeps the worst case for the Mux policy under ten minutes", () => {
    let total = 0;
    for (let attempt = 1; attempt <= policy.maxRetries; attempt++) {
      total += rateLimitRetryDelayMs(2000, attempt, policy, () => 1);
    }
    expect(total).toBeLessThan(10 * 60_000);
  });
});

describe("rateLimitStepRetry", () => {
  const classified = () => muxVideoCallError("Failed to create the text track on Mux", "create_track", RATE_LIMITED, { assetId: "asset-1" });

  it("marks a rate-limited error for a delayed step retry, keeping its classification", async () => {
    vi.mocked(getStepMetadata).mockReturnValue({ attempt: 1 } as ReturnType<typeof getStepMetadata>);
    const now = Date.parse("2026-11-24T12:00:00Z");

    const retry = await rateLimitStepRetry(classified(), MUX_VIDEO_RATE_LIMIT_POLICY, { now, random: () => 0.5 });

    expect(retry).toBeInstanceOf(MuxAiError);
    expect(RetryableError.is(retry)).toBe(true);
    expect(retry?.retryAfter).toEqual(new Date(now + 2000 + 2000));
    expect(retry).toMatchObject({ code: MUX_AI_ERROR_CODES.DEPENDENCY_RATE_LIMITED, transient: true, facts: { retryAfterMs: 2000 } });
  });

  it("stops asking for retries once the policy's attempts are spent", async () => {
    vi.mocked(getStepMetadata).mockReturnValue({ attempt: MUX_VIDEO_RATE_LIMIT_POLICY.maxRetries + 1 } as ReturnType<typeof getStepMetadata>);
    expect(await rateLimitStepRetry(classified(), MUX_VIDEO_RATE_LIMIT_POLICY)).toBeUndefined();
  });

  it("does nothing outside a Workflow DevKit step", async () => {
    vi.mocked(getStepMetadata).mockImplementation(() => {
      throw new Error("getStepMetadata() can only be called inside a step function");
    });
    const error = classified();
    expect(await rateLimitStepRetry(error, MUX_VIDEO_RATE_LIMIT_POLICY)).toBeUndefined();
    expect(error.name).toBe("Error");
  });

  it("leaves other failures alone", async () => {
    vi.mocked(getStepMetadata).mockReturnValue({ attempt: 1 } as ReturnType<typeof getStepMetadata>);
    const serverError = muxVideoCallError("Failed to fetch the asset from Mux", "get_asset", muxError(503), { assetId: "asset-1" });
    expect(isRateLimitedError(serverError)).toBe(false);
    expect(await rateLimitStepRetry(serverError, MUX_VIDEO_RATE_LIMIT_POLICY)).toBeUndefined();
    expect(await rateLimitStepRetry(RATE_LIMITED, MUX_VIDEO_RATE_LIMIT_POLICY)).toBeUndefined();
  });
});
