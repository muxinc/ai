import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async importOriginal => ({
  ...(await importOriginal<object>()),
  generateText: vi.fn(),
}));

vi.mock("../../src/lib/mux-assets", () => ({
  getAssetDurationSecondsFromAsset: vi.fn(),
  getPlaybackIdForAsset: vi.fn(),
}));

vi.mock("../../src/lib/mux-tracks", async importOriginal => ({
  ...(await importOriginal<object>()),
  createTextTrackOnMux: vi.fn(),
  fetchVttFromMux: vi.fn(),
  replaceAndCreateTextTrack: vi.fn(),
}));

vi.mock("../../src/lib/storage-adapter", () => ({
  createPresignedGetUrlWithStorageAdapter: vi.fn(),
  putObjectWithStorageAdapter: vi.fn(),
}));

vi.mock("../../src/lib/workflow-credentials", () => ({
  resolveMuxClient: vi.fn(),
  resolveMuxSigningContext: vi.fn(),
}));

vi.mock("../../src/lib/providers", async importOriginal => ({
  ...(await importOriginal<object>()),
  createLanguageModelFromConfig: vi.fn(),
  resolveLanguageModelConfig: vi.fn(),
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

const { generateText } = await import("ai");
const { getAssetDurationSecondsFromAsset, getPlaybackIdForAsset } = await import("../../src/lib/mux-assets");
const { createTextTrackOnMux, fetchVttFromMux, replaceAndCreateTextTrack } = await import("../../src/lib/mux-tracks");
const { createPresignedGetUrlWithStorageAdapter, putObjectWithStorageAdapter } = await import("../../src/lib/storage-adapter");
const { resolveMuxClient, resolveMuxSigningContext } = await import("../../src/lib/workflow-credentials");
const { createLanguageModelFromConfig, resolveLanguageModelConfig } = await import("../../src/lib/providers");
const { translateCaptions } = await import("../../src/workflows/translate-captions");
const { editCaptions } = await import("../../src/workflows/edit-captions");

const VTT = [
  "WEBVTT",
  "",
  "00:00:00.000 --> 00:00:02.000",
  "Hello there",
  "",
].join("\n");

const SOURCE_TRACK = { id: "track-en", type: "text", text_type: "subtitles", status: "ready", language_code: "en", name: "English", text_source: "uploaded", closed_captions: true, passthrough: "customer-tag" };
const ASR_ES_TRACK = { id: "track-es-asr", type: "text", text_type: "subtitles", status: "ready", language_code: "es", name: "Spanish CC", text_source: "generated_vod" };

function mockAsset(tracks: unknown[]) {
  vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
    asset: { id: "asset-1", tracks },
    playbackId: "pb-1",
    policy: "public",
  } as any);
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
  mockAsset([SOURCE_TRACK]);
  vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(10);
  vi.mocked(resolveMuxSigningContext).mockResolvedValue(undefined);
  vi.mocked(fetchVttFromMux).mockResolvedValue(VTT);
  vi.mocked(putObjectWithStorageAdapter).mockResolvedValue(undefined);
  vi.mocked(createPresignedGetUrlWithStorageAdapter).mockResolvedValue("https://s3.example.test/presigned.vtt");
  vi.mocked(resolveLanguageModelConfig).mockReturnValue({ provider: "openai", modelId: "gpt-test" } as any);
  vi.mocked(createLanguageModelFromConfig).mockResolvedValue({} as any);
  vi.mocked(generateText).mockResolvedValue({
    finishReason: "stop",
    output: { translations: ["Hola"] },
    text: JSON.stringify({ translations: ["Hola"] }),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  } as any);
});

