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

  it("populates transcriptScores for a video asset and a high transcript score raises maxScores/exceedsThreshold", async () => {
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
      // Text (transcript) moderation: `input` is an array of strings. Return a
      // high sexual score for every window in the batch.
      if (Array.isArray(body.input) && typeof body.input[0] === "string") {
        return mockOpenAIModerationResponse({
          status: 200,
          body: {
            results: body.input.map(() => ({ category_scores: { sexual: 0.95, violence: 0.1 } })),
          },
        });
      }

      // Image moderation: `input` is an array of image_url objects. Benign.
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

    // Both surfaces moderated → combined mode.
    expect(result.mode).toBe("combined");
    expect(result.isAudioOnly).toBe(false);

    // Transcript scores land in their own array as time windows carrying timecodes.
    expect(result.transcriptScores.length).toBe(1);
    expect(result.transcriptScores[0]).toMatchObject({
      startTime: 1,
      endTime: 4,
      error: false,
    });
    expect(typeof result.transcriptScores[0].sexual).toBe("number");
    // No legacy chunk index on the new time-windowed entries.
    expect(result.transcriptScores[0]).not.toHaveProperty("chunkIndex");

    // thumbnailScores holds image entries only (each has a `time`).
    expect(result.thumbnailScores.length).toBe(3);
    expect(result.thumbnailScores.every(s => typeof s.time === "number")).toBe(true);
    expect(result.thumbnailScores.every(s => "url" in s)).toBe(true);

    // The high transcript score drives maxScores and threshold.
    expect(result.maxScores.sexual).toBe(0.95);
    expect(result.exceedsThreshold).toBe(true);

    // Coverage is computed over thumbnails only.
    expect(result.coverage.requestedSampleCount).toBe(3);
    expect(result.coverage.successfulSampleCount).toBe(3);
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
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(videoAssetWithTextTrack());
    // Short asset duration → minimum 20s windows, 5s overlap, 15s stride.
    vi.mocked(getVideoTrackDurationSecondsFromAsset).mockReturnValue(40);
    vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(40);
    vi.mocked(getThumbnailUrls).mockResolvedValue([
      { url: "https://thumb.test/a.png", time: 0 },
    ]);

    // 25 cues at 5s spacing → cues span 0..124s, far longer than one window.
    const { vtt } = buildEvenlySpacedVtt(25, 5);

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
        return mockOpenAIModerationResponse({
          status: 200,
          body: { results: body.input.map(() => ({ category_scores: { sexual: 0.01, violence: 0.02 } })) },
        });
      }
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
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(videoAssetWithTextTrack());
    vi.mocked(getVideoTrackDurationSecondsFromAsset).mockReturnValue(40);
    vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(40);
    vi.mocked(getThumbnailUrls).mockResolvedValue([
      { url: "https://thumb.test/a.png", time: 0 },
    ]);

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
      includeTranscript: true,
    });

    // The small windows fit in a single batched request whose `input` array
    // carries more than one window text.
    expect(transcriptInputSizes.length).toBe(1);
    expect(transcriptInputSizes[0]).toBeGreaterThan(1);
    // One score per window is returned, index-aligned to the batch.
    expect(result.transcriptScores.length).toBe(transcriptInputSizes[0]);
  });

  it("splits a batch and retries when a batched request is rejected with 400", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(videoAssetWithTextTrack());
    vi.mocked(getVideoTrackDurationSecondsFromAsset).mockReturnValue(40);
    vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(40);
    vi.mocked(getThumbnailUrls).mockResolvedValue([
      { url: "https://thumb.test/a.png", time: 0 },
    ]);

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
      includeTranscript: true,
    });

    // The initial 400 triggered a split-and-retry, producing per-window results
    // with no errors.
    expect(transcriptCallCount).toBeGreaterThan(1);
    expect(result.transcriptScores.length).toBeGreaterThanOrEqual(2);
    expect(result.transcriptScores.every(s => s.error === false)).toBe(true);
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

    expect(result.transcriptScores).toEqual([]);
    expect(result.mode).toBe("thumbnails");
    expect(result.coverage.requestedSampleCount).toBe(3);
    expect(result.exceedsThreshold).toBe(false);
  });

  it("places audio-only transcript results in transcriptScores and is not low-confidence", async () => {
    vi.mocked(isAudioOnlyAsset).mockReturnValue(true);
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
      asset: {
        id: "asset-audio",
        tracks: [
          { id: "track-en", type: "text", status: "ready", text_type: "subtitles", language_code: "en" },
        ],
      },
      playbackId: "playback-audio",
      policy: "public",
    } as any);
    // Audio-only assets have no video track / thumbnails.
    vi.mocked(getThumbnailUrls).mockResolvedValue([]);

    mockFetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith(".vtt")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: vi.fn().mockResolvedValue(VTT_BODY),
        } as any;
      }
      const body = JSON.parse(String(init?.body));
      // Should only ever be text (array-batched) moderation for audio-only.
      expect(Array.isArray(body.input)).toBe(true);
      expect(typeof body.input[0]).toBe("string");
      return mockOpenAIModerationResponse({
        status: 200,
        body: {
          results: body.input.map(() => ({ category_scores: { sexual: 0.04, violence: 0.06 } })),
        },
      });
    });

    const result = await getModerationScores("asset-audio", {
      provider: "openai",
      model: "omni-moderation-latest",
    });

    expect(result.mode).toBe("transcript");
    expect(result.isAudioOnly).toBe(true);
    // Transcript scores live in their own array as time windows; thumbnailScores is empty.
    expect(result.thumbnailScores).toEqual([]);
    expect(result.transcriptScores.length).toBe(1);
    expect(result.transcriptScores[0]).toMatchObject({ startTime: 1, endTime: 4, error: false });
    expect(result.transcriptScores[0]).not.toHaveProperty("chunkIndex");
    // Audio-only must not be penalized for having zero thumbnails.
    expect(result.coverage.isLowConfidence).toBe(false);
    expect(result.coverage.requestedSampleCount).toBe(0);
    expect(result.maxScores.violence).toBe(0.06);
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
