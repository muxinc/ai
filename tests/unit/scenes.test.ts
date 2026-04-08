import { generateText } from "ai";
import dedent from "dedent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getAssetDurationSecondsFromAsset, getPlaybackIdForAsset, isAudioOnlyAsset } from "../../src/lib/mux-assets";
import { createLanguageModelFromConfig, resolveLanguageModelConfig } from "../../src/lib/providers";
import { resolveMuxSigningContext } from "../../src/lib/workflow-credentials";
import { waitForShotsForAsset } from "../../src/primitives/shots";
import { fetchTranscriptForAsset, getReadyTextTracks } from "../../src/primitives/transcripts";
import {
  buildShotWindowsForScenes,
  generateScenes,
  mergeSceneShotWindows,
  normalizeScenesForAsset,
} from "../../src/workflows/scenes";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  Output: {
    object: vi.fn(({ schema }) => ({ schema })),
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

vi.mock("../../src/primitives/shots", () => ({
  waitForShotsForAsset: vi.fn(),
}));

vi.mock("../../src/primitives/transcripts", async () => {
  const actual = await vi.importActual<typeof import("../../src/primitives/transcripts")>(
    "../../src/primitives/transcripts",
  );

  return {
    ...actual,
    fetchTranscriptForAsset: vi.fn(),
    getReadyTextTracks: vi.fn(),
  };
});

describe("scenes workflow helpers", () => {
  it("builds shot windows from shot anchors and overlapping cues", () => {
    const shotWindows = buildShotWindowsForScenes(
      [{ startTime: 5 }, { startTime: 10 }],
      [
        { startTime: 0, endTime: 2, text: "Intro" },
        { startTime: 4, endTime: 6, text: "Welcome back" },
        { startTime: 6, endTime: 9, text: "Product overview" },
        { startTime: 10, endTime: 14, text: "Hands on demo" },
      ],
      15,
    );

    expect(shotWindows).toEqual([
      {
        startTime: 0,
        endTime: 5,
        transcriptText: "Intro Welcome back",
        cueCount: 2,
        shotCount: 1,
      },
      {
        startTime: 5,
        endTime: 10,
        transcriptText: "Welcome back Product overview",
        cueCount: 2,
        shotCount: 1,
      },
      {
        startTime: 10,
        endTime: 15,
        transcriptText: "Hands on demo",
        cueCount: 1,
        shotCount: 1,
      },
    ]);
  });

  it("merges low-signal adjacent shot windows before prompting", () => {
    const merged = mergeSceneShotWindows([
      {
        startTime: 0,
        endTime: 1,
        transcriptText: "",
        cueCount: 0,
        shotCount: 1,
      },
      {
        startTime: 1,
        endTime: 6,
        transcriptText: "Welcome back",
        cueCount: 1,
        shotCount: 1,
      },
      {
        startTime: 6,
        endTime: 10,
        transcriptText: "Here is the product",
        cueCount: 1,
        shotCount: 1,
      },
    ], 2);

    expect(merged).toEqual([
      {
        startTime: 0,
        endTime: 6,
        transcriptText: "Welcome back",
        cueCount: 1,
        shotCount: 2,
      },
      {
        startTime: 6,
        endTime: 10,
        transcriptText: "Here is the product",
        cueCount: 1,
        shotCount: 1,
      },
    ]);
  });

  it("normalizes model output by snapping to candidates and computing stable end times", () => {
    const normalized = normalizeScenesForAsset({
      scenes: [
        { startTime: 0.2, endTime: 3, title: "Opening" },
        { startTime: 4.9, endTime: 9, title: "Product Intro" },
        { startTime: 5.1, endTime: 9.5, title: "Duplicate Boundary" },
        { startTime: 9.8, endTime: 15, title: "Hands On Demo" },
      ],
      sceneStartCandidates: [0, 5, 10],
      assetDurationSeconds: 15,
    });

    expect(normalized).toEqual([
      { startTime: 0, endTime: 5, title: "Opening" },
      { startTime: 5, endTime: 10, title: "Product Intro" },
      { startTime: 10, endTime: 15, title: "Hands On Demo" },
    ]);
  });
});

describe("generateScenes", () => {
  const mockAsset = {
    tracks: [
      {
        id: "track-123",
        type: "text",
        status: "ready",
        text_type: "subtitles",
        language_code: "en",
      },
    ],
  } as any;

  const rawVtt = dedent`
    WEBVTT

    00:00:00.000 --> 00:00:04.000
    Welcome back everyone.

    00:00:04.000 --> 00:00:09.000
    Today we are unboxing the product.

    00:00:09.000 --> 00:00:13.000
    Now let me show you how it works.
  `;

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(resolveLanguageModelConfig).mockReturnValue({
      provider: "openai",
      modelId: "gpt-5.1",
    } as any);
    vi.mocked(createLanguageModelFromConfig).mockResolvedValue({ id: "mock-model" } as any);
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
      asset: mockAsset,
      playbackId: "playback-123",
      policy: "public",
    } as any);
    vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(13);
    vi.mocked(isAudioOnlyAsset).mockReturnValue(false);
    vi.mocked(resolveMuxSigningContext).mockResolvedValue(undefined);
    vi.mocked(getReadyTextTracks).mockReturnValue(mockAsset.tracks);
    vi.mocked(fetchTranscriptForAsset).mockResolvedValue({
      transcriptText: rawVtt,
      track: mockAsset.tracks[0],
    });
    vi.mocked(waitForShotsForAsset).mockResolvedValue({
      status: "completed",
      createdAt: "1773108428",
      shots: [
        { startTime: 4, imageUrl: "https://example.com/shot-1.webp" },
        { startTime: 9, imageUrl: "https://example.com/shot-2.webp" },
      ],
    });
    vi.mocked(generateText).mockResolvedValue({
      output: {
        scenes: [
          { startTime: 0.3, endTime: 4.1, title: "Warm Welcome" },
          { startTime: 4.2, endTime: 9.2, title: "Unboxing Begins" },
          { startTime: 9.1, endTime: 13, title: "Product Demo" },
        ],
      },
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
      },
    } as any);
  });

  it("builds a prompt from shot windows, honors prompt overrides, and normalizes output", async () => {
    const result = await generateScenes("asset-123", "en", {
      promptOverrides: {
        boundaryGuidelines: "Prefer broader scenes unless the narrative clearly shifts.",
        titleGuidelines: "Use short punchy titles under four words.",
      },
      outputLanguageCode: "es",
    });

    expect(result).toEqual({
      assetId: "asset-123",
      languageCode: "en",
      scenes: [
        { startTime: 0, endTime: 4, title: "Warm Welcome" },
        { startTime: 4, endTime: 9, title: "Unboxing Begins" },
        { startTime: 9, endTime: 13, title: "Product Demo" },
      ],
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        metadata: {
          assetDurationSeconds: 13,
        },
      },
    });

    const generateTextCall = vi.mocked(generateText).mock.calls[0]?.[0];
    expect(generateTextCall).toBeDefined();
    const userMessageContent = generateTextCall!.messages?.[1]?.content;
    expect(userMessageContent).toBeDefined();
    expect(userMessageContent).toContain(
      "Prefer broader scenes unless the narrative clearly shifts.",
    );
    expect(userMessageContent).toContain(
      "Use short punchy titles under four words.",
    );
    expect(userMessageContent).toContain(
      "All output (title, description, keywords, chapter titles) MUST be written in Spanish.",
    );
  });

  it("rejects audio-only assets", async () => {
    vi.mocked(isAudioOnlyAsset).mockReturnValue(true);

    await expect(generateScenes("asset-123", "en")).rejects.toThrow(
      "Scene generation is only supported for video assets",
    );
    expect(generateText).not.toHaveBeenCalled();
  });
});
