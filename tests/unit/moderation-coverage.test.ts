import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/client-factory", () => ({
  getApiKeyFromEnv: vi.fn(),
}));

vi.mock("../../src/lib/mux-assets", () => ({
  getAssetDurationSecondsFromAsset: vi.fn(),
  getPlaybackIdForAsset: vi.fn(),
  getVideoTrackDurationSecondsFromAsset: vi.fn(),
  getVideoTrackMaxFrameRateFromAsset: vi.fn(),
  isAudioOnlyAsset: vi.fn(),
}));

vi.mock("../../src/lib/workflow-credentials", () => ({
  resolveMuxSigningContext: vi.fn(),
}));

vi.mock("../../src/primitives/thumbnails", () => ({
  getThumbnailUrls: vi.fn(),
}));

const { getApiKeyFromEnv } = await import("../../src/lib/client-factory");
const {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  getVideoTrackDurationSecondsFromAsset,
  getVideoTrackMaxFrameRateFromAsset,
  isAudioOnlyAsset,
} = await import("../../src/lib/mux-assets");
const { resolveMuxSigningContext } = await import("../../src/lib/workflow-credentials");
const { getThumbnailUrls } = await import("../../src/primitives/thumbnails");
const { getModerationScores } = await import("../../src/workflows/moderation");

const mockFetch = vi.fn();

function mockOpenAIModerationResponse({
  status,
  body,
  statusText = status === 200 ? "OK" : "Bad Request",
}: {
  status: number;
  body: unknown;
  statusText?: string;
}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as any;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  vi.mocked(getApiKeyFromEnv).mockResolvedValue("test-openai-key");
  vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
    asset: { id: "asset-123" },
    playbackId: "playback-123",
    policy: "public",
  } as any);
  vi.mocked(getVideoTrackDurationSecondsFromAsset).mockReturnValue(40);
  vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(40);
  vi.mocked(getVideoTrackMaxFrameRateFromAsset).mockReturnValue(30);
  vi.mocked(isAudioOnlyAsset).mockReturnValue(false);
  vi.mocked(resolveMuxSigningContext).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("getModerationScores coverage metadata", () => {
  it("marks thumbnail results as low confidence when too few samples succeed", async () => {
    const urls = [
      { url: "https://thumb.test/1.png", time: 0 },
      { url: "https://thumb.test/2.png", time: 10 },
      { url: "https://thumb.test/3.png", time: 20 },
      { url: "https://thumb.test/4.png", time: 30 },
    ];
    vi.mocked(getThumbnailUrls).mockResolvedValue(urls);

    mockFetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const imageUrl = body.input[0].image_url.url as string;

      if (imageUrl.endsWith("/1.png")) {
        return mockOpenAIModerationResponse({
          status: 200,
          body: { results: [{ category_scores: { sexual: 0.1, violence: 0.9 } }] },
        });
      }

      if (imageUrl.endsWith("/2.png")) {
        return mockOpenAIModerationResponse({
          status: 200,
          body: { results: [{ category_scores: { sexual: 0.05, violence: 0.2 } }] },
        });
      }

      return mockOpenAIModerationResponse({
        status: 400,
        body: { error: { message: "invalid image payload" } },
      });
    });

    const result = await getModerationScores("asset-123", {
      provider: "openai",
      model: "omni-moderation-latest",
    });

    expect(result.coverage).toEqual({
      requestedSampleCount: 4,
      successfulSampleCount: 2,
      failedSampleCount: 2,
      sampleCoverage: 0.5,
      isPartial: true,
      isLowConfidence: true,
    });
    expect(result.exceedsThreshold).toBe(true);
    expect(result.maxScores.violence).toBe(0.9);
  });

  it("keeps confidence normal when enough thumbnail samples succeed", async () => {
    const urls = [
      { url: "https://thumb.test/a.png", time: 0 },
      { url: "https://thumb.test/b.png", time: 10 },
      { url: "https://thumb.test/c.png", time: 20 },
      { url: "https://thumb.test/d.png", time: 30 },
      { url: "https://thumb.test/e.png", time: 40 },
    ];
    vi.mocked(getThumbnailUrls).mockResolvedValue(urls);

    mockFetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const imageUrl = body.input[0].image_url.url as string;

      if (imageUrl.endsWith("/e.png")) {
        return mockOpenAIModerationResponse({
          status: 400,
          body: { error: { message: "invalid image payload" } },
        });
      }

      return mockOpenAIModerationResponse({
        status: 200,
        body: { results: [{ category_scores: { sexual: 0.05, violence: 0.25 } }] },
      });
    });

    const result = await getModerationScores("asset-123", {
      provider: "openai",
      model: "omni-moderation-latest",
    });

    expect(result.coverage).toEqual({
      requestedSampleCount: 5,
      successfulSampleCount: 4,
      failedSampleCount: 1,
      sampleCoverage: 0.8,
      isPartial: true,
      isLowConfidence: false,
    });
    expect(result.exceedsThreshold).toBe(false);
  });
});

