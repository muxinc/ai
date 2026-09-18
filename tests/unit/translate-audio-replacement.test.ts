import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("workflow", () => ({
  sleep: vi.fn(async () => {}),
  getWorkflowMetadata: vi.fn(() => {
    throw new Error("not in a workflow runtime");
  }),
}));

vi.mock("../../src/lib/mux-assets", () => ({
  getAssetDurationSecondsFromAsset: vi.fn(),
  getPlaybackIdForAsset: vi.fn(),
}));

vi.mock("../../src/lib/workflow-credentials", () => ({
  resolveMuxClient: vi.fn(),
  resolveMuxSigningContext: vi.fn(),
  resolveProviderApiKey: vi.fn(),
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

const { getAssetDurationSecondsFromAsset, getPlaybackIdForAsset } = await import("../../src/lib/mux-assets");
const { resolveMuxClient } = await import("../../src/lib/workflow-credentials");
const { getApiKeyFromEnv } = await import("../../src/lib/client-factory");
const { replaceAndCreateTrack } = await import("../../src/lib/mux-tracks");
const { createPresignedGetUrlWithStorageAdapter, putObjectWithStorageAdapter } = await import("../../src/lib/storage-adapter");
const { translateAudio } = await import("../../src/workflows/translate-audio");

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
    if (url.endsWith("/v1/dubbing") && init?.method === "POST") {
      return new Response(JSON.stringify({ dubbing_id: "dub-1" }), { status: 200 });
    }
    if (url.endsWith("/v1/dubbing/dub-1")) {
      return new Response(JSON.stringify({ status: "dubbed", target_languages: ["es"] }), { status: 200 });
    }
    if (url.includes("/audio/")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    if (url.includes("/transcripts/")) {
      return new Response(JSON.stringify({ webvtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHola\n" }), { status: 200 });
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

describe("translateAudio track replacement", () => {
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

    expect(error.message).toContain("Text track(s) already exist");
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
