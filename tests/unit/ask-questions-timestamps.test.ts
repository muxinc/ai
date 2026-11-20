import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  Output: {
    object: vi.fn(() => ({})),
  },
}));

vi.mock("../../src/lib/image-download", () => ({
  downloadImageAsBase64: vi.fn(),
}));

vi.mock("../../src/lib/storyboard-labels", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/lib/storyboard-labels")>(),
  labelStoryboardFrames: vi.fn(),
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
  getStoryboardFrames: vi.fn(),
  getStoryboardUrl: vi.fn(),
}));

vi.mock("../../src/primitives/transcripts", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/primitives/transcripts")>(),
  fetchTranscriptForAsset: vi.fn(),
}));

const { generateText } = await import("ai");
const { downloadImageAsBase64 } = await import("../../src/lib/image-download");
const { labelStoryboardFrames } = await import("../../src/lib/storyboard-labels");
const {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  getVideoTrackDurationSecondsFromAsset,
  isAudioOnlyAsset,
} = await import("../../src/lib/mux-assets");
const { createLanguageModelFromConfig, resolveLanguageModelConfig } = await import("../../src/lib/providers");
const { resolveMuxSigningContext } = await import("../../src/lib/workflow-credentials");
const { getStoryboardFrames, getStoryboardUrl } = await import("../../src/primitives/storyboards");
const { fetchTranscriptForAsset } = await import("../../src/primitives/transcripts");
const { askQuestions } = await import("../../src/workflows/ask-questions");

const VTT = "WEBVTT\n\n00:00:12.500 --> 00:00:15.000\nThese are my reading glasses.\n";
const ANSWER = { question: "echo", answer: "yes", confidence: 0.9, reasoning: "Shown on screen.", skipped: false, timestamp: null };

function mockModelAnswers(answers: unknown[]) {
  vi.mocked(generateText).mockResolvedValue({
    finishReason: "stop",
    output: { answers },
    text: JSON.stringify({ answers }),
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  } as any);
}

const STORYBOARD_BYTES = new Uint8Array([1, 2, 3]);
const LABELED_BYTES = new Uint8Array([4, 5, 6]);

function imagePart(): any {
  const { content } = (vi.mocked(generateText).mock.calls[0][0].messages as any)[0];
  return content[1];
}

function userPrompt(): string {
  const { content } = (vi.mocked(generateText).mock.calls[0][0].messages as any)[0];
  return typeof content === "string" ? content : content[0].text;
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
  vi.mocked(isAudioOnlyAsset).mockReturnValue(false);
  vi.mocked(resolveMuxSigningContext).mockResolvedValue(undefined);
  vi.mocked(resolveLanguageModelConfig).mockReturnValue({ provider: "openai", modelId: "test-model" } as any);
  vi.mocked(createLanguageModelFromConfig).mockResolvedValue({} as any);
  vi.mocked(fetchTranscriptForAsset).mockResolvedValue({
    track: { id: "text-track", language_code: "en", status: "ready", type: "text" },
    transcriptText: VTT,
  } as any);
  vi.mocked(getStoryboardUrl).mockResolvedValue("https://image.example/storyboard.jpg");
  vi.mocked(getStoryboardFrames).mockResolvedValue([
    { startTime: 0, row: 0, column: 0, width: 284, height: 160 },
    { startTime: 4.986, row: 0, column: 1, width: 284, height: 160 },
  ]);
  vi.mocked(downloadImageAsBase64).mockResolvedValue({ buffer: STORYBOARD_BYTES } as any);
  vi.mocked(labelStoryboardFrames).mockResolvedValue(LABELED_BYTES);
  mockModelAnswers([ANSWER]);
});

