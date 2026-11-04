import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dubbingLanguage, dubbingProject } from "../helpers/elevenlabs-dubbing.ts";

vi.mock("workflow", () => ({
  sleep: vi.fn(async () => {}),
  getWorkflowMetadata: vi.fn(() => {
    throw new Error("not in a workflow runtime");
  }),
}));

vi.mock("../../src/lib/mux-assets", () => ({
  getAssetDurationSecondsFromAsset: vi.fn(),
  getPlaybackIdForAsset: vi.fn(),
  isAudioOnlyAsset: vi.fn(),
  isVideoOnlyAsset: vi.fn(),
}));

vi.mock("../../src/lib/workflow-credentials", () => ({
  resolveMuxClient: vi.fn(),
  resolveMuxSigningContext: vi.fn(),
  resolveProviderApiKey: vi.fn(),
  resolveWorkflowCredentials: async () => ({}),
}));

vi.mock("../../src/lib/client-factory", () => ({
  getApiKeyFromEnv: vi.fn(),
  getMuxClientFromEnv: vi.fn(),
}));

vi.mock("../../src/lib/mux-tracks", async importOriginal => ({
  ...(await importOriginal<object>()),
  replaceAndCreateTrack: vi.fn(),
}));

vi.mock("../../src/lib/storage-adapter", () => ({
  createPresignedGetUrlWithStorageAdapter: vi.fn(),
  putObjectWithStorageAdapter: vi.fn(),
}));

vi.mock("../../src/env", () => ({
  default: {
    S3_ENDPOINT: "https://s3.example.test",
    S3_REGION: "auto",
    S3_BUCKET: "bucket",
    S3_ACCESS_KEY_ID: "key",
    S3_SECRET_ACCESS_KEY: "secret",
  },
}));

const { getAssetDurationSecondsFromAsset, getPlaybackIdForAsset, isAudioOnlyAsset, isVideoOnlyAsset } = await import("../../src/lib/mux-assets");
const { resolveMuxClient } = await import("../../src/lib/workflow-credentials");
const { getApiKeyFromEnv } = await import("../../src/lib/client-factory");
const { replaceAndCreateTrack } = await import("../../src/lib/mux-tracks");
const { createPresignedGetUrlWithStorageAdapter, putObjectWithStorageAdapter } = await import("../../src/lib/storage-adapter");
const { translateAudio } = await import("../../src/workflows/translate-audio");
const { MuxAiError } = await import("../../src/lib/mux-ai-error");

const ASSET_ID = "asset-123";
const PRIMARY_AUDIO = { id: "primary", type: "audio", language_code: "en", name: "English", primary: true };
const OLD_DUB = { id: "old-dub", type: "audio", language_code: "es", name: "Spanish (Auto-dubbed)" };
const OLD_DUB_CAPTIONS = { id: "old-dub-text", type: "text", text_type: "subtitles", status: "ready", language_code: "es", name: "Spanish (Auto-dubbed)", text_source: "uploaded" };

function assetWith(tracks: unknown[]) {
  return {
    id: ASSET_ID,
    duration: 60,
    playback_ids: [{ id: "playback-123", policy: "public" }],
    static_renditions: { status: "ready", files: [{ id: "r1", name: "audio.m4a", status: "ready" }] },
    tracks,
  };
}

function mockAsset(tracks: unknown[]) {
  const asset = assetWith(tracks);
  vi.mocked(resolveMuxClient).mockResolvedValue({
    createClient: async () => ({ video: { assets: { retrieve: vi.fn(async () => asset) } } }),
    getSigningKey: () => undefined,
    getPrivateKey: () => undefined,
  } as any);
  vi.mocked(getPlaybackIdForAsset).mockResolvedValue({ asset, playbackId: "playback-123", policy: "public" } as any);
}

