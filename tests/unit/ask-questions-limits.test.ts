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

vi.mock("../../src/primitives/transcripts", () => ({
  fetchTranscriptForAsset: vi.fn(),
}));

const { generateText } = await import("ai");
const {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  isAudioOnlyAsset,
} = await import("../../src/lib/mux-assets");
const { createLanguageModelFromConfig, resolveLanguageModelConfig } = await import("../../src/lib/providers");
const { resolveMuxSigningContext } = await import("../../src/lib/workflow-credentials");
const { fetchTranscriptForAsset } = await import("../../src/primitives/transcripts");
const { askQuestions } = await import("../../src/workflows");
const { ASK_QUESTIONS_MAX_QUESTIONS_PER_CALL } = await import("../../src/workflows/ask-questions");

// Builds a mocked "answers" array matching `count` questions
function mockAnswers(count: number) {
  return Array.from({ length: count }, () => ({
    question: "irrelevant, overwritten from trusted input",
    answer: "yes",
    confidence: 0.9,
    reasoning: "ok",
    skipped: false,
  }));
}

beforeEach(() => {
  vi.resetAllMocks();

  // Audio-only path is used throughout so to avoid need to
  // mock storyboard/image plumbing
  vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
    asset: { id: "asset-123", duration: 120, tracks: [{ type: "audio" }] },
    playbackId: "playback-123",
    policy: "public",
  } as any);
  vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(120);
  vi.mocked(isAudioOnlyAsset).mockReturnValue(true);
  vi.mocked(resolveMuxSigningContext).mockResolvedValue(undefined);
  vi.mocked(resolveLanguageModelConfig).mockReturnValue({
    provider: "openai",
    modelId: "test-model",
  } as any);
  vi.mocked(createLanguageModelFromConfig).mockResolvedValue({} as any);
  vi.mocked(fetchTranscriptForAsset).mockResolvedValue({
    track: { id: "text-track", language_code: "en", status: "ready", type: "text" },
    transcriptText: "WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nHello world",
  } as any);
});

describe("askQuestions question-count cap", () => {
  it(`rejects a call with more than ${ASK_QUESTIONS_MAX_QUESTIONS_PER_CALL} questions without touching the model`, async () => {
    const tooMany = Array.from(
      { length: ASK_QUESTIONS_MAX_QUESTIONS_PER_CALL + 1 },
      (_, i) => ({ question: `Question ${i}?` }),
    );

    await expect(askQuestions("asset-123", tooMany)).rejects.toMatchObject({
      publicType: "validation_error",
      message: expect.stringContaining(
        `at most ${ASK_QUESTIONS_MAX_QUESTIONS_PER_CALL} are allowed per call`,
      ),
    });

    // Validation must short-circuit before any asset/model work is done.
    expect(getPlaybackIdForAsset).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  it(`allows a call with exactly ${ASK_QUESTIONS_MAX_QUESTIONS_PER_CALL} questions to pass validation`, async () => {
    const atLimit = Array.from(
      { length: ASK_QUESTIONS_MAX_QUESTIONS_PER_CALL },
      (_, i) => ({ question: `Question ${i}?` }),
    );
    const answers = mockAnswers(ASK_QUESTIONS_MAX_QUESTIONS_PER_CALL);
    vi.mocked(generateText).mockResolvedValue({
      finishReason: "stop",
      output: { answers },
      text: JSON.stringify({ answers }),
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        reasoningTokens: 0,
        cachedInputTokens: 0,
      },
    } as any);

    const result = await askQuestions("asset-123", atLimit);

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result.answers).toHaveLength(ASK_QUESTIONS_MAX_QUESTIONS_PER_CALL);
  });
});
