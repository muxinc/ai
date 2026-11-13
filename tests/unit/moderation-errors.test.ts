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
  resolveWorkflowCredentials: async () => ({}),
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
const { MuxAiError } = await import("../../src/lib/mux-ai-error");
const { getModerationScores } = await import("../../src/workflows/moderation");

const mockFetch = vi.fn();

const THUMBNAIL_URLS = [
  { url: "https://image.mux.com/playback-123/thumbnail.png?time=0&token=secret", time: 0 },
  { url: "https://image.mux.com/playback-123/thumbnail.png?time=10&token=secret", time: 10 },
];
const VTT_BODY = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nsome transcript line\n";

function asset({ id = "asset-123", withTextTrack = false } = {}) {
  return {
    asset: {
      id,
      tracks: withTextTrack ?
          [{ id: "track-en", type: "text", status: "ready", text_type: "subtitles", language_code: "en" }] :
          [],
    },
    playbackId: "playback-123",
    policy: "public",
  } as any;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers(headers),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  } as any;
}

function vttResponse(body: string) {
  return { ok: true, status: 200, statusText: "OK", headers: new Headers(), text: vi.fn().mockResolvedValue(body) } as any;
}

function hiveScores() {
  return { status: [{ response: { output: [{ classes: [{ class: "general_nsfw", score: 0.1 }] }] } }] };
}

async function moderationError(assetId: string, options: Parameters<typeof getModerationScores>[1]) {
  const error = await getModerationScores(assetId, options).catch((e: unknown) => e);
  expect(MuxAiError.is(error)).toBe(true);
  return error as InstanceType<typeof MuxAiError>;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  vi.mocked(getApiKeyFromEnv).mockResolvedValue("test-key");
  vi.mocked(getPlaybackIdForAsset).mockResolvedValue(asset());
  vi.mocked(getVideoTrackDurationSecondsFromAsset).mockReturnValue(40);
  vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(40);
  vi.mocked(getVideoTrackMaxFrameRateFromAsset).mockReturnValue(30);
  vi.mocked(isAudioOnlyAsset).mockReturnValue(false);
  vi.mocked(resolveMuxSigningContext).mockResolvedValue(undefined);
  vi.mocked(getThumbnailUrls).mockResolvedValue(THUMBNAIL_URLS);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("getModerationScores classified errors: request and setup", () => {
  it("rejects an unknown provider before fetching the asset", async () => {
    const error = await moderationError("asset-123", { provider: "rekognition" as any });

    expect(error.code).toBe("invalid_parameter");
    expect(error.facts).toMatchObject({
      parameter: "provider",
      reason: "not_allowed",
      allowed: ["openai", "hive", "google-vision-api"],
      value: "rekognition",
      inputs: ["provider"],
    });
    expect(getPlaybackIdForAsset).not.toHaveBeenCalled();
  });

  it("opts the asset fetch in to classified errors", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { results: [{ category_scores: { sexual: 0, violence: 0 } }] }));

    await getModerationScores("asset-123", { provider: "openai", includeTranscript: false });

    expect(getPlaybackIdForAsset).toHaveBeenCalledWith("asset-123", undefined, undefined, { classifiedErrors: true });
  });

  it("raises signing_credentials_missing for a signed asset without signing keys", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue({ ...asset(), policy: "signed" });

    const error = await moderationError("asset-123", { provider: "openai" });

    expect(error.code).toBe("signing_credentials_missing");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("raises a classified asset_duration_unavailable for a scope on an asset with no duration", async () => {
    vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(undefined);

    const error = await moderationError("asset-123", { provider: "openai", scope: { startTime: 1 } });

    expect(error.code).toBe("asset_duration_unavailable");
    expect(error.facts).toMatchObject({ assetId: "asset-123" });
  });

  it("raises a Mux Video error, without the signed URL, when a base64 thumbnail download fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: "Not Found", headers: new Headers() } as any);

    const error = await moderationError("asset-123", {
      provider: "hive",
      imageSubmissionMode: "base64",
      imageDownloadOptions: { retries: 0 },
    });

    expect(error).toMatchObject({ dependency: "mux_video" });
    expect(error.facts).toMatchObject({ call: "fetch_thumbnail", status: 404 });
    expect(error.message).not.toContain("token=secret");
  });
});

