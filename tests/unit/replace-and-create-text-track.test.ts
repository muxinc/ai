import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/workflow-credentials", () => ({
  resolveMuxClient: vi.fn(),
}));

const { resolveMuxClient } = await import("../../src/lib/workflow-credentials");
const { createTextTrackOnMux, replaceAndCreateTextTrack, replaceAndCreateTrack, replaceSourceTrack } = await import("../../src/lib/mux-tracks");

const ASR_EN = { id: "asr-en", type: "text", text_type: "subtitles", status: "ready", language_code: "en", name: "English CC", text_source: "generated_vod" };
const UPLOADED_EN = { id: "up-en", type: "text", text_type: "subtitles", status: "ready", language_code: "en", name: "English", text_source: "uploaded" };

function duplicateNameError(name: string) {
  return Object.assign(new Error("400 not unique"), {
    status: 400,
    error: { type: "invalid_parameters", messages: [`Track name '${name}' is not unique, please choose a different track name and try again`] },
  });
}

const retrieve = vi.fn();
const deleteTrack = vi.fn();
const createTrack = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveMuxClient).mockResolvedValue({
    createClient: async () => ({ video: { assets: { retrieve, deleteTrack, createTrack } } }),
  } as any);
  deleteTrack.mockResolvedValue(undefined);
});

const INPUT = {
  assetId: "asset-1",
  target: { languageCode: "en", name: "English" },
  presignedUrl: "https://s3.example.test/new.vtt",
  passthrough: "{\"mux_ai\":{\"workflow\":\"test\"}}",
};

