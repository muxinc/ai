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
const { askQuestions } = await import("../../src/workflows/ask-questions");

const ANSWER = { question: "echo", answer: "yes", confidence: 0.9, reasoning: "Shown on screen.", skipped: false };

function mockModelAnswers(answers: unknown[]) {
  vi.mocked(generateText).mockResolvedValue({
    finishReason: "stop",
    output: { answers },
    text: JSON.stringify({ answers }),
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  } as any);
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
    transcriptText: "A presenter holds up a pair of glasses.",
  } as any);
  vi.mocked(getStoryboardUrl).mockResolvedValue("https://image.example/storyboard.jpg");
  mockModelAnswers([ANSWER]);
});

describe("askQuestions classified errors", () => {
  const modelFacts = { call: "answer_questions", provider: "openai", model: "test-model", assetId: "asset-123" };
  const QUESTION = [{ question: "Are glasses shown?" }];

  it("opts in to classified errors from the asset and transcript helpers", async () => {
    await askQuestions("asset-123", QUESTION);

    expect(vi.mocked(getPlaybackIdForAsset).mock.calls[0][3]).toEqual({ classifiedErrors: true });
    expect(vi.mocked(fetchTranscriptForAsset).mock.calls[0][2]).toMatchObject({ required: false, classifiedErrors: true });
  });

  it.each([
    ["no questions", [], {}, { parameter: "questions", reason: "empty" }, ["questions"]],
    ["a blank question", [{ question: "  " }], {}, { parameter: "questions[0].question", reason: "empty" }, ["questions"]],
    ["a question over the length limit", [{ question: "q".repeat(2001) }], {}, { parameter: "questions[0].question", reason: "too_long", length: 2001 }, ["questions"]],
    ["both answerOptions and freeFormReply", [{ question: "Q?", answerOptions: ["a"], freeFormReply: true }], {}, { parameter: "questions[0].answerOptions", reason: "conflicts_with", with: "questions[0].freeFormReply" }, ["questions"]],
    ["blank answerOptions", [{ question: "Q?", answerOptions: [" "] }], {}, { parameter: "questions[0].answerOptions", reason: "empty" }, ["questions"]],
    ["an answer option over the limit", [{ question: "Q?", answerOptions: ["abcdef"] }], { maxAnswerOptionLength: 5 }, { parameter: "questions[0].answerOptions", reason: "too_long", length: 6, maxLength: 5 }, ["questions", "maxAnswerOptionLength"]],
    ["a non-positive maxAnswerOptionLength", QUESTION, { maxAnswerOptionLength: 0 }, { parameter: "maxAnswerOptionLength", reason: "not_positive", value: 0 }, ["maxAnswerOptionLength"]],
    ["a NaN maxFreeFormAnswerLength", QUESTION, { maxFreeFormAnswerLength: Number.NaN }, { parameter: "maxFreeFormAnswerLength", reason: "not_positive", value: "NaN" }, ["maxFreeFormAnswerLength"]],
  ] as const)("codes %s as invalid_parameter", async (_, questions, options, facts, inputs) => {
    const error = await askQuestions("asset-123", questions as any, options).catch(e => e);

    expect(error).toMatchObject({ code: "invalid_parameter", type: "validation_error", source: "request", facts: { ...facts, inputs } });
    expect(getPlaybackIdForAsset).not.toHaveBeenCalled();
  });

  it("codes an audio-only asset without a transcript as invalid_parameter", async () => {
    vi.mocked(isAudioOnlyAsset).mockReturnValue(true);

    await expect(askQuestions("asset-123", QUESTION, { includeTranscript: false })).rejects.toMatchObject({
      code: "invalid_parameter",
      facts: { parameter: "includeTranscript", reason: "not_allowed", inputs: ["includeTranscript"] },
    });
  });

  it("codes a signed asset without signing keys as signing_credentials_missing", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
      asset: { id: "asset-123", duration: 120, tracks: [] },
      playbackId: "playback-123",
      policy: "signed",
    } as any);

    await expect(askQuestions("asset-123", QUESTION)).rejects.toMatchObject({ code: "signing_credentials_missing", source: "internal" });
  });

  it("codes a scope that starts after the video ends as invalid_scope (no_video)", async () => {
    vi.mocked(getVideoTrackDurationSecondsFromAsset).mockReturnValue(60);

    await expect(askQuestions("asset-123", QUESTION, { scope: { startTime: 90 } })).rejects.toMatchObject({
      code: "invalid_scope",
      facts: { reason: "no_video", startTime: 90, videoEndTime: 60 },
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("downloads the storyboard with classified errors in base64 mode", async () => {
    vi.mocked(downloadImageAsBase64).mockResolvedValue({ base64Data: "data:image/jpeg;base64,AAAA" } as any);

    await askQuestions("asset-123", QUESTION, { imageSubmissionMode: "base64" });

    expect(downloadImageAsBase64).toHaveBeenCalledWith("https://image.example/storyboard.jpg", undefined, { classifiedErrors: true, call: "fetch_storyboard" });
    expect(vi.mocked(generateText).mock.calls[0][0].messages[0].content[1]).toEqual({ type: "image", image: "data:image/jpeg;base64,AAAA" });
  });

  it("passes a classified storyboard download failure through without model facts", async () => {
    const failure = new MuxAiError("Failed to download image from Mux (HTTP 404)", {
      type: "validation_error",
      source: "asset",
      dependency: "mux_video",
      facts: { call: "fetch_storyboard", status: 404 },
    });
    vi.mocked(downloadImageAsBase64).mockRejectedValue(failure);

    const error = await askQuestions("asset-123", QUESTION, { imageSubmissionMode: "base64" }).catch(e => e);

    expect(error).toBe(failure);
    expect(error.facts).toEqual({ call: "fetch_storyboard", status: 404 });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("classifies a failed model call, naming the call", async () => {
    vi.mocked(generateText).mockRejectedValue(new Error("socket hang up"));

    const error = await askQuestions("asset-123", QUESTION).catch(e => e);

    expect(MuxAiError.is(error)).toBe(true);
    expect(error.facts).toMatchObject(modelFacts);
  });

  it("codes a missing answer as model_output_invalid", async () => {
    mockModelAnswers([ANSWER]);

    await expect(askQuestions("asset-123", [...QUESTION, { question: "Is it outdoors?" }])).rejects.toMatchObject({
      code: "model_output_invalid",
      dependency: "ai_provider",
      facts: { ...modelFacts, questionCount: 2, returnedAnswerCount: 1 },
    });
  });

  it("codes an answer outside the question's options as model_output_invalid, without the answer in its facts", async () => {
    // Only a batch with a free-form question takes the per-question check: otherwise the
    // response schema is the options' enum.
    mockModelAnswers([{ ...ANSWER, answer: "red" }, { ...ANSWER, answer: "A pair of glasses." }]);

    const error = await askQuestions("asset-123", [
      { question: "Which color?", answerOptions: ["blue", "green"] },
      { question: "Describe it.", freeFormReply: true },
    ]).catch(e => e);

    expect(error).toMatchObject({ code: "model_output_invalid", facts: { ...modelFacts, questionIndex: 0 } });
    expect(JSON.stringify(error.facts)).not.toContain("red");
  });
});
