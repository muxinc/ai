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
const { MuxAiError } = await import("../../src/lib/mux-ai-error");
const { getModerationScores, buildTranscriptWindows } = await import("../../src/workflows/moderation");

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
    // Transcript moderation is on by default; this asset has no caption track.
    expect(result.transcriptModeration).toMatchObject({
      status: "skipped",
      skipReason: "no_ready_text_track",
    });
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

describe("getModerationScores surfaces (thumbnails + transcript)", () => {
  const VTT_BODY = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nsome flagged transcript line\n";
  const THUMBNAIL_URLS = [
    { url: "https://thumb.test/a.png", time: 0 },
    { url: "https://thumb.test/b.png", time: 10 },
    { url: "https://thumb.test/c.png", time: 20 },
  ];

  function assetWithTextTrack(id = "asset-123") {
    return {
      asset: {
        id,
        tracks: [
          { id: "track-en", type: "text", status: "ready", text_type: "subtitles", language_code: "en" },
        ],
      },
      playbackId: "playback-123",
      policy: "public",
    } as any;
  }

  function assetWithoutTextTrack(id = "asset-123") {
    return {
      asset: { id, tracks: [] },
      playbackId: "playback-123",
      policy: "public",
    } as any;
  }

  /**
   * Route fetch by request shape: the VTT GET returns `vtt` (or throws when
   * `vtt` is undefined, to catch unexpected transcript fetches), text
   * moderation returns `textScores` per window, image moderation returns
   * `imageScores`. Returns per-kind request counters.
   */
  function mockOpenAIFetch({
    vtt,
    vttStatus = 200,
    textScores = { sexual: 0.01, violence: 0.02 },
    imageScores = { sexual: 0.02, violence: 0.03 },
  }: {
    vtt?: string;
    vttStatus?: number;
    textScores?: { sexual: number; violence: number };
    imageScores?: { sexual: number; violence: number };
  }) {
    const counts = { transcript: 0, image: 0 };
    mockFetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith(".vtt")) {
        if (vtt === undefined) {
          throw new Error("transcript fetch should not happen in this scenario");
        }
        return {
          ok: vttStatus >= 200 && vttStatus < 300,
          status: vttStatus,
          statusText: vttStatus === 200 ? "OK" : "Internal Server Error",
          text: vi.fn().mockResolvedValue(vtt),
        } as any;
      }
      const body = JSON.parse(String(init?.body));
      if (Array.isArray(body.input) && typeof body.input[0] === "string") {
        counts.transcript++;
        return mockOpenAIModerationResponse({
          status: 200,
          body: { results: body.input.map(() => ({ category_scores: textScores })) },
        });
      }
      counts.image++;
      return mockOpenAIModerationResponse({
        status: 200,
        body: { results: [{ category_scores: imageScores }] },
      });
    });
    return counts;
  }

  it("moderates both surfaces by default for a video with captions", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithTextTrack());
    vi.mocked(getThumbnailUrls).mockResolvedValue(THUMBNAIL_URLS);
    mockOpenAIFetch({ vtt: VTT_BODY, textScores: { sexual: 0.95, violence: 0.1 } });

    const result = await getModerationScores("asset-123", {
      provider: "openai",
      model: "omni-moderation-latest",
    });

    expect(result.mode).toBe("combined");
    expect(result.isAudioOnly).toBe(false);
    expect(result.thumbnailModeration).toEqual({ status: "completed" });
    expect(result.transcriptModeration).toEqual({ status: "completed" });

    // Transcript scores land in their own array as time windows carrying timecodes.
    expect(result.transcriptScores.length).toBe(1);
    expect(result.transcriptScores[0]).toMatchObject({ startTime: 1, endTime: 4, error: false });
    expect(result.transcriptScores[0]).not.toHaveProperty("chunkIndex");

    // thumbnailScores holds image entries only.
    expect(result.thumbnailScores.length).toBe(3);
    expect(result.thumbnailScores.every(s => typeof s.time === "number" && "url" in s)).toBe(true);

    // The high transcript score drives maxScores and threshold.
    expect(result.maxScores.sexual).toBe(0.95);
    expect(result.exceedsThreshold).toBe(true);

    // Coverage is computed over thumbnails only.
    expect(result.coverage.requestedSampleCount).toBe(3);
    expect(result.coverage.successfulSampleCount).toBe(3);
    expect(result.usage?.metadata?.thumbnailCount).toBe(3);
  });

  it("skips the transcript with no_ready_text_track when the video has no caption track", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithoutTextTrack());
    vi.mocked(getThumbnailUrls).mockResolvedValue(THUMBNAIL_URLS);
    const counts = mockOpenAIFetch({});

    const result = await getModerationScores("asset-123", { provider: "openai" });

    expect(result.mode).toBe("thumbnails");
    expect(result.thumbnailModeration).toEqual({ status: "completed" });
    expect(result.transcriptModeration).toEqual({
      status: "skipped",
      skipReason: "no_ready_text_track",
      skipMessage: "No ready caption/subtitle track found for this asset.",
    });
    expect(result.transcriptScores).toEqual([]);
    expect(counts.transcript).toBe(0);
    expect(result.coverage.requestedSampleCount).toBe(3);
    expect(result.exceedsThreshold).toBe(false);
  });

  it("names the language in the skip message when languageCode matches no track", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithTextTrack());
    vi.mocked(getThumbnailUrls).mockResolvedValue(THUMBNAIL_URLS);
    mockOpenAIFetch({});

    const result = await getModerationScores("asset-123", { provider: "openai", languageCode: "fr" });

    expect(result.transcriptModeration).toEqual({
      status: "skipped",
      skipReason: "no_ready_text_track",
      skipMessage: "No ready caption/subtitle track found for language 'fr'.",
    });
  });

  it("skips the transcript with no_cues when the VTT body is empty (valid but empty)", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithTextTrack());
    vi.mocked(getThumbnailUrls).mockResolvedValue(THUMBNAIL_URLS);
    const counts = mockOpenAIFetch({ vtt: "" });

    const result = await getModerationScores("asset-123", { provider: "openai" });

    expect(result.thumbnailModeration).toEqual({ status: "completed" });
    expect(result.transcriptModeration).toEqual({
      status: "skipped",
      skipReason: "no_cues",
      skipMessage: "Transcript is empty.",
    });
    expect(result.transcriptScores).toEqual([]);
    expect(counts.transcript).toBe(0);
  });

  it("skips the transcript with no_cues when the caption track has no parseable cues", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithTextTrack());
    vi.mocked(getThumbnailUrls).mockResolvedValue(THUMBNAIL_URLS);
    // A VTT header with no cues at all — text is non-empty but parseVTTCues returns [].
    const counts = mockOpenAIFetch({ vtt: "WEBVTT\n\nNOTE this file has no cues\n" });

    const result = await getModerationScores("asset-123", { provider: "openai" });

    expect(result.mode).toBe("thumbnails");
    expect(result.transcriptModeration).toEqual({
      status: "skipped",
      skipReason: "no_cues",
      skipMessage: "Caption track had no parseable cues.",
    });
    expect(counts.transcript).toBe(0);
  });

  it("skips the transcript with no_cues when no cue falls inside the requested scope", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithTextTrack());
    vi.mocked(getThumbnailUrls).mockResolvedValue(THUMBNAIL_URLS);
    // The only cue spans 1–4s; the scope starts at 10s.
    const counts = mockOpenAIFetch({ vtt: VTT_BODY });

    const result = await getModerationScores("asset-123", {
      provider: "openai",
      scope: { startTime: 10, endTime: 30 },
    });

    expect(result.thumbnailModeration).toEqual({ status: "completed" });
    expect(result.transcriptModeration).toEqual({
      status: "skipped",
      skipReason: "no_cues",
      skipMessage: "Transcript has no cues in the requested scope.",
    });
    expect(counts.transcript).toBe(0);
  });

  it("moderates only the transcript when moderateThumbnails is false", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithTextTrack());
    vi.mocked(getThumbnailUrls).mockResolvedValue(THUMBNAIL_URLS);
    const counts = mockOpenAIFetch({ vtt: VTT_BODY });

    const result = await getModerationScores("asset-123", {
      provider: "openai",
      moderateThumbnails: false,
    });

    expect(result.mode).toBe("transcript");
    expect(result.thumbnailModeration).toEqual({ status: "not_requested" });
    expect(result.transcriptModeration).toEqual({ status: "completed" });
    expect(result.thumbnailScores).toEqual([]);
    expect(result.transcriptScores.length).toBe(1);
    expect(counts.image).toBe(0);
    expect(getThumbnailUrls).not.toHaveBeenCalled();
    // No thumbnails were requested, so confidence is driven by the transcript.
    expect(result.coverage.requestedSampleCount).toBe(0);
    expect(result.coverage.isLowConfidence).toBe(false);
    expect(result.usage?.metadata).not.toHaveProperty("thumbnailCount");
  });

  it("moderates only thumbnails when moderateTranscript is false", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithTextTrack());
    vi.mocked(getThumbnailUrls).mockResolvedValue(THUMBNAIL_URLS);
    // `vtt` omitted: any transcript fetch throws.
    const counts = mockOpenAIFetch({});

    const result = await getModerationScores("asset-123", {
      provider: "openai",
      moderateTranscript: false,
    });

    expect(result.mode).toBe("thumbnails");
    expect(result.thumbnailModeration).toEqual({ status: "completed" });
    expect(result.transcriptModeration).toEqual({ status: "not_requested" });
    expect(result.transcriptScores).toEqual([]);
    expect(counts.transcript).toBe(0);
    expect(counts.image).toBe(3);
  });

  it("skips thumbnails with audio_only for an audio-only asset and moderates the transcript", async () => {
    vi.mocked(isAudioOnlyAsset).mockReturnValue(true);
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithTextTrack("asset-audio"));
    const counts = mockOpenAIFetch({ vtt: VTT_BODY, textScores: { sexual: 0.04, violence: 0.06 } });

    const result = await getModerationScores("asset-audio", {
      provider: "openai",
      model: "omni-moderation-latest",
    });

    expect(result.mode).toBe("transcript");
    expect(result.isAudioOnly).toBe(true);
    expect(result.thumbnailModeration).toEqual({
      status: "skipped",
      skipReason: "audio_only",
      skipMessage: "Asset has no video track, so there are no thumbnails to moderate.",
    });
    expect(result.transcriptModeration).toEqual({ status: "completed" });
    expect(result.thumbnailScores).toEqual([]);
    expect(getThumbnailUrls).not.toHaveBeenCalled();
    expect(counts.image).toBe(0);
    expect(result.transcriptScores.length).toBe(1);
    expect(result.transcriptScores[0]).toMatchObject({ startTime: 1, endTime: 4, error: false });
    // Audio-only must not be penalized for having zero thumbnails.
    expect(result.coverage.isLowConfidence).toBe(false);
    expect(result.coverage.requestedSampleCount).toBe(0);
    expect(result.maxScores.violence).toBe(0.06);
    expect(result.exceedsThreshold).toBe(false);
  });

  it("throws a customer-safe error before fetching the asset when both surfaces are disabled", async () => {
    const error = await getModerationScores("asset-123", {
      provider: "openai",
      moderateThumbnails: false,
      moderateTranscript: false,
    }).catch(e => e);

    expect(MuxAiError.is(error)).toBe(true);
    expect(error.publicType).toBe("validation_error");
    expect(error.message).toBe("At least one of moderateThumbnails or moderateTranscript must be true.");
    expect(getPlaybackIdForAsset).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws a customer-safe error when an audio-only asset has moderateTranscript disabled", async () => {
    vi.mocked(isAudioOnlyAsset).mockReturnValue(true);
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithTextTrack("asset-audio"));
    mockOpenAIFetch({});

    const error = await getModerationScores("asset-audio", {
      provider: "openai",
      moderateTranscript: false,
    }).catch(e => e);

    expect(MuxAiError.is(error)).toBe(true);
    expect(error.publicType).toBe("validation_error");
    expect(error.message).toBe(
      "Nothing to moderate. Thumbnails skipped: Asset has no video track, so there are no thumbnails to moderate. " +
      "Transcript not requested (moderateTranscript: false).",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws a customer-safe error when an audio-only asset has no caption track", async () => {
    vi.mocked(isAudioOnlyAsset).mockReturnValue(true);
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithoutTextTrack("asset-audio"));
    mockOpenAIFetch({});

    const error = await getModerationScores("asset-audio", { provider: "openai" }).catch(e => e);

    expect(MuxAiError.is(error)).toBe(true);
    expect(error.publicType).toBe("validation_error");
    expect(error.message).toBe(
      "Nothing to moderate. Thumbnails skipped: Asset has no video track, so there are no thumbnails to moderate. " +
      "Transcript skipped: No ready caption/subtitle track found for this asset.",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails rather than skipping when the caption track exists but the VTT fetch fails", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithTextTrack());
    vi.mocked(getThumbnailUrls).mockResolvedValue(THUMBNAIL_URLS);
    const counts = mockOpenAIFetch({ vtt: "", vttStatus: 500 });

    const error = await getModerationScores("asset-123", { provider: "openai" }).catch(e => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("Failed to fetch transcript");
    // A transient fetch failure is not a customer-safe validation error.
    expect(MuxAiError.is(error)).toBe(false);
    // Surfaces are resolved before any provider call, so nothing was spent.
    expect(counts.image).toBe(0);
    expect(counts.transcript).toBe(0);
  });

  it("skips the transcript with unsupported_provider for an image-only provider and still moderates thumbnails", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithTextTrack());
    vi.mocked(getThumbnailUrls).mockResolvedValue(THUMBNAIL_URLS);

    mockFetch.mockImplementation(async (url) => {
      if (String(url).endsWith(".vtt")) {
        throw new Error("transcript fetch should not happen for an image-only provider");
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: vi.fn().mockResolvedValue({
          status: [{ response: { output: [{ classes: [] }] } }],
        }),
        text: vi.fn().mockResolvedValue("{}"),
      } as any;
    });

    const result = await getModerationScores("asset-123", { provider: "hive" });

    expect(result.mode).toBe("thumbnails");
    expect(result.thumbnailModeration).toEqual({ status: "completed" });
    expect(result.thumbnailScores.length).toBe(3);
    expect(result.transcriptModeration).toEqual({
      status: "skipped",
      skipReason: "unsupported_provider",
      skipMessage: "Provider 'hive' is image-only and cannot moderate transcript text; use provider 'openai'.",
    });
  });

  it("throws a customer-safe error when an audio-only asset is moderated with an image-only provider", async () => {
    vi.mocked(isAudioOnlyAsset).mockReturnValue(true);
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithTextTrack("asset-audio"));

    const error = await getModerationScores("asset-audio", { provider: "google-vision-api" }).catch(e => e);

    expect(MuxAiError.is(error)).toBe(true);
    expect(error.message).toBe(
      "Nothing to moderate. Thumbnails skipped: Asset has no video track, so there are no thumbnails to moderate. " +
      "Transcript skipped: Provider 'google-vision-api' is image-only and cannot moderate transcript text; use provider 'openai'.",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // Builds a VTT whose cues each span [k*step, k*step + step - 1] seconds.
  function buildEvenlySpacedVtt(cueCount: number, step: number): { vtt: string; cueTexts: string[] } {
    const cueTexts: string[] = [];
    let vtt = "WEBVTT\n\n";
    const fmt = (s: number) => {
      const hh = String(Math.floor(s / 3600)).padStart(2, "0");
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      return `${hh}:${mm}:${ss}.000`;
    };
    for (let i = 0; i < cueCount; i++) {
      const start = i * step;
      const end = start + step - 1;
      const text = `cue ${i} content`;
      cueTexts.push(text);
      vtt += `${fmt(start)} --> ${fmt(end)}\n${text}\n\n`;
    }
    return { vtt, cueTexts };
  }

  it("produces multiple overlapping windows whose time ranges overlap by design", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithTextTrack());
    // Short asset duration → minimum 20s windows, 5s overlap, 15s stride.
    vi.mocked(getVideoTrackDurationSecondsFromAsset).mockReturnValue(40);
    vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(40);
    vi.mocked(getThumbnailUrls).mockResolvedValue([{ url: "https://thumb.test/a.png", time: 0 }]);

    // 25 cues at 5s spacing → cues span 0..124s, far longer than one window.
    const { vtt } = buildEvenlySpacedVtt(25, 5);
    mockOpenAIFetch({ vtt });

    const result = await getModerationScores("asset-123", {
      provider: "openai",
      model: "omni-moderation-latest",
    });

    // Multiple windows, each carrying its own timecodes.
    expect(result.transcriptScores.length).toBeGreaterThanOrEqual(2);
    for (const score of result.transcriptScores) {
      expect(typeof score.startTime).toBe("number");
      expect(typeof score.endTime).toBe("number");
      expect(score.endTime).toBeGreaterThanOrEqual(score.startTime);
      expect(score).not.toHaveProperty("chunkIndex");
    }
    // By design consecutive windows OVERLAP: at least one later window starts
    // before the previous window ends.
    const hasOverlap = result.transcriptScores.some(
      (score, i) => i > 0 && score.startTime < result.transcriptScores[i - 1].endTime,
    );
    expect(hasOverlap).toBe(true);
  });

  it("scales window size with asset duration (longer asset → fewer, larger windows)", () => {
    // Same cue density (cues every 5s across ~10 minutes) but different durations.
    const cues = Array.from({ length: 120 }, (_, i) => ({
      startTime: i * 5,
      endTime: i * 5 + 4,
      text: `cue ${i}`,
    }));

    // Short asset → window clamps to the 20s floor (many small windows).
    const shortWindows = buildTranscriptWindows(cues, 60);
    // Long asset → window grows toward the 120s ceil (fewer, larger windows).
    const longWindows = buildTranscriptWindows(cues, 4000);

    expect(shortWindows.length).toBeGreaterThan(longWindows.length);
    const avgSpan = (windows: Array<{ startTime: number; endTime: number }>) =>
      windows.reduce((sum, w) => sum + (w.endTime - w.startTime), 0) / windows.length;
    expect(avgSpan(longWindows)).toBeGreaterThan(avgSpan(shortWindows));
  });

  it("unit: a cue straddling a window boundary appears in two consecutive windows", () => {
    // duration 40 → windowSeconds 20, overlap 5, stride 15. Window 0 = [0,20],
    // window 1 = [15,35]. A cue at [16,18] intersects both.
    const cues = [
      { startTime: 1, endTime: 3, text: "alpha" },
      { startTime: 16, endTime: 18, text: "BOUNDARY" },
      { startTime: 30, endTime: 33, text: "omega" },
    ];
    const windows = buildTranscriptWindows(cues, 40);
    const containing = windows.filter(w => w.text.includes("BOUNDARY"));
    expect(containing.length).toBeGreaterThanOrEqual(2);
  });

  it("batches multiple windows into a single array `input` request", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithTextTrack());
    vi.mocked(getVideoTrackDurationSecondsFromAsset).mockReturnValue(40);
    vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(40);
    vi.mocked(getThumbnailUrls).mockResolvedValue([{ url: "https://thumb.test/a.png", time: 0 }]);

    const { vtt } = buildEvenlySpacedVtt(25, 5);

    const transcriptInputSizes: number[] = [];
    mockFetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith(".vtt")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: vi.fn().mockResolvedValue(vtt),
        } as any;
      }
      const body = JSON.parse(String(init?.body));
      if (Array.isArray(body.input) && typeof body.input[0] === "string") {
        transcriptInputSizes.push(body.input.length);
        return mockOpenAIModerationResponse({
          status: 200,
          body: { results: body.input.map(() => ({ category_scores: { sexual: 0.01, violence: 0.02 } })) },
        });
      }
      return mockOpenAIModerationResponse({
        status: 200,
        body: { results: [{ category_scores: { sexual: 0.0, violence: 0.0 } }] },
      });
    });

    const result = await getModerationScores("asset-123", {
      provider: "openai",
      model: "omni-moderation-latest",
    });

    // The small windows fit in a single batched request whose `input` array
    // carries more than one window text.
    expect(transcriptInputSizes.length).toBe(1);
    expect(transcriptInputSizes[0]).toBeGreaterThan(1);
    // One score per window is returned, index-aligned to the batch.
    expect(result.transcriptScores.length).toBe(transcriptInputSizes[0]);
  });

  it("splits a batch and retries when a batched request is rejected with 400", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(assetWithTextTrack());
    vi.mocked(getVideoTrackDurationSecondsFromAsset).mockReturnValue(40);
    vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(40);
    vi.mocked(getThumbnailUrls).mockResolvedValue([{ url: "https://thumb.test/a.png", time: 0 }]);

    const { vtt } = buildEvenlySpacedVtt(25, 5);

    let transcriptCallCount = 0;
    mockFetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith(".vtt")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: vi.fn().mockResolvedValue(vtt),
        } as any;
      }
      const body = JSON.parse(String(init?.body));
      if (Array.isArray(body.input) && typeof body.input[0] === "string") {
        transcriptCallCount++;
        // Reject the first (full) batch as too large; accept the split halves.
        if (body.input.length > 1 && transcriptCallCount === 1) {
          return mockOpenAIModerationResponse({
            status: 400,
            body: { error: { message: "input too large" } },
          });
        }
        return mockOpenAIModerationResponse({
          status: 200,
          body: { results: body.input.map(() => ({ category_scores: { sexual: 0.5, violence: 0.1 } })) },
        });
      }
      return mockOpenAIModerationResponse({
        status: 200,
        body: { results: [{ category_scores: { sexual: 0.0, violence: 0.0 } }] },
      });
    });

    const result = await getModerationScores("asset-123", {
      provider: "openai",
      model: "omni-moderation-latest",
    });

    // The initial 400 triggered a split-and-retry, producing per-window results
    // with no errors.
    expect(transcriptCallCount).toBeGreaterThan(1);
    expect(result.transcriptScores.length).toBeGreaterThanOrEqual(2);
    expect(result.transcriptScores.every(s => s.error === false)).toBe(true);
  });
});
