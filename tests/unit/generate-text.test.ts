import { beforeEach, describe, expect, it, vi } from "vitest";

import { SYSTEM_PROMPT_CANARY } from "../../src/lib/prompt-fragments";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  Output: {
    object: vi.fn(({ schema }) => ({ schema })),
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
  getReliableLanguageCode: vi.fn(),
}));

vi.mock("../../src/primitives/storyboards", () => ({
  getStoryboardUrl: vi.fn(),
}));

vi.mock("../../src/primitives/shots", () => ({
  waitForShotsForAsset: vi.fn(),
}));

const { generateText: generateTextWithModel } = await import("ai");
const {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  getVideoTrackDurationSecondsFromAsset,
  isAudioOnlyAsset,
} = await import("../../src/lib/mux-assets");
const { createLanguageModelFromConfig, resolveLanguageModelConfig } = await import("../../src/lib/providers");
const { resolveMuxSigningContext } = await import("../../src/lib/workflow-credentials");
const { fetchTranscriptForAsset, getReliableLanguageCode } = await import("../../src/primitives/transcripts");
const { getStoryboardUrl } = await import("../../src/primitives/storyboards");
const { waitForShotsForAsset } = await import("../../src/primitives/shots");
const {
  generateText,
  measureGenerateTextLength,
  resolveGenerateTextLengthLimit,
  resolveGenerateTextOptions,
  selectGenerateTextShotFrames,
} = await import("../../src/workflows/generate-text");

const BRIEF = {
  centralIdea: "Reliable workflows preserve a grounded source.",
  readerValue: "Repurpose content without losing the original point.",
  keyPoints: ["Use one source"],
  sourceSpecifics: ["One asset"],
  visualContext: ["A developer demonstrates a video workflow on screen."],
  voiceSignals: ["Practical"],
  claimsToQualify: [],
};

function modelResponse(output: unknown, totalTokens: number) {
  return {
    finishReason: "stop",
    output,
    text: JSON.stringify(output),
    usage: { inputTokens: totalTokens - 1, outputTokens: 1, totalTokens },
  } as any;
}

function queueGenerations(contents: string[]) {
  const mock = vi.mocked(generateTextWithModel);
  mock.mockResolvedValueOnce(modelResponse(BRIEF, 100));
  for (const content of contents) {
    mock.mockResolvedValueOnce(modelResponse({ content }, 10));
  }
}

function userMessage(callIndex: number) {
  const call = vi.mocked(generateTextWithModel).mock.calls[callIndex][0] as any;
  return call.messages[1];
}

function systemPrompt(callIndex: number): string {
  const call = vi.mocked(generateTextWithModel).mock.calls[callIndex][0] as any;
  return call.messages[0].content;
}

beforeEach(() => {
  vi.resetAllMocks();

  const track = { id: "text-track", language_code: "en", status: "ready", type: "text" };
  vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
    asset: { id: "asset-123", duration: 120, tracks: [track, { type: "video" }] },
    playbackId: "playback-123",
    policy: "public",
  } as any);
  vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(120);
  vi.mocked(getVideoTrackDurationSecondsFromAsset).mockReturnValue(120);
  vi.mocked(isAudioOnlyAsset).mockReturnValue(false);
  vi.mocked(resolveMuxSigningContext).mockResolvedValue(undefined);
  vi.mocked(resolveLanguageModelConfig).mockReturnValue({ provider: "openai", modelId: "test-model" } as any);
  vi.mocked(createLanguageModelFromConfig).mockResolvedValue({} as any);
  vi.mocked(getReliableLanguageCode).mockReturnValue("en");
  vi.mocked(fetchTranscriptForAsset).mockResolvedValue({
    track,
    transcriptText: "A grounded source about reliable video workflows.",
  } as any);
  vi.mocked(getStoryboardUrl).mockResolvedValue("https://image.mux.com/playback-123/storyboard.png");
  vi.mocked(waitForShotsForAsset).mockResolvedValue({
    status: "completed",
    createdAt: "2026-08-13T00:00:00Z",
    shots: [
      { startTime: 0, imageUrl: "shot-0" },
      { startTime: 20, imageUrl: "shot-20" },
      { startTime: 30, imageUrl: "shot-30" },
      { startTime: 50, imageUrl: "shot-50" },
    ],
  });
});

