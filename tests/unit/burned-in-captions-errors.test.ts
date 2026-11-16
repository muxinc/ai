import { APICallError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
    Output: {
      object: vi.fn(() => ({})),
    },
  };
});

vi.mock("../../src/lib/mux-assets", () => ({
  getAssetDurationSecondsFromAsset: vi.fn(),
  getPlaybackIdForAsset: vi.fn(),
  getVideoTrackDurationSecondsFromAsset: vi.fn(),
}));

vi.mock("../../src/lib/providers", () => ({
  createLanguageModelFromConfig: vi.fn(),
  resolveLanguageModelConfig: vi.fn(),
}));

vi.mock("../../src/lib/image-download", () => ({
  downloadImageAsBase64: vi.fn(),
}));

vi.mock("../../src/primitives/storyboards", () => ({
  getStoryboardUrl: vi.fn(),
}));

const { generateText } = await import("ai");
const { downloadImageAsBase64 } = await import("../../src/lib/image-download");
const { MuxAiError } = await import("../../src/lib/mux-ai-error");
const {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  getVideoTrackDurationSecondsFromAsset,
} = await import("../../src/lib/mux-assets");
const { createLanguageModelFromConfig, resolveLanguageModelConfig } = await import("../../src/lib/providers");
const { getStoryboardUrl } = await import("../../src/primitives/storyboards");
const { hasBurnedInCaptions } = await import("../../src/workflows/burned-in-captions");

const ANALYSIS = { hasBurnedInCaptions: true, confidence: 0.9, detectedLanguage: "English" };

function mockModelAnalysis(output: unknown, finishReason = "stop") {
  vi.mocked(generateText).mockResolvedValue({
    finishReason,
    output,
    text: JSON.stringify(output),
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  } as any);
}

function openAIError(statusCode: number, code: string) {
  return new APICallError({
    message: "OpenAI error",
    url: "https://api.openai.com/v1/responses",
    requestBodyValues: {},
    statusCode,
    responseHeaders: { "x-request-id": "req_1" },
    responseBody: JSON.stringify({ error: { message: "free text", type: code, param: null, code } }),
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

beforeEach(() => {
  vi.resetAllMocks();

  vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
    asset: { id: "asset-123", duration: 120, tracks: [{ type: "video", duration: 120 }] },
    playbackId: "playback-123",
    policy: "public",
  } as any);
  vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(120);
  vi.mocked(getVideoTrackDurationSecondsFromAsset).mockReturnValue(120);
  vi.mocked(resolveLanguageModelConfig).mockReturnValue({ provider: "openai", modelId: "test-model" } as any);
  vi.mocked(createLanguageModelFromConfig).mockResolvedValue({} as any);
  vi.mocked(getStoryboardUrl).mockResolvedValue("https://image.example/storyboard.jpg");
  mockModelAnalysis(ANALYSIS);
});

describe("hasBurnedInCaptions classified errors", () => {
  const modelFacts = { call: "detect_burned_in_captions", provider: "openai", model: "test-model", assetId: "asset-123" };

  it("opts in to classified errors from the asset helper", async () => {
    await expect(hasBurnedInCaptions("asset-123")).resolves.toMatchObject({ hasBurnedInCaptions: true });

    expect(vi.mocked(getPlaybackIdForAsset).mock.calls[0][3]).toEqual({ classifiedErrors: true });
  });

  it("codes a scope that starts after the video ends as invalid_scope (no_video)", async () => {
    vi.mocked(getVideoTrackDurationSecondsFromAsset).mockReturnValue(60);

    await expect(hasBurnedInCaptions("asset-123", { scope: { startTime: 90 } })).rejects.toMatchObject({
      code: "invalid_scope",
      source: "request",
      facts: { reason: "no_video", startTime: 90, videoEndTime: 60 },
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("downloads the storyboard with classified errors in base64 mode", async () => {
    vi.mocked(downloadImageAsBase64).mockResolvedValue({ base64Data: "data:image/jpeg;base64,AAAA" } as any);

    await hasBurnedInCaptions("asset-123", { imageSubmissionMode: "base64" });

    expect(downloadImageAsBase64).toHaveBeenCalledWith("https://image.example/storyboard.jpg", undefined, { classifiedErrors: true, call: "fetch_storyboard" });
    expect(vi.mocked(generateText).mock.calls[0][0].messages![0].content[1]).toEqual({ type: "image", image: "data:image/jpeg;base64,AAAA" });
  });

  it("passes a classified storyboard download failure through without model facts", async () => {
    const failure = new MuxAiError("Failed to download image from Mux (HTTP 404)", {
      code: "asset_resource_not_found",
      type: "validation_error",
      source: "asset",
      dependency: "mux_video",
      facts: { call: "fetch_storyboard", status: 404 },
    });
    vi.mocked(downloadImageAsBase64).mockRejectedValue(failure);

    const error = await hasBurnedInCaptions("asset-123", { imageSubmissionMode: "base64" }).catch(e => e);

    expect(error).toBe(failure);
    expect(error.facts).toEqual({ call: "fetch_storyboard", status: 404 });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("codes OpenAI's spent quota without step-retrying it, naming the call", async () => {
    vi.mocked(generateText).mockRejectedValue(openAIError(429, "insufficient_quota"));

    await expect(hasBurnedInCaptions("asset-123")).rejects.toMatchObject({
      code: "provider_quota_exhausted",
      source: "internal",
      dependency: "ai_provider",
      transient: false,
      retryable: false,
      facts: { ...modelFacts, status: 429, providerCode: "insufficient_quota" },
    });
  });

  it("keeps step-retrying OpenAI's rate limit", async () => {
    vi.mocked(generateText).mockRejectedValue(openAIError(429, "rate_limit_exceeded"));

    await expect(hasBurnedInCaptions("asset-123")).rejects.toMatchObject({ code: "provider_rate_limited", transient: true, facts: modelFacts });
  });

  it("classifies a failed model call that isn't a provider error, naming the call", async () => {
    vi.mocked(generateText).mockRejectedValue(new Error("socket hang up"));

    const error = await hasBurnedInCaptions("asset-123").catch(e => e);

    expect(MuxAiError.is(error)).toBe(true);
    expect(error).toMatchObject({ source: "internal", facts: modelFacts });
  });

  it("codes a response without output as model_output_missing", async () => {
    mockModelAnalysis(undefined);

    await expect(hasBurnedInCaptions("asset-123")).rejects.toMatchObject({ code: "model_output_missing", dependency: "ai_provider", facts: modelFacts });
  });

  it("codes a model that hit its length limit as model_output_truncated", async () => {
    mockModelAnalysis(undefined, "length");

    await expect(hasBurnedInCaptions("asset-123")).rejects.toMatchObject({ code: "model_output_truncated", facts: modelFacts });
  });
});
