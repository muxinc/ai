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
  isAudioOnlyAsset: vi.fn(),
}));

vi.mock("../../src/lib/providers", () => ({
  createLanguageModelFromConfig: vi.fn(),
  resolveLanguageModelConfig: vi.fn(),
}));

vi.mock("../../src/lib/workflow-credentials", () => ({
  resolveMuxSigningContext: vi.fn(),
}));

vi.mock("../../src/primitives/transcripts", () => ({
  extractTimestampedTranscript: vi.fn(),
  fetchTranscriptForAsset: vi.fn(),
  getReadyTextTracks: vi.fn(),
  getReliableLanguageCode: vi.fn(),
}));

const { generateText } = await import("ai");
const {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  isAudioOnlyAsset,
} = await import("../../src/lib/mux-assets");
const { createLanguageModelFromConfig, resolveLanguageModelConfig } = await import("../../src/lib/providers");
const { resolveMuxSigningContext } = await import("../../src/lib/workflow-credentials");
const {
  extractTimestampedTranscript,
  fetchTranscriptForAsset,
  getReadyTextTracks,
  getReliableLanguageCode,
} = await import("../../src/primitives/transcripts");
const { generateChapters } = await import("../../src/workflows/chapters");

beforeEach(() => {
  vi.resetAllMocks();

  const track = { id: "text-track", language_code: "en", status: "ready", type: "text" };
  vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
    asset: { id: "asset-123", duration: 120, tracks: [track] },
    playbackId: "playback-123",
    policy: "public",
  } as any);
  vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(120);
  vi.mocked(isAudioOnlyAsset).mockReturnValue(false);
  vi.mocked(resolveMuxSigningContext).mockResolvedValue(undefined);
  vi.mocked(resolveLanguageModelConfig).mockReturnValue({
    provider: "openai",
    modelId: "test-model",
  } as any);
  vi.mocked(createLanguageModelFromConfig).mockResolvedValue({} as any);
  vi.mocked(getReadyTextTracks).mockReturnValue([track] as any);
  vi.mocked(getReliableLanguageCode).mockReturnValue("en");
  vi.mocked(fetchTranscriptForAsset).mockResolvedValue({
    track,
    transcriptText: "WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nIntroduction",
  } as any);
  vi.mocked(extractTimestampedTranscript).mockReturnValue("[0s] Introduction");
  vi.mocked(generateText).mockResolvedValue({
    finishReason: "stop",
    output: { chapters: [{ startTime: 0, title: "Introduction" }] },
    text: JSON.stringify({ chapters: [{ startTime: 0, title: "Introduction" }] }),
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    },
  } as any);
});

describe("generateChapters scope handling", () => {
  it("treats an empty scope like an omitted scope", async () => {
    const omittedResult = await generateChapters("asset-123");
    const emptyResult = await generateChapters("asset-123", { scope: {} });

    expect(vi.mocked(fetchTranscriptForAsset).mock.calls[0][2].scope).toBeUndefined();
    expect(vi.mocked(fetchTranscriptForAsset).mock.calls[1][2].scope).toBeUndefined();

    const omittedPrompt = vi.mocked(generateText).mock.calls[0][0].messages[1].content;
    const emptyPrompt = vi.mocked(generateText).mock.calls[1][0].messages[1].content;
    expect(emptyPrompt).toBe(omittedPrompt);
    expect(emptyResult.chapters).toEqual(omittedResult.chapters);
  });
});
