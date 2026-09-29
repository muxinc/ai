import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { SYSTEM_PROMPT_CANARY } from "../../src/lib/prompt-fragments";
import type { ChaptersOptions } from "../../src/workflows/chapters";

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

    const omittedPrompt = vi.mocked(generateText).mock.calls[0][0].messages[0].content;
    const emptyPrompt = vi.mocked(generateText).mock.calls[1][0].messages[0].content;
    expect(emptyPrompt).toBe(omittedPrompt);
    expect(emptyResult.chapters).toEqual(omittedResult.chapters);
  });
});

describe("generateChapters scene context", () => {
  it("uses scene context and aligns chapter starts to scene boundaries in seconds", async () => {
    vi.mocked(generateText).mockResolvedValue({
      finishReason: "stop",
      output: {
        chapters: [
          { startTime: 0, title: "Introduction" },
          { startTime: 28.8, title: "Main topic" },
          { startTime: 31, title: "Duplicate scene" },
          { startTime: 74, title: "Conclusion" },
        ],
      },
      text: JSON.stringify({
        chapters: [
          { startTime: 0, title: "Introduction" },
          { startTime: 28.8, title: "Main topic" },
          { startTime: 31, title: "Duplicate scene" },
          { startTime: 74, title: "Conclusion" },
        ],
      }),
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        reasoningTokens: 0,
        cachedInputTokens: 0,
      },
    } as any);

    const result = await generateChapters("asset-123", {
      sceneContext: [
        { scene_index: 0, start_ms: 0, end_ms: 30_000, title: "Opening" },
        { scene_index: 1, start_ms: 30_000, end_ms: 70_000, title: "Main <topic>" },
        { scene_index: 2, start_ms: 70_000, end_ms: 120_000, title: "Conclusion" },
      ],
    });

    expect(result.chapters).toEqual([
      { startTime: 0, title: "Introduction" },
      { startTime: 30, title: "Main topic" },
      { startTime: 70, title: "Conclusion" },
    ]);

    const prompt = vi.mocked(generateText).mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("<scene_context timestamps=\"milliseconds\" trust=\"untrusted_evidence\">");
    expect(prompt).toContain("&lt;topic&gt;");
    expect(prompt).toContain("start_ms divided by 1000");
    expect(prompt).toContain("never split a scene");
    expect(vi.mocked(generateText).mock.calls[0][0].system).toContain(
      "Use the scene progression to choose logical chapter groupings",
    );
  });

  it("retains the existing prompt and start times when scene context is empty", async () => {
    vi.mocked(generateText).mockResolvedValue({
      finishReason: "stop",
      output: { chapters: [
        { startTime: 0, title: "Introduction" },
        { startTime: 47.5, title: "Standalone boundary" },
      ] },
      text: JSON.stringify({ chapters: [
        { startTime: 0, title: "Introduction" },
        { startTime: 47.5, title: "Standalone boundary" },
      ] }),
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        reasoningTokens: 0,
        cachedInputTokens: 0,
      },
    } as any);

    const result = await generateChapters("asset-123", { sceneContext: [] });

    expect(result.chapters).toEqual([
      { startTime: 0, title: "Introduction" },
      { startTime: 47.5, title: "Standalone boundary" },
    ]);
    const prompt = vi.mocked(generateText).mock.calls[0][0].messages[0].content;
    expect(prompt).not.toContain("<scene_context");
    expect(prompt).not.toContain("never split a scene");
    expect(vi.mocked(generateText).mock.calls[0][0].system).not.toContain("scene progression");
  });

  it("filters out-of-range starts before aligning scoped chapters", async () => {
    vi.mocked(generateText).mockResolvedValue({
      finishReason: "stop",
      output: { chapters: [
        { startTime: 29.9, title: "Out-of-range title" },
        { startTime: 30, title: "Scoped opening" },
      ] },
      text: JSON.stringify({ chapters: [
        { startTime: 29.9, title: "Out-of-range title" },
        { startTime: 30, title: "Scoped opening" },
      ] }),
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        reasoningTokens: 0,
        cachedInputTokens: 0,
      },
    } as any);

    const result = await generateChapters("asset-123", {
      scope: { startTime: 30, endTime: 120 },
      sceneContext: [
        { scene_index: 0, start_ms: 30_000, end_ms: 70_000, title: "Scoped opening" },
        { scene_index: 1, start_ms: 70_000, end_ms: 120_000, title: "Scoped ending" },
      ],
    });

    expect(result.chapters).toEqual([{ startTime: 30, title: "Scoped opening" }]);
  });

  it("uses the first in-scope scene boundary and preserves its exact title", async () => {
    vi.mocked(generateText).mockResolvedValue({
      finishReason: "stop",
      output: { chapters: [
        { startTime: 35, title: "Scope-start near miss" },
        { startTime: 70, title: "Scene-aligned title" },
      ] },
      text: JSON.stringify({ chapters: [
        { startTime: 35, title: "Scope-start near miss" },
        { startTime: 70, title: "Scene-aligned title" },
      ] }),
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        reasoningTokens: 0,
        cachedInputTokens: 0,
      },
    } as any);

    const result = await generateChapters("asset-123", {
      scope: { startTime: 35, endTime: 120 },
      sceneContext: [
        { scene_index: 0, start_ms: 30_000, end_ms: 70_000, title: "Outside scope" },
        { scene_index: 1, start_ms: 70_000, end_ms: 120_000, title: "Scoped scene" },
      ],
    });

    expect(result.chapters).toEqual([{ startTime: 70, title: "Scene-aligned title" }]);
    const prompt = vi.mocked(generateText).mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("The first chapter must start at 70s, the first scene boundary inside the analyzed range");
    expect(prompt).not.toContain("The first chapter must start at 35s");
  });

  it("reports scene context without in-scope boundaries as a validation error", async () => {
    await expect(generateChapters("asset-123", {
      scope: { startTime: 80, endTime: 120 },
      sceneContext: [
        { scene_index: 0, start_ms: 0, end_ms: 60_000, title: "Outside scope" },
      ],
    })).rejects.toMatchObject({
      publicType: "validation_error",
      publicMessage: "Scene context has no chapter boundaries within the requested scope.",
    });
    expect(generateText).not.toHaveBeenCalled();
  });
});