describe("askQuestions timestamps", () => {
  const QUESTION = [{ question: "Are glasses shown?" }];

  it("gives the model frame times and a timestamped transcript", async () => {
    await askQuestions("asset-123", QUESTION);

    expect(vi.mocked(fetchTranscriptForAsset).mock.calls[0][2]).toMatchObject({ cleanTranscript: false });
    expect(userPrompt()).toContain("#1: 0s\n#2: 5s");
    expect(userPrompt()).toContain("[12.5s] These are my reading glasses.");
  });

  it("requests frame metadata at the same width as the storyboard", async () => {
    await askQuestions("asset-123", QUESTION, { storyboardWidth: 800 });

    expect(getStoryboardFrames).toHaveBeenCalledWith("playback-123", 800, false, undefined, undefined);
    expect(vi.mocked(getStoryboardUrl).mock.calls[0][1]).toBe(800);
  });

  it("gives the model untimed transcript text when no cue timings parse", async () => {
    vi.mocked(fetchTranscriptForAsset).mockResolvedValue({
      track: { id: "text-track", language_code: "en", status: "ready", type: "text" },
      transcriptText: "WEBVTT\n\n0:12.5 --> 0:15\nThese are my reading glasses.\n",
    } as any);

    await askQuestions("asset-123", QUESTION);

    expect(userPrompt()).toContain("<transcript format=\"plain text\">\nThese are my reading glasses.");
  });

  it("keeps returning the transcript as plain text", async () => {
    const result = await askQuestions("asset-123", QUESTION);

    expect(result.transcriptText).toBe("These are my reading glasses.");
  });

  it("passes raw WebVTT through when cleanTranscript is false", async () => {
    const result = await askQuestions("asset-123", QUESTION, { cleanTranscript: false });

    expect(userPrompt()).toContain("00:00:12.500 --&gt; 00:00:15.000");
    expect(result.transcriptText).toBe(VTT);
  });

  it("returns the cited timestamp", async () => {
    mockModelAnswers([{ ...ANSWER, timestamp: 12 }]);

    const result = await askQuestions("asset-123", QUESTION);

    expect(result.answers[0].timestamp).toBe(12);
  });

  it("clamps a frame time rounded past the end of the asset to its duration", async () => {
    vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(119.8);
    mockModelAnswers([{ ...ANSWER, timestamp: 120 }]);

    const result = await askQuestions("asset-123", QUESTION);

    expect(result.answers[0].timestamp).toBe(119.8);
  });

  it.each([
    ["null", { timestamp: null }],
    ["negative", { timestamp: -1 }],
    ["past the end of the asset", { timestamp: 121 }],
    ["on a skipped question", { timestamp: 12, skipped: true, answer: "__SKIPPED__" }],
  ])("omits a timestamp that is %s", async (_, overrides) => {
    mockModelAnswers([{ ...ANSWER, ...overrides }]);

    const result = await askQuestions("asset-123", QUESTION);

    expect(result.answers[0]).not.toHaveProperty("timestamp");
  });

  it.each([12, 95])("omits timestamp %s outside the requested scope", async (timestamp) => {
    mockModelAnswers([{ ...ANSWER, timestamp }]);

    const result = await askQuestions("asset-123", QUESTION, { scope: { startTime: 60, endTime: 90 } });

    expect(result.answers[0]).not.toHaveProperty("timestamp");
  });

  it("sends the storyboard as a JPEG labeled with frame numbers", async () => {
    await askQuestions("asset-123", QUESTION);

    expect(vi.mocked(getStoryboardUrl).mock.calls[0][5]).toBe("jpg");
    expect(downloadImageAsBase64).toHaveBeenCalledWith("https://image.example/storyboard.jpg", undefined, expect.anything());
    expect(labelStoryboardFrames).toHaveBeenCalledWith(STORYBOARD_BYTES, [
      { startTime: 0, row: 0, column: 0, width: 284, height: 160 },
      { startTime: 4.986, row: 0, column: 1, width: 284, height: 160 },
    ]);
    expect(imagePart()).toEqual({ type: "image", image: LABELED_BYTES, mediaType: "image/jpeg" });
  });

  it.each([
    [
      "the download",
      () => vi.mocked(downloadImageAsBase64).mockRejectedValue(new Error("HTTP 503")),
      { type: "image", image: "https://image.example/storyboard.jpg" },
    ],
    [
      "labeling",
      () => vi.mocked(labelStoryboardFrames).mockImplementation(() => {
        throw new Error("SOI not found");
      }),
      { type: "image", image: STORYBOARD_BYTES, mediaType: "image/jpeg" },
    ],
  ])("answers from the unlabeled storyboard without frame times when %s fails", async (_, fail, image) => {
    fail();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await askQuestions("asset-123", QUESTION);

    expect(imagePart()).toEqual(image);
    expect(userPrompt()).not.toContain("storyboard_frames");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("answering without frame times"), expect.any(Error));
    expect(result.answers).toHaveLength(1);
  });

  it("fails when an inline storyboard can't be downloaded", async () => {
    vi.mocked(downloadImageAsBase64).mockRejectedValue(new Error("HTTP 503"));

    await expect(askQuestions("asset-123", QUESTION, { imageSubmissionMode: "base64" })).rejects.toThrow("HTTP 503");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("answers without frame times when they can't be fetched", async () => {
    vi.mocked(getStoryboardFrames).mockRejectedValue(new Error("socket hang up"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await askQuestions("asset-123", QUESTION);

    expect(userPrompt()).not.toContain("storyboard_frames");
    expect(vi.mocked(getStoryboardUrl).mock.calls[0][5]).toBe("png");
    expect(labelStoryboardFrames).not.toHaveBeenCalled();
    expect(imagePart()).toEqual({ type: "image", image: "https://image.example/storyboard.jpg" });
    expect(result.answers).toHaveLength(1);
  });

  it("doesn't fetch frame times for an audio-only asset", async () => {
    vi.mocked(isAudioOnlyAsset).mockReturnValue(true);

    await askQuestions("asset-123", QUESTION);

    expect(getStoryboardFrames).not.toHaveBeenCalled();
    expect(userPrompt()).toContain("[12.5s] These are my reading glasses.");
  });
});
