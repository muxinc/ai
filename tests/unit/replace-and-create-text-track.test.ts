import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/workflow-credentials", () => ({
  resolveMuxClient: vi.fn(),
}));

const { resolveMuxClient } = await import("../../src/lib/workflow-credentials");
const { replaceAndCreateTextTrack } = await import("../../src/lib/mux-tracks");

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

    expect(result).toEqual({ kind: "blocked", reason: expect.stringContaining("English"), tracks: [expect.objectContaining({ id: "up-en" })], deleted: [] });
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
      reason: expect.stringContaining("not Mux-generated"),
      tracks: [expect.objectContaining({ id: "up-en" })],
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

  it("returns create_failed with the deletions for other create errors", async () => {
    retrieve.mockResolvedValue({ id: "asset-1", tracks: [UPLOADED_EN] });
    createTrack.mockRejectedValue(new Error("url unreachable"));

    const result = await replaceAndCreateTextTrack({ ...INPUT, policy: "replace_all" });

    expect(result).toEqual({ kind: "create_failed", reason: "url unreachable", deleted: [expect.objectContaining({ id: "up-en" })] });
    expect(createTrack).toHaveBeenCalledTimes(1);
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
    retrieve.mockRejectedValue(new Error("mux down"));

    await expect(replaceAndCreateTextTrack({ ...INPUT, policy: "replace_all" })).rejects.toThrow("mux down");
    expect(deleteTrack).not.toHaveBeenCalled();
    expect(createTrack).not.toHaveBeenCalled();
  });
});
