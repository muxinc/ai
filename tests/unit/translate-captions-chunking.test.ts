import { beforeEach, describe, expect, it, vi } from "vitest";

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

const CUE_COUNT = 5;

function buildVtt(cueCount: number): string {
  const blocks = Array.from({ length: cueCount }, (_, i) => {
    const start = `00:00:${String(i * 2).padStart(2, "0")}.000`;
    const end = `00:00:${String(i * 2 + 2).padStart(2, "0")}.000`;
    return `${i + 1}\n${start} --> ${end}\nHello ${i + 1}`;
  });
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function requestedCueCount(args: any): number {
  const userContent = args.messages.find((m: any) => m.role === "user").content as string;
  return Number(/Return exactly (\d+) translated/.exec(userContent)?.[1] ?? 0);
}

function successfulTranslation(cueCount: number) {
  const translations = Array.from({ length: cueCount }, (_, i) => `hola ${i}`);
  return {
    finishReason: "stop",
    output: { translations },
    text: JSON.stringify({ translations }),
    usage: USAGE,
  };
}

const SHORT_ASSET_OPTIONS = {
  provider: "openai" as const,
  uploadToS3: false,
  uploadToMux: false,
};

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
  // Well under the default 30 minute duration-chunking threshold.
  vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(CUE_COUNT * 2);
  vi.mocked(resolveMuxSigningContext).mockResolvedValue(undefined);
  vi.mocked(fetchVttFromMux).mockResolvedValue(buildVtt(CUE_COUNT));
  vi.mocked(resolveLanguageModelConfig).mockReturnValue({ provider: "openai", modelId: "gpt-test" } as any);
  vi.mocked(createLanguageModelFromConfig).mockResolvedValue({} as any);
});

describe("translateCaptions chunking for short assets", () => {
  it("splits a short asset by the cue budget instead of sending one request", async () => {
    vi.mocked(generateText).mockImplementation((async (args: any) =>
      successfulTranslation(requestedCueCount(args))) as any);

    const result = await translateCaptions("asset-123", "track-1", "es", {
      ...SHORT_ASSET_OPTIONS,
      chunking: { maxCuesPerChunk: 2 },
    });

    const requestedCounts = vi.mocked(generateText).mock.calls.map(([args]) => requestedCueCount(args));
    expect(requestedCounts).toEqual([2, 2, 1]);
    expect(result.translatedVtt.match(/hola/g)).toHaveLength(CUE_COUNT);
    expect(result.translatedVtt.startsWith("WEBVTT")).toBe(true);
  });

  it("keeps a single request when chunking is disabled", async () => {
    vi.mocked(generateText).mockImplementation((async (args: any) =>
      successfulTranslation(requestedCueCount(args))) as any);

    await translateCaptions("asset-123", "track-1", "es", {
      ...SHORT_ASSET_OPTIONS,
      chunking: { enabled: false, maxCuesPerChunk: 2 },
    });

    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
    expect(requestedCueCount(vi.mocked(generateText).mock.calls[0][0])).toBe(CUE_COUNT);
  });

  it("bisects a chunk whose generation hit the model's output limit", async () => {
    vi.mocked(generateText).mockImplementation((async (args: any) => {
      const cueCount = requestedCueCount(args);
      if (cueCount > 2) {
        return {
          finishReason: "length",
          rawFinishReason: "MAX_TOKENS",
          text: "{\"translations\": [\"tocar rápido\", \"tocar rápido\", ",
          usage: { inputTokens: 100, outputTokens: 65521, totalTokens: 65621 },
          get output(): never {
            throw new Error("output must not be read for a non-stop finish");
          },
        };
      }
      return successfulTranslation(cueCount);
    }) as any);

    const result = await translateCaptions("asset-123", "track-1", "es", SHORT_ASSET_OPTIONS);

    const requestedCounts = vi.mocked(generateText).mock.calls.map(([args]) => requestedCueCount(args));
    expect(requestedCounts).toEqual([5, 2, 3, 1, 2]);
    expect(result.translatedVtt.match(/hola/g)).toHaveLength(CUE_COUNT);
    // Two truncated attempts (5 cues, then 3 cues) plus three successful calls.
    expect(result.usage?.outputTokens).toBe(2 * 65521 + 3 * 5);
  });

  it("surfaces the finish reason when a single cue still cannot be translated", async () => {
    vi.mocked(generateText).mockResolvedValue({
      finishReason: "length",
      rawFinishReason: "MAX_TOKENS",
      text: "",
      usage: USAGE,
      get output(): never {
        throw new Error("output must not be read for a non-stop finish");
      },
    } as any);

    await expect(translateCaptions("asset-123", "track-1", "es", SHORT_ASSET_OPTIONS)).rejects.toMatchObject({
      publicType: "processing_error",
      publicMessage: "The model reached its output limit before producing a complete response (finish reason: MAX_TOKENS).",
      retryable: false,
      finishReason: "length",
    });
  });
});