describe("generateText", () => {
  it("extracts one brief with the scoped storyboard, then writes every variant × artifact in request order", async () => {
    queueGenerations(["one:x_post", "one:blog_post", "insight_led:x_post", "insight_led:blog_post"]);

    const result = await generateText("asset-123", {
      variants: [{ key: "one" }, { key: "insight_led", instructions: "Lead with the insight." }],
      artifacts: [
        { key: "x_post", kind: "short_form", channel: "x" },
        { key: "blog_post", kind: "long_form" },
      ],
      audience: "Video developers",
      scope: { startTime: 10, endTime: 40 },
    });

    expect(vi.mocked(fetchTranscriptForAsset).mock.calls[0][2]).toEqual(expect.objectContaining({
      scope: { startTime: 10, endTime: 40 },
      required: true,
      cleanTranscript: true,
    }));
    expect(getStoryboardUrl).toHaveBeenCalledWith("playback-123", 640, false, undefined, { startTime: 10, endTime: 40 });
    expect(waitForShotsForAsset).not.toHaveBeenCalled();
    expect(generateTextWithModel).toHaveBeenCalledTimes(5);

    const briefMessage = userMessage(0);
    expect(briefMessage.content).toEqual([
      { type: "text", text: expect.stringContaining("A grounded source about reliable video workflows.") },
      { type: "image", image: "https://image.mux.com/playback-123/storyboard.png" },
    ]);
    expect(briefMessage.content[0].text).toContain("Intended audience: Video developers");
    expect(briefMessage.content[0].text).toContain("Output language: English");

    expect(result.variants).toEqual([
      {
        key: "one",
        artifacts: [
          { key: "x_post", kind: "short_form", content: "one:x_post" },
          { key: "blog_post", kind: "long_form", content: "one:blog_post" },
        ],
      },
      {
        key: "insight_led",
        artifacts: [
          { key: "x_post", kind: "short_form", content: "insight_led:x_post" },
          { key: "blog_post", kind: "long_form", content: "insight_led:blog_post" },
        ],
      },
    ]);
    expect(result.storyboardUrl).toBe("https://image.mux.com/playback-123/storyboard.png");
    expect(result.usage).toEqual({
      inputTokens: 99 + (4 * 9),
      outputTokens: 5,
      totalTokens: 140,
      metadata: { assetDurationSeconds: 120, thumbnailCount: 1 },
    });
    expect(result.safety).toEqual({ leaksDetected: false, scrubbedFields: [] });
  });

  it("defaults to a single 'default' variant when variants are omitted", async () => {
    queueGenerations(["hello"]);

    const result = await generateText("asset-123", {
      artifacts: [{ key: "post", kind: "short_form" }],
    });

    expect(result.variants).toEqual([
      { key: "default", artifacts: [{ key: "post", kind: "short_form", content: "hello" }] },
    ]);
  });

  it("sends a text-only brief request for audio-only assets", async () => {
    vi.mocked(isAudioOnlyAsset).mockReturnValue(true);
    queueGenerations(["hello"]);

    const result = await generateText("asset-123", {
      artifacts: [{ key: "post", kind: "short_form" }],
    });

    expect(getStoryboardUrl).not.toHaveBeenCalled();
    expect(userMessage(0).content).toEqual([{ type: "text", text: expect.any(String) }]);
    expect(result.storyboardUrl).toBeUndefined();
    expect(result.usage?.metadata?.thumbnailCount).toBe(0);
  });

  it("attaches evenly sampled shot frames inside the scope when useShots is true", async () => {
    queueGenerations(["hello"]);

    await generateText("asset-123", {
      artifacts: [{ key: "post", kind: "short_form" }],
      useShots: true,
      scope: { startTime: 10, endTime: 40 },
    });

    expect(waitForShotsForAsset).toHaveBeenCalledWith("asset-123", { credentials: undefined });
    expect(userMessage(0).content.slice(1)).toEqual([
      { type: "image", image: "https://image.mux.com/playback-123/storyboard.png" },
      { type: "image", image: "shot-0" },
      { type: "image", image: "shot-20" },
      { type: "image", image: "shot-30" },
    ]);
  });

  it("rejects useShots for audio-only assets", async () => {
    vi.mocked(isAudioOnlyAsset).mockReturnValue(true);

    await expect(generateText("asset-123", {
      artifacts: [{ key: "post", kind: "short_form" }],
      useShots: true,
    })).rejects.toMatchObject({ publicType: "validation_error", publicMessage: expect.stringContaining("useShots") });
    expect(generateTextWithModel).not.toHaveBeenCalled();
  });

  it("only renders variant, artifact, and steering sections that were supplied", async () => {
    queueGenerations(["a", "b"]);

    await generateText("asset-123", {
      variants: [{ key: "plain" }, { key: "angled", instructions: "Use a product-led angle." }],
      artifacts: [{ key: "post", kind: "short_form", channel: "linkedin", instructions: "Open with the tradeoff." }],
      voice: "editorial",
      callToAction: "soft",
      brandTerms: ["Mux", "Robots"],
    });

    const plainSystem = systemPrompt(1);
    expect(plainSystem).toContain("The variant key is not a writing instruction.");
    expect(plainSystem).toContain("<voice>");
    expect(plainSystem).toContain("<call_to_action>");
    expect(plainSystem).toContain("<brand_terms>");
    expect(plainSystem).toContain("\"Mux\", \"Robots\"");
    expect(plainSystem).not.toContain("Write for this intended audience");
    expect(plainSystem).toContain("at or below 300 words");
    expect(plainSystem).toContain("LinkedIn post");
    expect(userMessage(1).content).not.toContain("<variant_instructions>");
    expect(userMessage(1).content).toContain("<artifact_instructions>\nOpen with the tradeoff.");

    const angledSystem = systemPrompt(2);
    expect(angledSystem).toContain("Apply the variant angle from the <variant_instructions> section.");
    expect(userMessage(2).content).toContain("<variant_instructions>\nUse a product-led angle.");
    expect(userMessage(2).content).toContain("<language>\nWrite all generated text in English.");
  });

  it("fails as a non-retryable processing error when an artifact exceeds its cap, keeping usage", async () => {
    queueGenerations(["x".repeat(281)]);

    await expect(generateText("asset-123", {
      artifacts: [{ key: "x_post", kind: "short_form", channel: "x" }],
    })).rejects.toMatchObject({
      publicType: "processing_error",
      publicMessage: "Generated text for variants[default].artifacts[x_post] exceeded the 280 characters limit (281 returned).",
      retryable: false,
      usage: { inputTokens: 108, outputTokens: 2, totalTokens: 110 },
    });
  });

  it("suppresses artifacts that leak the prompt canary and reports them", async () => {
    queueGenerations([`Great post. ${SYSTEM_PROMPT_CANARY}`]);

    const result = await generateText("asset-123", {
      artifacts: [{ key: "post", kind: "short_form" }],
    });

    expect(result.variants[0].artifacts[0].content).toBe("");
    expect(result.safety).toEqual({
      leaksDetected: true,
      scrubbedFields: [{ field: "variants[default].artifacts[post].content", reason: "canary" }],
    });
  });

  it("never sets an output token budget and trims over-long brief arrays after parsing", async () => {
    const mock = vi.mocked(generateTextWithModel);
    mock.mockResolvedValueOnce(modelResponse({
      ...BRIEF,
      keyPoints: Array.from({ length: 12 }, (_, index) => `point ${index}`),
    }, 100));
    mock.mockResolvedValueOnce(modelResponse({ content: "hello" }, 10));

    await generateText("asset-123", {
      artifacts: [{ key: "post", kind: "short_form" }],
    });

    for (const call of mock.mock.calls) {
      expect((call[0] as any).maxOutputTokens).toBeUndefined();
    }
    const brief = JSON.parse(userMessage(1).content.match(/<source_brief format="json">\n([\s\S]*?)\n<\/source_brief>/)![1]);
    expect(brief.keyPoints).toHaveLength(8);
  });

  it("fails when the scoped transcript has no usable content", async () => {
    vi.mocked(fetchTranscriptForAsset).mockResolvedValue({ transcriptText: "   ", track: {} } as any);

    await expect(generateText("asset-123", {
      artifacts: [{ key: "post", kind: "short_form" }],
      scope: { startTime: 10 },
    })).rejects.toMatchObject({
      publicType: "validation_error",
      publicMessage: "Transcript has no usable content in the requested scope.",
    });
  });
});

