import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  Output: {
    object: vi.fn(() => ({})),
  },
}));

vi.mock("../../src/lib/mux-assets", () => ({
  getAssetDurationSecondsFromAsset: vi.fn(),
  getPlaybackIdForAsset: vi.fn(),
  getVideoTrackDurationSecondsFromAsset: vi.fn(),
  isAudioOnlyAsset: vi.fn(),
}));

vi.mock("../../src/lib/providers", () => ({
  createLanguageModelFromConfig: vi.fn(),
  resolveLanguageModelConfig: vi.fn(),
}));

vi.mock("../../src/lib/workflow-credentials", () => ({
  resolveMuxSigningContext: vi.fn(),
}));

vi.mock("../../src/lib/image-download", () => ({
  downloadImageAsBase64: vi.fn(),
}));

vi.mock("../../src/primitives/storyboards", () => ({
  getStoryboardUrl: vi.fn(),
}));

vi.mock("../../src/primitives/transcripts", () => ({
  fetchTranscriptForAsset: vi.fn(),
  getReadyTextTracks: vi.fn(() => []),
  getReliableLanguageCode: vi.fn(),
}));

const { generateText } = await import("ai");
const { downloadImageAsBase64 } = await import("../../src/lib/image-download");
const { MuxAiError } = await import("../../src/lib/mux-ai-error");
const {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  getVideoTrackDurationSecondsFromAsset,
  isAudioOnlyAsset,
} = await import("../../src/lib/mux-assets");
const { createLanguageModelFromConfig, resolveLanguageModelConfig } = await import("../../src/lib/providers");
const { resolveMuxSigningContext } = await import("../../src/lib/workflow-credentials");
const { getStoryboardUrl } = await import("../../src/primitives/storyboards");
const { fetchTranscriptForAsset } = await import("../../src/primitives/transcripts");
const { getSummaryAndTags } = await import("../../src/workflows/summarization");

beforeEach(() => {
  vi.resetAllMocks();

  vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
    asset: {
      id: "asset-123",
      duration: 120,
      tracks: [{ type: "video", duration: 120 }],
    },
    playbackId: "playback-123",
    policy: "public",
  } as any);
  vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(120);
  vi.mocked(getVideoTrackDurationSecondsFromAsset).mockReturnValue(120);
  vi.mocked(isAudioOnlyAsset).mockReturnValue(false);
  vi.mocked(resolveMuxSigningContext).mockResolvedValue(undefined);
  vi.mocked(resolveLanguageModelConfig).mockReturnValue({
    provider: "openai",
    modelId: "test-model",
  } as any);
  vi.mocked(createLanguageModelFromConfig).mockResolvedValue({} as any);
  vi.mocked(fetchTranscriptForAsset).mockResolvedValue({
    track: { id: "text-track", language_code: "en", status: "ready", type: "text" },
    transcriptText: "The important part is that every output starts from the same evidence.",
  } as any);
  vi.mocked(getStoryboardUrl).mockResolvedValue("https://image.example/storyboard.jpg");
  vi.mocked(generateText).mockResolvedValue({
    finishReason: "stop",
    output: {
      title: "Building Reliable Video Workflows",
      description: "A presenter connects separate analysis stages into one shared workflow.",
      keywords: ["video workflows", "shared evidence"],
    },
    text: JSON.stringify({
      title: "Building Reliable Video Workflows",
      description: "A presenter connects separate analysis stages into one shared workflow.",
      keywords: ["video workflows", "shared evidence"],
    }),
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    },
  } as any);
});

