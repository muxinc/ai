import { APICallError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TokenUsage } from "../../src/types";

vi.mock("ai", async importOriginal => ({
  ...(await importOriginal<object>()),
  generateText: vi.fn(),
}));

vi.mock("../../src/lib/mux-assets", () => ({
  getAssetDurationSecondsFromAsset: vi.fn(),
  getPlaybackIdForAsset: vi.fn(),
}));

vi.mock("../../src/lib/mux-tracks", () => ({
  createTextTrackOnMux: vi.fn(),
  fetchVttFromMux: vi.fn(),
}));

vi.mock("../../src/lib/workflow-credentials", () => ({
  resolveMuxSigningContext: vi.fn(),
}));

vi.mock("../../src/lib/providers", async importOriginal => ({
  ...(await importOriginal<object>()),
  createLanguageModelFromConfig: vi.fn(),
  resolveLanguageModelConfig: vi.fn(),
}));

const { generateText } = await import("ai");
const { getAssetDurationSecondsFromAsset, getPlaybackIdForAsset } = await import("../../src/lib/mux-assets");
const { fetchVttFromMux } = await import("../../src/lib/mux-tracks");
const { resolveMuxSigningContext } = await import("../../src/lib/workflow-credentials");
const { createLanguageModelFromConfig, resolveLanguageModelConfig } = await import("../../src/lib/providers");
const { translateCaptions } = await import("../../src/workflows/translate-captions");

// Four 30s cues so duration-based chunking (target 60s) yields two chunks of
// two cues each.
const VTT_CONTENT = [
  "WEBVTT",
  "",
  "1",
  "00:00:00.000 --> 00:00:30.000",
  "Hello one",
  "",
  "2",
  "00:00:30.000 --> 00:01:00.000",
  "Hello two",
  "",
  "3",
  "00:01:00.000 --> 00:01:30.000",
  "Hello three",
  "",
  "4",
  "00:01:30.000 --> 00:02:00.000",
  "Hello four",
  "",
].join("\n");

const CHUNK_USAGE = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

const TRANSLATION_OPTIONS = {
  provider: "openai" as const,
  uploadToS3: false,
  uploadToMux: false,
  chunking: {
    enabled: true,
    minimumAssetDurationSeconds: 1,
    targetChunkDurationSeconds: 60,
    maxConcurrentTranslations: 1,
  },
};

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});

  vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
    asset: {
      id: "asset-123",
      tracks: [
        { id: "track-1", type: "text", status: "ready", language_code: "en", text_type: "subtitles" },
      ],
    },
    playbackId: "playback-123",
    policy: "public",
  } as any);
  vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(120);
  vi.mocked(resolveMuxSigningContext).mockResolvedValue(undefined);
  vi.mocked(fetchVttFromMux).mockResolvedValue(VTT_CONTENT);
  vi.mocked(resolveLanguageModelConfig).mockReturnValue({ provider: "openai", modelId: "gpt-test" } as any);
  vi.mocked(createLanguageModelFromConfig).mockResolvedValue({} as any);
});

describe("translateCaptions error-path token usage", () => {
  it("attaches the usage of completed chunks when a later chunk fails", async () => {
    vi.mocked(generateText).mockImplementation((async (args: any) => {
      const userContent = args.messages.find((m: any) => m.role === "user").content as string;
      if (userContent.includes("Hello three")) {
        // Non-retryable provider error → the chunk fails fast without
        // splitting, after the first chunk already burned tokens.
        throw new APICallError({
          message: "Bad request",
          requestBodyValues: {},
          statusCode: 400,
          url: "https://api.example.test/v1/messages",
        });
      }
      const cueCount = Number(/Return exactly (\d+) translated/.exec(userContent)?.[1] ?? 0);
      const translations = Array.from({ length: cueCount }, (_, i) => `hola ${i}`);
      return {
        output: { translations },
        text: JSON.stringify({ translations }),
        usage: CHUNK_USAGE,
      };
    }) as any);

    const error = await captureRejection(
      translateCaptions("asset-123", "track-1", "es", TRANSLATION_OPTIONS),
    );

    expect((error as Error).message).toContain("Failed to translate VTT");
    // One chunk of two completed before the failure, so exactly one chunk's
    // usage must ride on the error.
    expect((error as { usage?: TokenUsage }).usage).toEqual(CHUNK_USAGE);
  });

  it("attaches no usage when the workflow fails before any provider call", async () => {
    const error = await captureRejection(
      translateCaptions("asset-123", "missing-track", "es", TRANSLATION_OPTIONS),
    );

    expect((error as Error).message).toContain("missing-track");
    expect(Object.hasOwn(error as object, "usage")).toBe(false);
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });
});