describe("replaceAndCreateTextTrack", () => {
  it("deletes conflicts, creates with trimmed name and passthrough, and reports deletions", async () => {
    retrieve.mockResolvedValue({ id: "asset-1", tracks: [ASR_EN, UPLOADED_EN] });
    createTrack.mockResolvedValue({ id: "new" });

    const result = await replaceAndCreateTextTrack({ ...INPUT, target: { languageCode: "en", name: " English " }, policy: "replace_all", closedCaptions: true });

    expect(result).toEqual({ kind: "created", trackId: "new", deleted: [expect.objectContaining({ id: "asr-en" }), expect.objectContaining({ id: "up-en" })] });
    expect(deleteTrack).toHaveBeenCalledTimes(2);
    expect(createTrack).toHaveBeenCalledWith("asset-1", expect.objectContaining({ name: "English", language_code: "en", closed_captions: true, passthrough: INPUT.passthrough }));
  });

  it("returns blocked with no deletions and never creates when the policy is fail", async () => {
    retrieve.mockResolvedValue({ id: "asset-1", tracks: [UPLOADED_EN] });

    const result = await replaceAndCreateTextTrack({ ...INPUT, policy: "fail" });

    expect(result).toEqual({
      kind: "blocked",
      code: "policy_fail",
      reason: expect.stringContaining("English"),
      tracks: [expect.objectContaining({ id: "up-en" })],
      conflictsOnLanguage: true,
      deleted: [],
    });
    expect(deleteTrack).not.toHaveBeenCalled();
    expect(createTrack).not.toHaveBeenCalled();
  });

  it("tolerates a 404 on delete", async () => {
    retrieve.mockResolvedValue({ id: "asset-1", tracks: [ASR_EN] });
    deleteTrack.mockRejectedValueOnce(Object.assign(new Error("gone"), { status: 404 }));
    createTrack.mockResolvedValue({ id: "new" });

    const result = await replaceAndCreateTextTrack({ ...INPUT, policy: "replace_generated" });

    expect(result).toEqual({ kind: "created", trackId: "new", deleted: [] });
  });

  it("retries once on a duplicate-name 400 after re-planning against a fresh asset", async () => {
    retrieve
      .mockResolvedValueOnce({ id: "asset-1", tracks: [] })
      .mockResolvedValueOnce({ id: "asset-1", tracks: [ASR_EN] });
    createTrack
      .mockRejectedValueOnce(duplicateNameError("English"))
      .mockResolvedValueOnce({ id: "new" });

    const result = await replaceAndCreateTextTrack({ ...INPUT, policy: "replace_generated" });

    expect(result).toEqual({ kind: "created", trackId: "new", deleted: [expect.objectContaining({ id: "asr-en" })] });
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(createTrack).toHaveBeenCalledTimes(2);
  });

  it("reports earlier deletions when the retry is blocked by a track that appeared concurrently", async () => {
    retrieve
      .mockResolvedValueOnce({ id: "asset-1", tracks: [ASR_EN] })
      .mockResolvedValueOnce({ id: "asset-1", tracks: [UPLOADED_EN] });
    createTrack.mockRejectedValueOnce(duplicateNameError("English"));

    const result = await replaceAndCreateTextTrack({ ...INPUT, policy: "replace_generated" });

    expect(result).toEqual({
      kind: "blocked",
      code: "not_generated",
      reason: expect.stringContaining("not Mux-generated"),
      tracks: [expect.objectContaining({ id: "up-en" })],
      conflictsOnLanguage: true,
      deleted: [expect.objectContaining({ id: "asr-en" })],
    });
    expect(createTrack).toHaveBeenCalledTimes(1);
  });

  it("gives up after the second duplicate-name rejection", async () => {
    retrieve.mockResolvedValue({ id: "asset-1", tracks: [] });
    createTrack.mockRejectedValue(duplicateNameError("English"));

    const result = await replaceAndCreateTextTrack({ ...INPUT, policy: "replace_all" });

    expect(result).toEqual({ kind: "create_failed", reason: expect.stringContaining("not unique"), deleted: [] });
    expect(createTrack).toHaveBeenCalledTimes(2);
  });

  it("with classified errors, reports a name collision, not a failure, after the second duplicate-name rejection", async () => {
    retrieve.mockResolvedValue({ id: "asset-1", tracks: [] });
    createTrack.mockRejectedValue(duplicateNameError("English"));

    const result = await replaceAndCreateTextTrack({ ...INPUT, policy: "replace_all", classifiedErrors: true });

    expect(result).toEqual({
      kind: "blocked",
      code: "name_collision",
      reason: expect.stringContaining("not unique"),
      tracks: [],
      conflictsOnLanguage: false,
      deleted: [],
    });
    expect(createTrack).toHaveBeenCalledTimes(2);
  });

  it("returns create_failed with the deletions for other create errors", async () => {
    retrieve.mockResolvedValue({ id: "asset-1", tracks: [UPLOADED_EN] });
    createTrack.mockRejectedValue(new Error("url unreachable"));

    const result = await replaceAndCreateTextTrack({ ...INPUT, policy: "replace_all" });

    expect(result).toEqual({ kind: "create_failed", reason: "url unreachable", deleted: [expect.objectContaining({ id: "up-en" })] });
    expect(createTrack).toHaveBeenCalledTimes(1);
  });

  it("with classified errors, classifies a failed write inside the step, keeping Mux's status, request id and error type", async () => {
    retrieve.mockResolvedValue({ id: "asset-1", tracks: [UPLOADED_EN] });
    createTrack.mockRejectedValue(Object.assign(new Error("502 {\"error\":{\"type\":\"bad_gateway\",\"messages\":[\"upstream down\"]}}"), {
      status: 502,
      headers: new Headers({ "x-request-id": "req-1" }),
      error: { error: { type: "bad_gateway", messages: ["upstream down"] } },
    }));

    const result = await replaceAndCreateTextTrack({ ...INPUT, policy: "replace_all", classifiedErrors: true });

    expect(result).toMatchObject({ kind: "create_failed", deleted: [expect.objectContaining({ id: "up-en" })] });
    const error = (result as { error?: unknown }).error;
    expect(error).toMatchObject({
      source: "upstream",
      dependency: "mux_video",
      // A create may have taken effect, so it isn't step-retried; the job stays retryable.
      transient: false,
      retryable: true,
      facts: { call: "create_track", status: 502, requestId: "req-1", muxErrorType: "bad_gateway", assetId: "asset-1" },
    });
    expect((error as { causes: unknown[] }).causes).toEqual([expect.objectContaining({ name: "Error", status: 502, message: expect.stringContaining("upstream down") })]);
  });

  it("creates an audio track without text-only fields and only deletes audio conflicts", async () => {
    const primary = { id: "primary", type: "audio", language_code: "en", name: "English", primary: true };
    const oldDub = { id: "old-dub", type: "audio", language_code: "es", name: "Spanish (Auto-dubbed)" };
    const sameNameText = { id: "text-es", type: "text", text_type: "subtitles", status: "ready", language_code: "es", name: "Spanish (Auto-dubbed)" };
    retrieve.mockResolvedValue({ id: "asset-1", tracks: [primary, oldDub, sameNameText] });
    createTrack.mockResolvedValue({ id: "new-dub" });

    const result = await replaceAndCreateTrack({
      ...INPUT,
      target: { type: "audio", languageCode: "es", name: "Spanish (Auto-dubbed)" },
      policy: "replace_all",
      closedCaptions: true,
    });

    expect(result).toEqual({ kind: "created", trackId: "new-dub", deleted: [expect.objectContaining({ id: "old-dub", type: "audio" })] });
    expect(deleteTrack).toHaveBeenCalledTimes(1);
    expect(createTrack).toHaveBeenCalledWith("asset-1", { type: "audio", language_code: "es", name: "Spanish (Auto-dubbed)", url: INPUT.presignedUrl, passthrough: INPUT.passthrough });
  });

  it("returns create_failed with the deletions so far when a later delete fails", async () => {
    retrieve.mockResolvedValue({ id: "asset-1", tracks: [ASR_EN, UPLOADED_EN] });
    deleteTrack
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("forbidden"), { status: 403 }));

    const result = await replaceAndCreateTextTrack({ ...INPUT, policy: "replace_all" });

    expect(result).toEqual({ kind: "create_failed", reason: "forbidden", deleted: [expect.objectContaining({ id: "asr-en" })] });
    expect(createTrack).not.toHaveBeenCalled();
  });

  it("returns create_failed with the deletions when the retry's asset fetch fails", async () => {
    retrieve
      .mockResolvedValueOnce({ id: "asset-1", tracks: [ASR_EN] })
      .mockRejectedValueOnce(new Error("mux down"));
    createTrack.mockRejectedValueOnce(duplicateNameError("English"));

    const result = await replaceAndCreateTextTrack({ ...INPUT, policy: "replace_all" });

    expect(result).toEqual({ kind: "create_failed", reason: "mux down", deleted: [expect.objectContaining({ id: "asr-en" })] });
  });

  it("still throws when the first asset fetch fails, since nothing has been deleted", async () => {
    retrieve.mockRejectedValue(Object.assign(new Error("mux down"), { status: 503 }));

    await expect(replaceAndCreateTextTrack({ ...INPUT, policy: "replace_all" })).rejects.toThrow("mux down");
    expect(deleteTrack).not.toHaveBeenCalled();
    expect(createTrack).not.toHaveBeenCalled();
  });

  it("with classified errors, classifies a failed first asset fetch", async () => {
    retrieve.mockRejectedValue(Object.assign(new Error("mux down"), { status: 503 }));

    await expect(replaceAndCreateTextTrack({ ...INPUT, policy: "replace_all", classifiedErrors: true })).rejects.toMatchObject({
      message: "Failed to fetch the asset from Mux",
      source: "upstream",
      dependency: "mux_video",
      transient: true,
      facts: { call: "get_asset", status: 503, assetId: "asset-1" },
    });
    expect(deleteTrack).not.toHaveBeenCalled();
    expect(createTrack).not.toHaveBeenCalled();
  });
});