describe("getModerationScores includeTranscript (video assets)", () => {
  const VTT_BODY = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nsome flagged transcript line\n";

  function videoAssetWithTextTrack() {
    return {
      asset: {
        id: "asset-123",
        tracks: [
          { id: "track-en", type: "text", status: "ready", text_type: "subtitles", language_code: "en" },
        ],
      },
      playbackId: "playback-123",
      policy: "public",
    } as any;
  }

  it("appends a transcript entry for a video asset and a high transcript score raises maxScores/exceedsThreshold", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(videoAssetWithTextTrack());

    const urls = [
      { url: "https://thumb.test/a.png", time: 0 },
      { url: "https://thumb.test/b.png", time: 10 },
      { url: "https://thumb.test/c.png", time: 20 },
    ];
    vi.mocked(getThumbnailUrls).mockResolvedValue(urls);

    mockFetch.mockImplementation(async (url, init) => {
      // Transcript VTT fetch (GET to the .vtt URL).
      if (String(url).endsWith(".vtt")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: vi.fn().mockResolvedValue(VTT_BODY),
        } as any;
      }

      const body = JSON.parse(String(init?.body));
      // Text moderation: `input` is a string. Return a high sexual score.
      if (typeof body.input === "string") {
        return mockOpenAIModerationResponse({
          status: 200,
          body: { results: [{ category_scores: { sexual: 0.95, violence: 0.1 } }] },
        });
      }

      // Image moderation: `input` is an array. All thumbnails are benign.
      return mockOpenAIModerationResponse({
        status: 200,
        body: { results: [{ category_scores: { sexual: 0.02, violence: 0.03 } }] },
      });
    });

    const result = await getModerationScores("asset-123", {
      provider: "openai",
      model: "omni-moderation-latest",
      includeTranscript: true,
    });

    // Still thumbnail mode for a video asset.
    expect(result.mode).toBe("thumbnails");
    expect(result.isAudioOnly).toBe(false);

    // A transcript-prefixed entry is appended.
    const transcriptEntries = result.thumbnailScores.filter(s => s.url.startsWith("transcript:"));
    expect(transcriptEntries.length).toBeGreaterThan(0);

    // The high transcript score drives maxScores and threshold.
    expect(result.maxScores.sexual).toBe(0.95);
    expect(result.exceedsThreshold).toBe(true);

    // Coverage is computed over thumbnails only (transcript entries excluded).
    expect(result.coverage.requestedSampleCount).toBe(3);
    expect(result.coverage.successfulSampleCount).toBe(3);
  });

  it("skips transcript moderation silently when no ready text track exists", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
      asset: { id: "asset-123", tracks: [] },
      playbackId: "playback-123",
      policy: "public",
    } as any);

    const urls = [
      { url: "https://thumb.test/a.png", time: 0 },
      { url: "https://thumb.test/b.png", time: 10 },
      { url: "https://thumb.test/c.png", time: 20 },
    ];
    vi.mocked(getThumbnailUrls).mockResolvedValue(urls);

    mockFetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith(".vtt")) {
        throw new Error("transcript fetch should not happen when no track exists");
      }
      const body = JSON.parse(String(init?.body));
      expect(Array.isArray(body.input)).toBe(true);
      return mockOpenAIModerationResponse({
        status: 200,
        body: { results: [{ category_scores: { sexual: 0.02, violence: 0.03 } }] },
      });
    });

    const result = await getModerationScores("asset-123", {
      provider: "openai",
      model: "omni-moderation-latest",
      includeTranscript: true,
    });

    expect(result.thumbnailScores.some(s => s.url.startsWith("transcript:"))).toBe(false);
    expect(result.coverage.requestedSampleCount).toBe(3);
    expect(result.exceedsThreshold).toBe(false);
  });

  it("throws when includeTranscript is used with a non-openai provider", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(videoAssetWithTextTrack());

    const urls = [
      { url: "https://thumb.test/a.png", time: 0 },
      { url: "https://thumb.test/b.png", time: 10 },
      { url: "https://thumb.test/c.png", time: 20 },
    ];
    vi.mocked(getThumbnailUrls).mockResolvedValue(urls);

    mockFetch.mockImplementation(async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: vi.fn().mockResolvedValue({
          status: [{ response: { output: [{ classes: [] }] } }],
        }),
        text: vi.fn().mockResolvedValue("{}"),
      }) as any);

    await expect(
      getModerationScores("asset-123", {
        provider: "hive",
        includeTranscript: true,
      }),
    ).rejects.toThrow("includeTranscript is only supported with provider 'openai'.");
  });
});
