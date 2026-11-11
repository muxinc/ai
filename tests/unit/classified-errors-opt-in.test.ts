import { APICallError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getGeneratedOutputWithContentPolicyHandling,
  isIncompleteGenerationError,
  withContentPolicyAwareRetry,
  withContentPolicyErrorHandling,
} from "../../src/lib/content-policy-error.ts";
import { dependencyError } from "../../src/lib/dependency-error.ts";
import { MuxAiError } from "../../src/lib/mux-ai-error.ts";
import { fetchVttFromMux } from "../../src/lib/mux-tracks.ts";
import { storageNotConfiguredError } from "../../src/lib/storage-adapter.ts";

// Shared helpers raise classified errors only when the calling workflow opts in;
// without the opt-in they fail exactly as before, so unmigrated workflows see no change.

function providerError(statusCode: number) {
  return new APICallError({ message: "provider detail", url: "https://example.test/v1", requestBodyValues: {}, statusCode, responseBody: "{}" });
}

const google = { call: "translate_vtt", provider: "google", model: "gemini-test" };
const openai = { call: "translate_vtt", provider: "openai", model: "gpt-test" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("model calls", () => {
  it("keep content-policy blocks legacy without a context, and classify them with one", () => {
    const blocked = { finishReason: "content-filter", rawFinishReason: "SAFETY", output: undefined };

    expect(() => getGeneratedOutputWithContentPolicyHandling(blocked)).toThrow(expect.objectContaining({ publicType: "content_policy_error" }));
    expect(() => getGeneratedOutputWithContentPolicyHandling(blocked, google)).toThrow(expect.objectContaining({
      code: "content_policy_blocked",
      source: "asset",
      facts: expect.objectContaining({ call: "translate_vtt", provider: "google", reason: "SAFETY" }),
    }));
  });

  it("keep incomplete generations legacy without a context, and classify them with one", () => {
    const truncated = { finishReason: "length", rawFinishReason: "MAX_TOKENS", output: undefined };

    let legacy: unknown;
    let classified: unknown;
    try {
      getGeneratedOutputWithContentPolicyHandling(truncated);
    } catch (error) {
      legacy = error;
    }
    try {
      getGeneratedOutputWithContentPolicyHandling(truncated, google);
    } catch (error) {
      classified = error;
    }

    expect(legacy).toMatchObject({ publicType: "processing_error", finishReason: "length" });
    expect(classified).toMatchObject({ code: "model_output_truncated", source: "internal", finishReason: "length", rawFinishReason: "MAX_TOKENS" });
    expect(isIncompleteGenerationError(legacy)).toBe(true);
    expect(isIncompleteGenerationError(classified)).toBe(true);
  });

  it("classify a stop with no output only with a context", () => {
    const empty = { finishReason: "stop", output: undefined };

    expect(getGeneratedOutputWithContentPolicyHandling(empty)).toBeUndefined();
    expect(() => getGeneratedOutputWithContentPolicyHandling(empty, google)).toThrow(expect.objectContaining({ code: "model_output_missing" }));
  });

  it("classify a provider API failure only for a provider with its own classifier", async () => {
    const raw = providerError(503);

    await expect(withContentPolicyErrorHandling(() => Promise.reject(raw))).rejects.toBe(raw);
    await expect(withContentPolicyErrorHandling(() => Promise.reject(raw), openai)).rejects.toBe(raw);
    await expect(withContentPolicyErrorHandling(() => Promise.reject(raw), google)).rejects.toMatchObject({
      source: "upstream",
      dependency: "ai_provider",
      transient: true,
      facts: { call: "translate_vtt", provider: "google", model: "gemini-test", status: 503 },
    });
  });

  it("classify only once the retry loop gives up", async () => {
    const operation = vi.fn(() => Promise.reject(providerError(400)));

    const error = await withContentPolicyAwareRetry(operation, { maxRetries: 2, baseDelay: 0, maxDelay: 0 }, google).catch((caught: unknown) => caught);

    expect(MuxAiError.is(error)).toBe(true);
    expect(error).toMatchObject({ source: "internal", facts: { status: 400 } });
  });
});

describe("fetchVttFromMux", () => {
  it("fails with a plain error without the opt-in", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503, statusText: "Service Unavailable" })));

    const error = await fetchVttFromMux("https://stream.mux.test/t.vtt?token=secret").catch((caught: unknown) => caught);

    expect(MuxAiError.is(error)).toBe(false);
    expect((error as Error).message).toBe("Failed to fetch VTT file: Service Unavailable");
  });

  it("classifies by status with the opt-in, keeping the signed URL out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const outage = await fetchVttFromMux("https://stream.mux.test/t.vtt?token=secret", { classifiedErrors: true }).catch((caught: unknown) => caught);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    const denied = await fetchVttFromMux("https://stream.mux.test/t.vtt?token=secret", { classifiedErrors: true }).catch((caught: unknown) => caught);

    expect(outage).toMatchObject({ source: "upstream", dependency: "mux_video", transient: true, facts: { call: "fetch_vtt", status: 503 } });
    expect(denied).toMatchObject({ source: "account", facts: { call: "fetch_vtt", status: 403, inputs: ["credentials"] } });
    expect(JSON.stringify([outage, denied].map(error => [(error as Error).message, (error as MuxAiError).facts]))).not.toContain("secret");
  });
});

describe("dependency errors", () => {
  it("name the inputs a 401/403 is blamed on, and only then", () => {
    const init = { dependency: "mux_video", call: "get_asset", authSource: "account", authInputs: ["credentials"] } as const;

    expect(dependencyError("denied", { ...init, status: 401 }).facts.inputs).toEqual(["credentials"]);
    expect(dependencyError("down", { ...init, status: 503 }).facts.inputs).toBeUndefined();
  });
});

describe("storageNotConfiguredError", () => {
  it("names the missing settings, never their values", () => {
    expect(storageNotConfiguredError(["s3Bucket"])).toMatchObject({ code: "storage_not_configured", source: "internal", facts: { missing: ["s3Bucket"] } });
  });
});