const promptCases: { name: string; audioOnly?: boolean; options?: ChaptersOptions }[] = [
  { name: "video" },
  { name: "audio", audioOnly: true },
  { name: "scoped video", options: { scope: { startTime: 10, endTime: 100 } } },
  { name: "scene-aware", options: { sceneContext: [
    { scene_index: 0, start_ms: 0, end_ms: 70_000, title: "Opening" },
    { scene_index: 1, start_ms: 70_000, end_ms: 120_000, title: "Closing" },
  ] } },
  { name: "scoped scenes", options: {
    scope: { startTime: 35, endTime: 120 },
    sceneContext: [
      { scene_index: 0, start_ms: 30_000, end_ms: 70_000, title: "Opening" },
      { scene_index: 1, start_ms: 70_000, end_ms: 120_000, title: "Closing" },
    ],
  } },
  { name: "overrides", options: {
    minChaptersPerHour: 5,
    maxChaptersPerHour: 12,
    outputLanguageCode: "fr",
    promptOverrides: {
      task: "Group the content into product topics.",
      titleGuidelines: { tag: "custom_titles", content: "Use short product names." },
    },
  } },
];

describe.each(promptCases)("standalone $name chapter prompt compatibility", ({ name, audioOnly = false, options }) => {
  it("preserves the original system and user prompts", async () => {
    vi.mocked(isAudioOnlyAsset).mockReturnValue(audioOnly);
    vi.mocked(generateText).mockResolvedValue({
      finishReason: "stop",
      output: { chapters: [{ startTime: 70, title: "Closing" }] },
      text: JSON.stringify({ chapters: [{ startTime: 70, title: "Closing" }] }),
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as any);
    await generateChapters("asset-123", options);
    const request = vi.mocked(generateText).mock.calls[0][0];
    const prompt = JSON.stringify({
      system: request.system.replace(SYSTEM_PROMPT_CANARY, "[CANARY]"),
      messages: request.messages,
    });
    expect(createHash("sha256").update(prompt).digest("hex")).toMatchSnapshot(name);
  });
});