describe("replaceSourceTrack", () => {
  const SOURCE_INPUT = { ...INPUT, sourceTrackId: "up-en" };

  it("deletes only the source, then creates a text track under the target name", async () => {
    retrieve.mockResolvedValue({ id: "asset-1", tracks: [ASR_EN, UPLOADED_EN] });
    createTrack.mockResolvedValue({ id: "new" });

    const result = await replaceSourceTrack({ ...SOURCE_INPUT, policy: "replace", closedCaptions: true });

    expect(result).toEqual({ kind: "created", trackId: "new", deleted: [expect.objectContaining({ id: "up-en" })] });
    expect(deleteTrack).toHaveBeenCalledTimes(1);
    expect(deleteTrack).toHaveBeenCalledWith("asset-1", "up-en");
    expect(createTrack).toHaveBeenCalledWith("asset-1", expect.objectContaining({ type: "text", text_type: "subtitles", name: "English", closed_captions: true }));
  });

  it("deletes nothing under fail and adds the track alongside the source", async () => {
    retrieve.mockResolvedValue({ id: "asset-1", tracks: [ASR_EN, UPLOADED_EN] });
    createTrack.mockResolvedValue({ id: "new" });

    const result = await replaceSourceTrack({ ...SOURCE_INPUT, target: { languageCode: "en", name: "English (clean)" }, policy: "fail" });

    expect(result).toEqual({ kind: "created", trackId: "new", deleted: [] });
    expect(deleteTrack).not.toHaveBeenCalled();
  });

  it("reports the deleted source when the duplicate-name retry finds another track using the name", async () => {
    const duplicate = { ...ASR_EN, id: "dup", name: "English" };
    retrieve
      .mockResolvedValueOnce({ id: "asset-1", tracks: [UPLOADED_EN] })
      .mockResolvedValueOnce({ id: "asset-1", tracks: [duplicate] });
    createTrack.mockRejectedValueOnce(duplicateNameError("English"));

    const result = await replaceSourceTrack({ ...SOURCE_INPUT, policy: "replace" });

    expect(result).toEqual({
      kind: "blocked",
      code: "name_collision",
      reason: expect.stringContaining("A text track already has the name 'English'"),
      tracks: [expect.objectContaining({ id: "dup" })],
      conflictsOnLanguage: false,
      deleted: [expect.objectContaining({ id: "up-en" })],
    });
  });
});

describe("createTextTrackOnMux", () => {
  it("classifies a failed create inside the step, keeping Mux's status and request id", async () => {
    createTrack.mockRejectedValue(Object.assign(new Error("500 internal"), { status: 500, headers: new Headers({ "x-request-id": "req-2" }) }));

    await expect(createTextTrackOnMux("asset-1", "en", "English", "https://s3.example.test/new.vtt")).rejects.toMatchObject({
      source: "upstream",
      dependency: "mux_video",
      facts: { call: "create_track", status: 500, requestId: "req-2", assetId: "asset-1" },
    });
  });

  it("classifies a create that returns no track id", async () => {
    createTrack.mockResolvedValue({});

    await expect(createTextTrackOnMux("asset-1", "en", "English", "https://s3.example.test/new.vtt")).rejects.toMatchObject({
      message: "Failed to create text track: no track ID returned from Mux",
      dependency: "mux_video",
      facts: { assetId: "asset-1" },
    });
  });
});