describe("getModerationScores classified errors: nothing to moderate", () => {
  beforeEach(() => {
    vi.mocked(isAudioOnlyAsset).mockReturnValue(true);
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(asset({ id: "asset-audio", withTextTrack: true }));
  });

  it("raises transcript_empty when an audio-only asset's transcript is empty", async () => {
    mockFetch.mockResolvedValue(vttResponse(""));

    const error = await moderationError("asset-audio", { provider: "openai" });

    expect(error.code).toBe("transcript_empty");
    expect(error.source).toBe("asset");
    expect(error.facts).toMatchObject({ assetId: "asset-audio", trackId: "track-en", reason: "empty_body", transcriptSkipReason: "no_cues" });
  });

  it("raises transcript_empty when an audio-only asset's transcript has no parseable cues", async () => {
    mockFetch.mockResolvedValue(vttResponse("WEBVTT\n\nNOTE no cues here\n"));

    const error = await moderationError("asset-audio", { provider: "openai" });

    expect(error.code).toBe("transcript_empty");
    expect(error.facts).toMatchObject({ reason: "no_parseable_cues" });
  });

  it("raises invalid_scope (no_transcript) when no cue falls in an audio-only asset's scope", async () => {
    mockFetch.mockResolvedValue(vttResponse(VTT_BODY));

    const error = await moderationError("asset-audio", { provider: "openai", scope: { startTime: 10, endTime: 30 } });

    expect(error.code).toBe("invalid_scope");
    expect(error.facts).toMatchObject({ reason: "no_transcript", trackId: "track-en", startTime: 10, endTime: 30, inputs: ["scope"] });
  });

  it("names the requested and available languages when no caption track matches", async () => {
    // Two tracks: an audio-only asset's single track is used whatever its language.
    const { asset: audioAsset, ...playback } = asset({ id: "asset-audio", withTextTrack: true });
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
      ...playback,
      asset: { ...audioAsset, tracks: [...audioAsset.tracks, { id: "track-es", type: "text", status: "ready", text_type: "subtitles", language_code: "es" }] },
    });

    const error = await moderationError("asset-audio", { provider: "openai", languageCode: "fr" });

    expect(error.code).toBe("caption_track_not_found");
    expect(error.facts).toMatchObject({ languageCode: "fr", availableLanguages: ["en", "es"] });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("getModerationScores classified errors: every sample failed", () => {
  it("classifies a rejected OpenAI key as the service's own failure, with OpenAI's error code", async () => {
    mockFetch.mockResolvedValue(jsonResponse(401, { error: { message: "Incorrect API key", type: "invalid_request_error", code: "invalid_api_key" } }, { "x-request-id": "req_1" }));

    const error = await moderationError("asset-123", { provider: "openai", includeTranscript: false });

    expect(error).toMatchObject({ type: "server_error", source: "internal", dependency: "ai_provider", transient: false });
    expect(error.facts).toMatchObject({
      call: "moderate_thumbnails",
      status: 401,
      requestId: "req_1",
      providerCode: "invalid_api_key",
      provider: "openai",
      model: "omni-moderation-latest",
      assetId: "asset-123",
      sampleCount: 2,
    });
    expect(error.message).toContain("thumbnail at 0s");
    expect(error.message).not.toContain("token=secret");
  });

  it("raises model_output_invalid when OpenAI answers with an unusable result", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { results: [] }));

    const error = await moderationError("asset-123", { provider: "openai", includeTranscript: false });

    expect(error.code).toBe("model_output_invalid");
    expect(error.facts).toMatchObject({ call: "moderate_thumbnails", provider: "openai" });
  });

  it("classifies a provider outage as transient", async () => {
    mockFetch.mockResolvedValue(jsonResponse(503, {}));

    const error = await moderationError("asset-123", { provider: "hive" });

    expect(error).toMatchObject({ type: "processing_error", source: "upstream", dependency: "ai_provider", transient: true, retryable: true });
    expect(error.facts).toMatchObject({ call: "moderate_thumbnails", status: 503, provider: "hive" });
    expect(error.facts.model).toBeUndefined();
  });

  it("classifies a provider timeout as a transient timeout_error", async () => {
    mockFetch.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));

    const error = await moderationError("asset-123", { provider: "hive" });

    expect(error).toMatchObject({ type: "timeout_error", source: "upstream", transient: true });
  });

  it("classifies an error the provider answered with as retryable but not transient", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { return_code: 4, message: "media could not be read" }));

    const error = await moderationError("asset-123", { provider: "hive" });

    expect(error).toMatchObject({ type: "processing_error", source: "upstream", dependency: "ai_provider", transient: false, retryable: true });
    expect(error.facts).toMatchObject({ providerCode: "4" });
  });

  it("reports a failure a retry can't fix over a transient one", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(400, {}));

    const error = await moderationError("asset-123", { provider: "hive" });

    expect(error).toMatchObject({ type: "server_error", source: "internal", transient: false });
    expect(error.facts).toMatchObject({ status: 400 });
  });

  it("raises an internal error when a sample failed outside the moderation call", async () => {
    vi.mocked(getApiKeyFromEnv).mockRejectedValue(new Error("GOOGLE_VISION_API_KEY is not set"));

    const error = await moderationError("asset-123", { provider: "google-vision-api" });

    expect(error).toMatchObject({ type: "server_error", source: "internal" });
    expect(error.facts).toMatchObject({ call: "moderate_thumbnails", provider: "google-vision-api" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("names the transcript call when every transcript window fails", async () => {
    vi.mocked(isAudioOnlyAsset).mockReturnValue(true);
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue(asset({ id: "asset-audio", withTextTrack: true }));
    mockFetch.mockImplementation(async url =>
      String(url).endsWith(".vtt") ? vttResponse(VTT_BODY) : jsonResponse(400, { error: { code: "invalid_value" } }));

    const error = await moderationError("asset-audio", { provider: "openai" });

    expect(error).toMatchObject({ type: "server_error", source: "internal", dependency: "ai_provider" });
    expect(error.facts).toMatchObject({ call: "moderate_transcript", status: 400, providerCode: "invalid_value" });
  });

  it("keeps each sample's failure off the returned result", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, hiveScores()));

    const result = await getModerationScores("asset-123", { provider: "hive" });

    expect(result.thumbnailScores).toHaveLength(2);
    expect(result.thumbnailScores[0]).toMatchObject({ error: true });
    for (const score of result.thumbnailScores) {
      expect(score).not.toHaveProperty("failure");
    }
  });
});
