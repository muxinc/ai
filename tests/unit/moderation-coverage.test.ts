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

vi.mock("../../src/lib/sampling-plan", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/sampling-plan")>(
    "../../src/lib/sampling-plan",
  );
  return {
    ...actual,
    planSamplingTimestamps: vi.fn(actual.planSamplingTimestamps),
  };
});

const { getApiKeyFromEnv } = await import("../../src/lib/client-factory");
const {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  getVideoTrackDurationSecondsFromAsset,
  getVideoTrackMaxFrameRateFromAsset,
  isAudioOnlyAsset,
} = await import("../../src/lib/mux-assets");
const { planSamplingTimestamps } = await import("../../src/lib/sampling-plan");
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
  it("treats an empty scope like an omitted scope when capped sampling is used", async () => {
    mockFetch.mockResolvedValue(mockOpenAIModerationResponse({
      status: 200,
      body: { results: [{ category_scores: { sexual: 0, violence: 0 } }] },
    }));

    await getModerationScores("asset-123", {
      provider: "openai",
      maxSamples: 4,
    });
    const timesWithOmittedScope = mockFetch.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body));
      return body.input[0].image_url.url;
    });

    mockFetch.mockClear();

    await getModerationScores("asset-123", {
      provider: "openai",
      maxSamples: 4,
      scope: {},
    });
    const timesWithEmptyScope = mockFetch.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body));
      return body.input[0].image_url.url;
    });

    expect(timesWithEmptyScope).toEqual(timesWithOmittedScope);
  });

  it("excludes the scoped end timestamp when capped sampling rounds to a frame", async () => {
    vi.mocked(getVideoTrackMaxFrameRateFromAsset).mockReturnValue(1);
    mockFetch.mockResolvedValue(mockOpenAIModerationResponse({
      status: 200,
      body: { results: [{ category_scores: { sexual: 0, violence: 0 } }] },
    }));

    await getModerationScores("asset-123", {
      provider: "openai",
      maxSamples: 4,
      scope: { startTime: 10, endTime: 14 },
    });

    const thumbnailTimes = mockFetch.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body));
      return Number(new URL(body.input[0].image_url.url).searchParams.get("time"));
    });

    expect(thumbnailTimes).toEqual([10, 11, 12, 13]);
    expect(thumbnailTimes.every(time => time < 14)).toBe(true);
  });

  it("excludes timestamps that round to the exclusive scoped end after toFixed(2)", async () => {
    // 13996ms passes a raw millisecond exclusive-end check for endTime=14, but
    // Number((13996 / 1000).toFixed(2)) === 14 and must still be dropped.
    vi.mocked(planSamplingTimestamps).mockReturnValueOnce([10_000, 12_000, 13_996]);
    mockFetch.mockResolvedValue(mockOpenAIModerationResponse({
      status: 200,
      body: { results: [{ category_scores: { sexual: 0, violence: 0 } }] },
    }));

    await getModerationScores("asset-123", {
      provider: "openai",
      maxSamples: 4,
      scope: { startTime: 10, endTime: 14 },
    });

    const thumbnailTimes = mockFetch.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body));
      return Number(new URL(body.input[0].image_url.url).searchParams.get("time"));
    });

    expect(thumbnailTimes).toEqual([10, 12]);
    expect(thumbnailTimes.every(time => time < 14)).toBe(true);
  });

  it("accepts asset-relative scopes that extend past the video track", async () => {
    vi.mocked(getVideoTrackDurationSecondsFromAsset).mockReturnValue(80);
    vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(100);
    mockFetch.mockResolvedValue(mockOpenAIModerationResponse({
      status: 200,
      body: { results: [{ category_scores: { sexual: 0, violence: 0 } }] },
    }));

    await expect(getModerationScores("asset-123", {
      provider: "openai",
      maxSamples: 4,
      scope: { endTime: 100 },
    })).resolves.toBeDefined();

    const thumbnailTimes = mockFetch.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body));
      return Number(new URL(body.input[0].image_url.url).searchParams.get("time"));
    });

    expect(thumbnailTimes.every(time => time < 80)).toBe(true);
  });

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
