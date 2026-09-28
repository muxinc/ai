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

vi.mock("../../src/primitives/storyboards", () => ({
  getStoryboardUrl: vi.fn(),
}));

vi.mock("../../src/primitives/transcripts", () => ({
  fetchTranscriptForAsset: vi.fn(),
  getReadyTextTracks: vi.fn(() => []),
  getReliableLanguageCode: vi.fn(),
}));

const { generateText } = await import("ai");
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

const sceneContext = [
  {
    scene_index: 0,
    start_ms: 0,
    end_ms: 30_000,
    title: "Problem introduction",
    audible_narrative: "The presenter explains why independent analysis disagrees.",
    visual_narrative: "A diagram shows disconnected processing stages.",
    blended_narrative: "The presenter uses a diagram to introduce the problem.",
    notable_audible_concepts: ["shared evidence"],
    notable_visual_concepts: ["workflow diagram"],
    shot_count: 3,
  },
  {
    scene_index: 1,
    start_ms: 30_000,
    end_ms: 60_000,
    title: "Unified workflow",
    blended_narrative: "The disconnected stages converge into one pipeline.",
  },
];

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

describe("summarization scene context", () => {
  it("uses ordered scene context without fetching a storyboard", async () => {
    const result = await getSummaryAndTags("asset-123", {
      sceneContext,
      includeStoryboard: false,
    });

    expect(getStoryboardUrl).not.toHaveBeenCalled();
    expect(result.storyboardUrl).toBeUndefined();

    const request = vi.mocked(generateText).mock.calls[0][0];
    expect(request.system).toContain("ordered scene context");
    expect(request.messages[0].content).toEqual(expect.any(String));
    expect(request.messages[0].content).toContain("<scene_context format=\"json\" order=\"scene_index_ascending\">");
    expect(request.messages[0].content).toContain(JSON.stringify(sceneContext));
    expect(request.messages[0].content).toContain("Follow scene_index order");
  });

  it("combines scene context with a scoped storyboard when requested", async () => {
    await getSummaryAndTags("asset-123", {
      sceneContext,
      scope: { startTime: 10, endTime: 100 },
    });

    expect(getStoryboardUrl).toHaveBeenCalledWith(
      "playback-123",
      640,
      false,
      undefined,
      { startTime: 10, endTime: 100 },
    );

    const request = vi.mocked(generateText).mock.calls[0][0];
    expect(request.messages[0].content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("<scene_context") }),
      {
        type: "image",
        image: "https://image.example/storyboard.jpg",
      },
    ]);
  });

  it("preserves the storyboard prompt path when scene context is absent", async () => {
    await getSummaryAndTags("asset-123");

    expect(getStoryboardUrl).toHaveBeenCalledOnce();
    const request = vi.mocked(generateText).mock.calls[0][0];
    expect(request.system).toContain("storyboard interpretation");
    expect(request.system).not.toContain("ordered scene context");
    expect(request.messages[0].content[0].text).not.toContain("<scene_context");
    expect(request.messages[0].content[0].text).toContain(
      "Analyze the storyboard frames and generate metadata that captures the essence of the video content.",
    );
  });

  it("requires non-empty scene context when the storyboard is disabled", async () => {
    await expect(getSummaryAndTags("asset-123", {
      includeStoryboard: false,
      sceneContext: [],
    })).rejects.toMatchObject({
      publicType: "validation_error",
      message: "Video summarization requires a storyboard unless non-empty sceneContext is provided.",
    });

    expect(fetchTranscriptForAsset).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });
});