describe("getSummaryAndTags classified errors", () => {
  const modelFacts = { call: "generate_summary", provider: "openai", model: "test-model", assetId: "asset-123" };

  it("opts in to classified errors from the asset and transcript helpers", async () => {
    await getSummaryAndTags("asset-123");

    expect(vi.mocked(getPlaybackIdForAsset).mock.calls[0][3]).toEqual({ classifiedErrors: true });
    expect(vi.mocked(fetchTranscriptForAsset).mock.calls[0][2]).toMatchObject({ required: false, classifiedErrors: true });
  });

  it("codes an unknown tone as invalid_parameter", async () => {
    await expect(getSummaryAndTags("asset-123", { tone: "sarcastic" as any })).rejects.toMatchObject({
      code: "invalid_parameter",
      source: "request",
      facts: { parameter: "tone", reason: "not_allowed", value: "sarcastic", inputs: ["tone"] },
    });
    expect(getPlaybackIdForAsset).not.toHaveBeenCalled();
  });

  it("codes an audio-only asset without a transcript as invalid_parameter", async () => {
    vi.mocked(isAudioOnlyAsset).mockReturnValue(true);

    await expect(getSummaryAndTags("asset-123", { includeTranscript: false })).rejects.toMatchObject({
      code: "invalid_parameter",
      source: "request",
      facts: { parameter: "includeTranscript", reason: "not_allowed", allowed: [true], value: false, inputs: ["includeTranscript"] },
    });
  });

  it("codes a signed asset without signing keys as signing_credentials_missing", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
      asset: { id: "asset-123", duration: 120, tracks: [] },
      playbackId: "playback-123",
      policy: "signed",
    } as any);

    await expect(getSummaryAndTags("asset-123")).rejects.toMatchObject({ code: "signing_credentials_missing", source: "internal" });
  });

  it("codes a scope that starts after the video ends as invalid_scope (no_video)", async () => {
    vi.mocked(getVideoTrackDurationSecondsFromAsset).mockReturnValue(60);

    await expect(getSummaryAndTags("asset-123", { scope: { startTime: 90 } })).rejects.toMatchObject({
      code: "invalid_scope",
      source: "request",
      facts: { reason: "no_video", startTime: 90, endTime: 120, videoEndTime: 60, inputs: ["scope"] },
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("downloads the storyboard with classified errors in base64 mode", async () => {
    vi.mocked(downloadImageAsBase64).mockResolvedValue({ base64Data: "data:image/jpeg;base64,AAAA" } as any);

    await getSummaryAndTags("asset-123", { imageSubmissionMode: "base64" });

    expect(downloadImageAsBase64).toHaveBeenCalledWith("https://image.example/storyboard.jpg", undefined, { classifiedErrors: true, call: "fetch_storyboard" });
    const request = vi.mocked(generateText).mock.calls[0][0];
    expect(request.messages[0].content[1]).toEqual({ type: "image", image: "data:image/jpeg;base64,AAAA" });
  });

  it("passes a classified storyboard download failure through without model facts", async () => {
    const failure = new MuxAiError("Failed to download image from Mux (HTTP 404)", {
      type: "validation_error",
      source: "asset",
      dependency: "mux_video",
      facts: { call: "fetch_storyboard", status: 404 },
    });
    vi.mocked(downloadImageAsBase64).mockRejectedValue(failure);

    const error = await getSummaryAndTags("asset-123", { imageSubmissionMode: "base64" }).catch(e => e);

    expect(error).toBe(failure);
    expect(error.facts).toEqual({ call: "fetch_storyboard", status: 404 });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("classifies a failed model call, naming the call", async () => {
    vi.mocked(generateText).mockRejectedValue(new Error("socket hang up"));

    const error = await getSummaryAndTags("asset-123").catch(e => e);

    expect(MuxAiError.is(error)).toBe(true);
    expect(error.facts).toMatchObject(modelFacts);
  });

  it.each(["title", "description"] as const)("codes an empty %s as model_output_missing", async (field) => {
    const output = { title: "A title", description: "A description", keywords: [], [field]: "" };
    vi.mocked(generateText).mockResolvedValue({
      finishReason: "stop",
      output,
      text: JSON.stringify(output),
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as any);

    await expect(getSummaryAndTags("asset-123")).rejects.toMatchObject({
      code: "model_output_missing",
      dependency: "ai_provider",
      facts: { ...modelFacts, field },
    });
  });
});