describe("translateCaptions text track replacement", () => {
  const OPTIONS = { provider: "openai" as const };

  it("rejects before translating when a target-language track exists and the policy is fail", async () => {
    mockAsset([SOURCE_TRACK, ASR_ES_TRACK]);

    const error = await captureRejection(translateCaptions("asset-1", "track-en", "es", OPTIONS));

    expect(error.message).toContain("Spanish CC");
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
    expect(vi.mocked(replaceAndCreateTextTrack)).not.toHaveBeenCalled();
  });

  it("names the track after the language, tags it, and reports replaced tracks", async () => {
    mockAsset([SOURCE_TRACK, ASR_ES_TRACK]);
    vi.mocked(replaceAndCreateTextTrack).mockResolvedValue({
      kind: "created",
      trackId: "track-es-new",
      deleted: [{ id: "track-es-asr", name: "Spanish CC", languageCode: "es", textSource: "generated_vod" }],
    });

    const result = await translateCaptions("asset-1", "track-en", "es", { ...OPTIONS, replaceExistingTracks: "replace_generated" });

    expect(vi.mocked(replaceAndCreateTextTrack)).toHaveBeenCalledWith(expect.objectContaining({
      assetId: "asset-1",
      target: { languageCode: "es", name: "Spanish (Auto-translated)" },
      policy: "replace_generated",
      presignedUrl: "https://s3.example.test/presigned.vtt",
      passthrough: JSON.stringify({ mux_ai: { workflow: "translate-captions" } }),
    }));
    expect(result.uploadedTrackId).toBe("track-es-new");
    expect(result.replacedTracks?.map(t => t.id)).toEqual(["track-es-asr"]);
  });

  it("honours trackName and trackPassthrough", async () => {
    vi.mocked(replaceAndCreateTextTrack).mockResolvedValue({ kind: "created", trackId: "t", deleted: [] });

    await translateCaptions("asset-1", "track-en", "es", { ...OPTIONS, trackName: "Español", trackPassthrough: "{\"robots\":{}}" });

    expect(vi.mocked(replaceAndCreateTextTrack)).toHaveBeenCalledWith(expect.objectContaining({
      target: { languageCode: "es", name: "Español" },
      passthrough: "{\"robots\":{}}",
    }));
  });

  it("fails the workflow instead of swallowing a blocked or failed create", async () => {
    vi.mocked(replaceAndCreateTextTrack).mockResolvedValueOnce({ kind: "blocked", reason: "late conflict", tracks: [] });
    const blocked = await captureRejection(translateCaptions("asset-1", "track-en", "es", OPTIONS));
    expect(blocked.message).toContain("late conflict");

    vi.mocked(replaceAndCreateTextTrack).mockResolvedValueOnce({ kind: "create_failed", reason: "boom", deleted: [] });
    const failed = await captureRejection(translateCaptions("asset-1", "track-en", "es", OPTIONS));
    expect(failed.message).toContain("boom");
  });

  it("rejects an over-long trackPassthrough before doing any work", async () => {
    const error = await captureRejection(translateCaptions("asset-1", "track-en", "es", { ...OPTIONS, trackPassthrough: "x".repeat(256) }));
    expect(error.message).toContain("255");
    expect(vi.mocked(getPlaybackIdForAsset)).not.toHaveBeenCalled();
  });
});