describe("resolveGenerateTextOptions", () => {
  const artifacts = [{ key: "post", kind: "short_form" as const }];

  it("rejects duplicate keys, bad key shapes, and too many items", () => {
    expect(() => resolveGenerateTextOptions({ artifacts: [...artifacts, ...artifacts] })).toThrow("Duplicate artifact key \"post\".");
    expect(() => resolveGenerateTextOptions({ artifacts: [{ key: "Bad-Key", kind: "short_form" }] })).toThrow("lowercase snake_case");
    expect(() => resolveGenerateTextOptions({ artifacts: [] })).toThrow("At least one artifact is required.");
    expect(() => resolveGenerateTextOptions({
      artifacts,
      variants: Array.from({ length: 6 }, (_, index) => ({ key: `v${index}` })),
    })).toThrow("At most 5 variants are supported (received 6).");
  });

  it("enforces per-kind length bounds and the X character ceiling", () => {
    expect(() => resolveGenerateTextOptions({
      artifacts: [{ key: "x", kind: "short_form", channel: "x", maxLength: { unit: "characters", value: 281 } }],
    })).toThrow("supports at most 280 characters");
    expect(() => resolveGenerateTextOptions({
      artifacts: [{ key: "post", kind: "long_form", maxLength: { unit: "words", value: 50 } }],
    })).toThrow("between 100 and 3000");
    expect(() => resolveGenerateTextOptions({
      artifacts: [{ key: "post", kind: "short_form", maxLength: { unit: "words", value: 501 } }],
    })).toThrow("between 5 and 500");
  });

  it("enforces steering bounds", () => {
    expect(() => resolveGenerateTextOptions({ artifacts, voice: "sassy" as any })).toThrow("Invalid voice \"sassy\"");
    expect(() => resolveGenerateTextOptions({ artifacts, callToAction: "loud" as any })).toThrow("Invalid callToAction \"loud\"");
    expect(() => resolveGenerateTextOptions({ artifacts, audience: "a".repeat(161) })).toThrow("audience must be 1-160 characters.");
    expect(() => resolveGenerateTextOptions({ artifacts, brandTerms: [] })).toThrow("brandTerms must contain 1-10 terms.");
    expect(() => resolveGenerateTextOptions({ artifacts, brandTerms: Array.from({ length: 10 }, () => "a".repeat(30)) }))
      .toThrow("Combined brandTerms must be 240 characters or fewer.");
  });

  it("fills in the default variant", () => {
    expect(resolveGenerateTextOptions({ artifacts }).variants).toEqual([{ key: "default" }]);
  });
});

