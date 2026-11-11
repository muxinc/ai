import { APIError } from "@mux/ts";
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
import { getPlaybackIdForAsset } from "../../src/lib/mux-assets.ts";
import { fetchVttFromMux, validateTrackPassthrough } from "../../src/lib/mux-tracks.ts";
import { muxAssetFetchError, muxVideoErrorFacts } from "../../src/lib/mux-video-errors.ts";
import { toPublicError } from "../../src/lib/public-error.ts";
import { storageNotConfiguredError } from "../../src/lib/storage-adapter.ts";
import type { MuxAsset } from "../../src/types.ts";

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

describe("muxVideoErrorFacts", () => {
  it("keeps Mux's error type as a token, and nothing from a body it can't read", () => {
    expect(muxVideoErrorFacts({ error: { error: { type: "invalid_parameters", messages: ["url is invalid"] } } })).toEqual({ muxErrorType: "invalid_parameters" });
    expect(muxVideoErrorFacts({ error: { error: { type: "not a token!" } } })).toEqual({});
    expect(muxVideoErrorFacts(new Error("connection reset"))).toEqual({});
  });
});

describe("getPlaybackIdForAsset", () => {
  const asset = { id: "asset-1", playback_ids: [] } as unknown as MuxAsset;

  it("keeps legacy errors without the opt-in", async () => {
    await expect(getPlaybackIdForAsset("asset-2", undefined, asset)).rejects.toMatchObject({ publicType: "validation_error" });
    await expect(getPlaybackIdForAsset("asset-1", undefined, asset)).rejects.toMatchObject({ publicType: "validation_error" });
  });

  it("classifies a snapshot mismatch and a missing playback ID with the opt-in", async () => {
    await expect(getPlaybackIdForAsset("asset-2", undefined, asset, { classifiedErrors: true })).rejects.toMatchObject({
      source: "request",
      facts: { assetId: "asset-2", snapshotAssetId: "asset-1", inputs: ["assetId", "assetSnapshot"] },
    });
    await expect(getPlaybackIdForAsset("asset-1", undefined, asset, { classifiedErrors: true })).rejects.toMatchObject({ code: "playback_id_not_found", source: "asset" });
  });
});

describe("muxAssetFetchError", () => {
  it("makes a 404 asset_not_found, blamed on the caller's assetId, with public wording naming the asset", () => {
    const error = muxAssetFetchError("asset-9", APIError.generate(404, { error: { type: "not_found", messages: ["Asset not found"] } }, undefined, new Headers()));

    expect(error).toMatchObject({ code: "asset_not_found", source: "request", facts: { assetId: "asset-9", inputs: ["assetId"], muxErrorType: "not_found" } });
    expect(toPublicError(error)).toMatchObject({ code: "asset_not_found", message: "Asset asset-9 could not be found." });
  });

  it("reads Mux's error type off a real Mux SDK error", () => {
    const error = muxAssetFetchError("asset-9", APIError.generate(400, { error: { type: "invalid_parameters", messages: ["bad"] } }, undefined, new Headers({ "x-request-id": "req-9" })));

    expect(error).toMatchObject({ source: "internal", facts: { call: "get_asset", status: 400, requestId: "req-9", muxErrorType: "invalid_parameters" } });
  });
});

describe("validateTrackPassthrough", () => {
  const long = "x".repeat(256);

  it("keeps the legacy error without the opt-in, and raises invalid_parameter with it", () => {
    expect(() => validateTrackPassthrough(long)).toThrow(expect.objectContaining({ publicType: "validation_error" }));

    let error: unknown;
    try {
      validateTrackPassthrough(long, { classifiedErrors: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "invalid_parameter", message: "Track passthrough must be at most 255 characters (received 256).", facts: { parameter: "trackPassthrough", reason: "too_long" } });
    expect(toPublicError(error as MuxAiError).message).toBe("trackPassthrough must be at most 255 characters (received 256).");
  });
});