describe("editCaptions text track replacement", () => {
  const OPTIONS = { replacements: [{ find: "Hello", replace: "Hi" }] };

  it("replaces the source track in place by default, carrying closed_captions", async () => {
    vi.mocked(replaceAndCreateTextTrack).mockResolvedValue({
      kind: "created",
      trackId: "track-en-edited",
      deleted: [{ id: "track-en", name: "English", languageCode: "en", textSource: "uploaded" }],
    });

    const result = await editCaptions("asset-1", "track-en", OPTIONS);

    expect(vi.mocked(replaceAndCreateTextTrack)).toHaveBeenCalledWith(expect.objectContaining({
      target: { languageCode: "en", name: "English" },
      policy: "replace_all",
      closedCaptions: true,
      keepTrackIds: [],
      passthrough: JSON.stringify({ mux_ai: { workflow: "edit-captions" } }),
    }));
    expect(result.uploadedTrackId).toBe("track-en-edited");
    expect(result.replacedTracks?.map(t => t.id)).toEqual(["track-en"]);
    expect(vi.mocked(createTextTrackOnMux)).not.toHaveBeenCalled();
  });

  it("requires trackName under fail and keeps the source out of the conflict set", async () => {
    const error = await captureRejection(editCaptions("asset-1", "track-en", { ...OPTIONS, replaceExistingTracks: "fail" }));
    expect(error.message).toContain("trackName is required");

    vi.mocked(replaceAndCreateTextTrack).mockResolvedValue({ kind: "created", trackId: "t", deleted: [] });
    await editCaptions("asset-1", "track-en", { ...OPTIONS, replaceExistingTracks: "fail", trackName: "English (clean)" });
    expect(vi.mocked(replaceAndCreateTextTrack)).toHaveBeenCalledWith(expect.objectContaining({
      target: { languageCode: "en", name: "English (clean)" },
      policy: "fail",
      keepTrackIds: ["track-en"],
    }));
  });

  it("rejects fail with a trackName equal to the source name, ignoring case and whitespace", async () => {
    const error = await captureRejection(editCaptions("asset-1", "track-en", { ...OPTIONS, replaceExistingTracks: "fail", trackName: " english " }));
    expect(error.message).toContain("matches the source track's name");
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
    expect(vi.mocked(replaceAndCreateTextTrack)).not.toHaveBeenCalled();
  });

  it("rejects before editing when fail would collide with another track", async () => {
    mockAsset([SOURCE_TRACK, { ...ASR_ES_TRACK, id: "track-en-cc", language_code: "en", name: "English CC" }]);

    const error = await captureRejection(editCaptions("asset-1", "track-en", { ...OPTIONS, replaceExistingTracks: "fail", trackName: "English (clean)" }));

    expect(error.message).toContain("English CC");
    expect(vi.mocked(replaceAndCreateTextTrack)).not.toHaveBeenCalled();
  });

  it("rejects mixing deprecated options with the new ones", async () => {
    const error = await captureRejection(editCaptions("asset-1", "track-en", { ...OPTIONS, deleteOriginalTrack: true, trackName: "X" }));
    expect(error.message).toContain("deprecated");
  });

  it("keeps the previous create-then-delete behaviour when deprecated options are used", async () => {
    vi.mocked(createTextTrackOnMux).mockResolvedValue("track-en-suffixed");
    vi.mocked(resolveMuxClient).mockResolvedValue({
      createClient: async () => ({ video: { assets: { deleteTrack: vi.fn().mockResolvedValue(undefined) } } }),
    } as any);

    const result = await editCaptions("asset-1", "track-en", { ...OPTIONS, deleteOriginalTrack: true, trackNameSuffix: "clean" });

    expect(vi.mocked(createTextTrackOnMux)).toHaveBeenCalledWith(
      "asset-1",
      "en",
      "English (clean)",
      "https://s3.example.test/presigned.vtt",
      undefined,
      { closedCaptions: true, passthrough: JSON.stringify({ mux_ai: { workflow: "edit-captions" } }) },
    );
    expect(vi.mocked(replaceAndCreateTextTrack)).not.toHaveBeenCalled();
    expect(result.uploadedTrackId).toBe("track-en-suffixed");
  });

  it("restores the source track from the original VTT when the in-place create fails", async () => {
    vi.mocked(replaceAndCreateTextTrack).mockResolvedValue({
      kind: "create_failed",
      reason: "Mux exploded",
      deleted: [{ id: "track-en", name: "English", languageCode: "en" }],
    });
    vi.mocked(createTextTrackOnMux).mockResolvedValue("track-en-restored");

    const error = await captureRejection(editCaptions("asset-1", "track-en", OPTIONS));

    expect(error.message).toContain("Mux exploded");
    expect(error.message).toContain("restored as track-en-restored");
    expect(vi.mocked(putObjectWithStorageAdapter)).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: VTT, key: expect.stringContaining("-original-") }),
      undefined,
    );
    expect(vi.mocked(createTextTrackOnMux)).toHaveBeenCalledWith(
      "asset-1",
      "en",
      "English",
      "https://s3.example.test/presigned.vtt",
      undefined,
      { closedCaptions: true, passthrough: "customer-tag" },
    );
  });

  it("does not attempt a restore when the source was not deleted", async () => {
    vi.mocked(replaceAndCreateTextTrack).mockResolvedValue({ kind: "create_failed", reason: "nope", deleted: [] });

    const error = await captureRejection(editCaptions("asset-1", "track-en", OPTIONS));

    expect(error.message).toContain("nope");
    expect(vi.mocked(createTextTrackOnMux)).not.toHaveBeenCalled();
  });
});