describe("length policy", () => {
  it("applies channel defaults and explicit caps", () => {
    expect(resolveGenerateTextLengthLimit({ key: "a", kind: "short_form" })).toEqual({ unit: "words", value: 150 });
    expect(resolveGenerateTextLengthLimit({ key: "a", kind: "short_form", channel: "x" })).toEqual({ unit: "characters", value: 280 });
    expect(resolveGenerateTextLengthLimit({ key: "a", kind: "long_form" })).toEqual({ unit: "words", value: 1200 });
    expect(resolveGenerateTextLengthLimit({ key: "a", kind: "long_form", maxLength: { unit: "words", value: 400 } }))
      .toEqual({ unit: "words", value: 400 });
  });

  it("measures words and code points", () => {
    expect(measureGenerateTextLength("  one two\nthree ", "words")).toBe(3);
    expect(measureGenerateTextLength("", "words")).toBe(0);
    expect(measureGenerateTextLength("héllo👋", "characters")).toBe(6);
  });
});

describe("selectGenerateTextShotFrames", () => {
  const shots = Array.from({ length: 10 }, (_, index) => ({ startTime: index * 10, imageUrl: `shot-${index * 10}` }));

  it("keeps shots whose coverage overlaps the scope", () => {
    const selected = selectGenerateTextShotFrames(shots, 100, { startTime: 25, endTime: 45 });
    expect(selected.map(shot => shot.imageUrl)).toEqual(["shot-20", "shot-30", "shot-40"]);
  });

  it("samples evenly when there are more candidates than the limit", () => {
    const selected = selectGenerateTextShotFrames(shots, 100, undefined, 4);
    expect(selected.map(shot => shot.imageUrl)).toEqual(["shot-0", "shot-30", "shot-60", "shot-90"]);
  });

  it("returns the middle shot when the limit is one", () => {
    expect(selectGenerateTextShotFrames(shots, 100, undefined, 1).map(shot => shot.imageUrl)).toEqual(["shot-50"]);
  });

  it("drops shots without an image or beyond the asset duration", () => {
    const selected = selectGenerateTextShotFrames(
      [{ startTime: 0, imageUrl: "" }, { startTime: 5, imageUrl: "ok" }, { startTime: 200, imageUrl: "late" }],
      100,
    );
    expect(selected.map(shot => shot.imageUrl)).toEqual(["ok"]);
  });
});