function stubElevenLabsFetch() {
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/v1/dubbing/project") && init?.method === "POST") {
      return new Response(JSON.stringify(dubbingProject()), { status: 200 });
    }
    if (url.endsWith("/v1/dubbing/project/proj_1")) {
      return new Response(JSON.stringify(dubbingProject()));
    }
    if (url.endsWith("/v1/dubbing/project/proj_1/language/lang_1")) {
      return new Response(JSON.stringify(dubbingLanguage()), { status: 200 });
    }
    if (url.includes("/audio/")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/flac" } });
    }
    if (url.includes("/transcripts/")) {
      return new Response("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHola\n", { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected promise to reject");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(60);
  vi.mocked(getApiKeyFromEnv).mockResolvedValue("elevenlabs-key");
  vi.mocked(putObjectWithStorageAdapter).mockResolvedValue(undefined);
  vi.mocked(createPresignedGetUrlWithStorageAdapter).mockResolvedValue("https://s3.example.test/presigned");
  mockAsset([PRIMARY_AUDIO]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const CLIP_MESSAGE = "Asset asset-123 is a clip, and Mux does not support adding audio tracks to clipped assets. Dub the source asset instead, or skip uploading to Mux and use the dubbed audio file directly.";
const LIVE_MESSAGE = "Asset asset-123 comes from a live stream, and Mux does not support adding audio tracks to live stream assets. Instead, skip uploading to Mux and use the dubbed audio file directly.";
const AUDIO_ONLY_MESSAGE = "Asset asset-123 is audio-only, and Mux does not support adding audio tracks to audio-only assets. Instead, skip uploading to Mux and use the dubbed audio file directly.";

describe("translateAudio on assets Mux can't add an audio track to", () => {
  function mockAssetFields(fields: object) {
    const asset = { ...assetWith([PRIMARY_AUDIO]), ...fields };
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue({ asset, playbackId: "playback-123", policy: "public" } as any);
  }

  it.each([
    { name: "clip (ingest_type)", fields: { ingest_type: "on_demand_clip" }, message: CLIP_MESSAGE },
    { name: "clip (source_asset_id)", fields: { source_asset_id: "source-asset-1" }, message: CLIP_MESSAGE },
    { name: "live stream (is_live)", fields: { is_live: true }, message: LIVE_MESSAGE },
    { name: "live stream recording (live_stream_id)", fields: { live_stream_id: "live-1" }, message: LIVE_MESSAGE },
  ])("rejects before dubbing: $name", async ({ fields, message }) => {
    mockAssetFields(fields);
    const fetchMock = stubElevenLabsFetch();

    const error = await captureRejection(translateAudio(ASSET_ID, "es"));

    expect(MuxAiError.is(error)).toBe(true);
    expect((error as InstanceType<typeof MuxAiError>).type).toBe("validation_error");
    expect(error.message).toBe(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects before dubbing: audio-only", async () => {
    vi.mocked(isAudioOnlyAsset).mockReturnValue(true);
    const fetchMock = stubElevenLabsFetch();

    const error = await captureRejection(translateAudio(ASSET_ID, "es"));

    expect(MuxAiError.is(error)).toBe(true);
    expect((error as InstanceType<typeof MuxAiError>).type).toBe("validation_error");
    expect(error.message).toBe(AUDIO_ONLY_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still dubs when the audio track will not be uploaded to Mux", async () => {
    mockAssetFields({ ingest_type: "on_demand_clip", live_stream_id: "live-1" });
    vi.mocked(isAudioOnlyAsset).mockReturnValue(true);
    stubElevenLabsFetch();

    const result = await translateAudio(ASSET_ID, "es", { uploadToMux: false });

    expect(result.dubbingId).toBe("proj_1");
    expect(vi.mocked(replaceAndCreateTrack)).not.toHaveBeenCalled();
  });
});

describe("translateAudio on a video-only asset", () => {
  it.each([true, false])("rejects before requesting a rendition or dubbing (uploadToMux: %s)", async (uploadToMux) => {
    vi.mocked(isVideoOnlyAsset).mockReturnValue(true);
    const fetchMock = stubElevenLabsFetch();

    const error = await captureRejection(translateAudio(ASSET_ID, "es", { uploadToMux }));

    expect(MuxAiError.is(error)).toBe(true);
    expect((error as InstanceType<typeof MuxAiError>).type).toBe("validation_error");
    expect(error.message).toBe("Asset asset-123 has no audio track, so there is no audio to dub.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("translateAudio track replacement", () => {
  it("preserves the requested region on the Mux track while sending only the base language to ElevenLabs", async () => {
    const fetchMock = stubElevenLabsFetch();
    vi.mocked(replaceAndCreateTrack).mockResolvedValue({ kind: "created", trackId: "regional-dub", deleted: [] });
    const result = await translateAudio(ASSET_ID, "pt-BR");
    const create = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect((create[1].body as FormData).get("target_language")).toBe("pt");
    expect(replaceAndCreateTrack).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ type: "audio", languageCode: "pt-br" }),
    }));
    expect(result).toMatchObject({ targetLanguageCode: "pt-br", uploadedTrackId: "regional-dub" });
  });

  it("rejects before dubbing when a same-language audio track exists and the policy is fail", async () => {
    mockAsset([PRIMARY_AUDIO, OLD_DUB]);
    const fetchMock = stubElevenLabsFetch();

    const error = await captureRejection(translateAudio(ASSET_ID, "es"));

    expect(error.message).toContain("Spanish (Auto-dubbed)");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.mocked(replaceAndCreateTrack)).not.toHaveBeenCalled();
  });

  it("also pre-checks the captions track when uploadCaptionsToMux is set", async () => {
    mockAsset([PRIMARY_AUDIO, OLD_DUB_CAPTIONS]);
    const fetchMock = stubElevenLabsFetch();

    const error = await captureRejection(translateAudio(ASSET_ID, "es", { uploadCaptionsToMux: true }));

    expect(error.message).toContain("A text track already exists");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to replace the primary audio track", async () => {
    stubElevenLabsFetch();

    const error = await captureRejection(translateAudio(ASSET_ID, "en", { replaceExistingTracks: "replace_all" }));

    expect(error.message).toContain("primary audio");
  });

  it("creates the dubbed audio track through the replacement step and reports deletions", async () => {
    mockAsset([PRIMARY_AUDIO, OLD_DUB, OLD_DUB_CAPTIONS]);
    stubElevenLabsFetch();
    vi.mocked(replaceAndCreateTrack)
      .mockResolvedValueOnce({ kind: "created", trackId: "new-dub", deleted: [{ id: "old-dub", type: "audio", name: "Spanish (Auto-dubbed)" }] })
      .mockResolvedValueOnce({ kind: "created", trackId: "new-dub-text", deleted: [{ id: "old-dub-text", type: "text", name: "Spanish (Auto-dubbed)" }] });

    const result = await translateAudio(ASSET_ID, "es", { replaceExistingTracks: "replace_all", uploadCaptionsToMux: true });

    expect(vi.mocked(replaceAndCreateTrack)).toHaveBeenNthCalledWith(1, expect.objectContaining({
      assetId: ASSET_ID,
      target: { type: "audio", languageCode: "es", name: "Spanish (Auto-dubbed)" },
      policy: "replace_all",
      presignedUrl: "https://s3.example.test/presigned",
      passthrough: JSON.stringify({ mux_ai: { workflow: "translate-audio" } }),
    }));
    expect(vi.mocked(replaceAndCreateTrack)).toHaveBeenNthCalledWith(2, expect.objectContaining({
      target: { type: "text", languageCode: "es", name: "Spanish (Auto-dubbed)" },
    }));
    expect(result.uploadedTrackId).toBe("new-dub");
    expect(result.captionsTrackId).toBe("new-dub-text");
    expect(result.replacedTracks?.map(t => t.id)).toEqual(["old-dub", "old-dub-text"]);
  });

  it("honours trackName and trackPassthrough for both tracks", async () => {
    stubElevenLabsFetch();
    vi.mocked(replaceAndCreateTrack).mockResolvedValue({ kind: "created", trackId: "t", deleted: [] });

    await translateAudio(ASSET_ID, "es", { trackName: "Doblaje", trackPassthrough: "{\"robots\":{}}", uploadCaptionsToMux: true });

    for (const call of vi.mocked(replaceAndCreateTrack).mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({ passthrough: "{\"robots\":{}}" }));
      expect(call[0].target.name).toBe("Doblaje");
    }
  });

  it("fails the workflow when the audio track cannot be created, keeping the staged URL in the message", async () => {
    stubElevenLabsFetch();
    vi.mocked(replaceAndCreateTrack).mockResolvedValueOnce({ kind: "create_failed", reason: "url unreachable", deleted: [] });

    const error = await captureRejection(translateAudio(ASSET_ID, "es"));

    expect(error.message).toContain("url unreachable");
    expect(error.message).toContain("https://s3.example.test/presigned");
  });

  it("keeps the staged URL when the replacement step itself throws", async () => {
    stubElevenLabsFetch();
    vi.mocked(replaceAndCreateTrack).mockRejectedValueOnce(Object.assign(new Error("forbidden"), { status: 403 }));

    const error = await captureRejection(translateAudio(ASSET_ID, "es"));

    expect(error.message).toContain("forbidden");
    expect(error.message).toContain("https://s3.example.test/presigned");
  });

  it("soft-fails the captions track so a paid dub still completes", async () => {
    stubElevenLabsFetch();
    vi.mocked(replaceAndCreateTrack)
      .mockResolvedValueOnce({ kind: "created", trackId: "new-dub", deleted: [] })
      .mockResolvedValueOnce({ kind: "create_failed", reason: "captions exploded", deleted: [] });

    const result = await translateAudio(ASSET_ID, "es", { uploadCaptionsToMux: true });

    expect(result.uploadedTrackId).toBe("new-dub");
    expect(result.captionsTrackId).toBeUndefined();
    expect(result.captionsPresignedUrl).toBe("https://s3.example.test/presigned");
  });
});

describe("project output storage", () => {
  it("stores native lossless audio and raw WebVTT without sending provider credentials to signed URLs", async () => {
    const fetchMock = stubElevenLabsFetch();
    await translateAudio(ASSET_ID, "es", { uploadToMux: false, uploadToS3: true });
    expect(putObjectWithStorageAdapter).toHaveBeenCalledWith(expect.objectContaining({
      key: expect.stringMatching(/\.flac$/),
      contentType: "audio/flac",
      body: new Uint8Array([1, 2, 3]),
    }), undefined);
    expect(putObjectWithStorageAdapter).toHaveBeenCalledWith(expect.objectContaining({
      key: expect.stringMatching(/\.vtt$/),
      contentType: "text/vtt",
      body: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHola\n",
    }), undefined);
    for (const [input, init] of fetchMock.mock.calls.filter(([input]) => String(input).startsWith("https://storage.example.test"))) {
      expect(init).toBeUndefined();
      expect(String(input)).toMatch(/output\.(flac|vtt)$/);
    }
  });

  it("refreshes an expired output URL without creating another paid project", async () => {
    const fetchMock = stubElevenLabsFetch();
    const original = fetchMock.getMockImplementation()!;
    const expiredUrl = "https://storage.example.test/audio/output.flac";
    const refreshedUrl = "https://storage.example.test/audio/refreshed.flac";
    let expired = false;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === expiredUrl) {
        expired = true;
        return new Response("expired", { status: 403 });
      }
      if (expired && String(input).endsWith("/v1/dubbing/project/proj_1/language/lang_1")) {
        return new Response(JSON.stringify(dubbingLanguage({ outputs: { lossless_audio: refreshedUrl, subtitles: "https://storage.example.test/transcripts/output.vtt" } })));
      }
      return original(input, init);
    });
    await translateAudio(ASSET_ID, "es", { uploadToMux: false, uploadToS3: true });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/audio/")).map(([input]) => String(input))).toEqual([expiredUrl, refreshedUrl]);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  function stubAudioDownload(respond: () => Response) {
    const fetchMock = stubElevenLabsFetch();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => String(input).includes("/audio/") ? respond() : original(input, init));
    return fetchMock;
  }

  const audioDownloads = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.filter(([input]) => String(input).includes("/audio/"));

  it("retries a transient download failure and fails as retryable when it persists", async () => {
    const fetchMock = stubAudioDownload(() => new Response("upstream error", { status: 502, statusText: "Bad Gateway" }));

    const error = await captureRejection(translateAudio(ASSET_ID, "es", { uploadToMux: false, uploadToS3: true }));

    expect(MuxAiError.is(error)).toBe(true);
    expect(error).toMatchObject({
      type: "processing_error",
      message: "Could not download the dubbed audio. The dubbing service is temporarily unavailable. Please try again.",
      retryable: true,
    });
    expect(audioDownloads(fetchMock)).toHaveLength(3);
    // Downloading never creates another paid project.
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("recovers when a retried download succeeds", async () => {
    let attempts = 0;
    const fetchMock = stubAudioDownload(() => ++attempts === 1 ?
        new Response("upstream error", { status: 503, statusText: "Service Unavailable" }) :
        new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/flac" } }));

    const result = await translateAudio(ASSET_ID, "es", { uploadToMux: false, uploadToS3: true });

    expect(result.presignedUrl).toBe("https://s3.example.test/presigned");
    expect(audioDownloads(fetchMock)).toHaveLength(2);
  });

  it("does not retry a download that cannot succeed", async () => {
    const fetchMock = stubAudioDownload(() => new Response("missing", { status: 404, statusText: "Not Found" }));

    const error = await captureRejection(translateAudio(ASSET_ID, "es", { uploadToMux: false, uploadToS3: true }));

    expect(error).toMatchObject({ type: "processing_error", message: "Could not download the dubbed audio.", retryable: false });
    expect(audioDownloads(fetchMock)).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("404 Not Found: missing"));
  });
});
