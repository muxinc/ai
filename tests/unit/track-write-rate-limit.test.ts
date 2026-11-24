import { RetryableError } from "@workflow/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MUX_AI_ERROR_CODES } from "../../src/lib/mux-ai-error.ts";
import { MUX_VIDEO_RATE_LIMIT_POLICY } from "../../src/lib/rate-limit.ts";

vi.mock("workflow", () => ({ getStepMetadata: vi.fn() }));
vi.mock("../../src/lib/workflow-credentials", () => ({ resolveMuxClient: vi.fn() }));

const { getStepMetadata } = await import("workflow");
const { resolveMuxClient } = await import("../../src/lib/workflow-credentials");
const { clearTrackConflicts, createTextTrackOnMux, createTrack } = await import("../../src/lib/mux-tracks");

const retrieve = vi.fn();
const deleteTrack = vi.fn();
const createTrackCall = vi.fn();

const ASR_EN = { id: "asr-en", type: "text", text_type: "subtitles", status: "ready", language_code: "en", name: "English CC", text_source: "generated_vod" };
const PASSTHROUGH = "{\"mux_ai\":{\"workflow\":\"test\"}}";
const INPUT = {
  assetId: "asset-1",
  target: { languageCode: "en", name: "English" },
  presignedUrl: "https://s3.example.test/new.vtt",
  passthrough: PASSTHROUGH,
  classifiedErrors: true,
};

function rateLimited() {
  return Object.assign(new Error("429 Too many requests"), { status: 429, headers: new Headers({ "retry-after": "2" }) });
}

function inStep(attempt: number) {
  vi.mocked(getStepMetadata).mockReturnValue({ attempt } as ReturnType<typeof getStepMetadata>);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveMuxClient).mockResolvedValue({
    createClient: async () => ({ video: { assets: { retrieve, deleteTrack, createTrack: createTrackCall } } }),
  } as any);
  deleteTrack.mockResolvedValue(undefined);
});

describe("createTrack (step)", () => {
  it("throws a delayed retry on a 429 while attempts remain", async () => {
    inStep(1);
    createTrackCall.mockRejectedValue(rateLimited());

    const error = await createTrack(INPUT).catch((caught: unknown) => caught);

    expect(RetryableError.is(error)).toBe(true);
    expect(error).toMatchObject({ code: MUX_AI_ERROR_CODES.DEPENDENCY_RATE_LIMITED, facts: { call: "create_track", status: 429, retryAfterMs: 2000 } });
  });

  it("returns create_failed on a 429 once the attempts are spent", async () => {
    inStep(MUX_VIDEO_RATE_LIMIT_POLICY.maxRetries + 1);
    retrieve.mockResolvedValue({ id: "asset-1", tracks: [] });
    createTrackCall.mockRejectedValue(rateLimited());

    const result = await createTrack(INPUT);

    expect(result).toMatchObject({ kind: "create_failed", error: { code: MUX_AI_ERROR_CODES.DEPENDENCY_RATE_LIMITED } });
    expect((result as { error: Error }).error.name).toBe("Error");
  });

  it("never retries a failure that may have created the track", async () => {
    inStep(1);
    createTrackCall.mockRejectedValue(Object.assign(new Error("502"), { status: 502 }));

    const result = await createTrack(INPUT);

    expect(result).toMatchObject({ kind: "create_failed", error: { code: MUX_AI_ERROR_CODES.DEPENDENCY_SERVER_ERROR, transient: false } });
  });

  it("on a rerun, returns the track an earlier attempt already created", async () => {
    inStep(2);
    retrieve.mockResolvedValue({ id: "asset-1", tracks: [{ id: "mine", type: "text", status: "preparing", name: "English", language_code: "en", passthrough: PASSTHROUGH }] });

    expect(await createTrack(INPUT)).toEqual({ kind: "created", trackId: "mine" });
    expect(createTrackCall).not.toHaveBeenCalled();
  });

  it("reports a duplicate name for the caller to re-plan", async () => {
    inStep(1);
    createTrackCall.mockRejectedValue(Object.assign(new Error("400 not unique"), {
      status: 400,
      error: { type: "invalid_parameters", messages: ["Track name 'English' is not unique"] },
    }));

    expect(await createTrack(INPUT)).toEqual({ kind: "duplicate_name" });
  });
});

describe("clearTrackConflicts (step)", () => {
  const plan = { kind: "target", policy: "replace_all" } as const;

  it("throws a delayed retry on a 429 before anything is deleted", async () => {
    inStep(1);
    retrieve.mockRejectedValue(rateLimited());

    const error = await clearTrackConflicts(INPUT, plan).catch((caught: unknown) => caught);

    expect(RetryableError.is(error)).toBe(true);
    expect(deleteTrack).not.toHaveBeenCalled();
  });

  it("returns the deleted tracks, not a retry, once something has been deleted", async () => {
    inStep(1);
    retrieve.mockResolvedValue({ id: "asset-1", tracks: [ASR_EN, { ...ASR_EN, id: "asr-en-2", name: "English 2" }] });
    deleteTrack.mockResolvedValueOnce(undefined).mockRejectedValueOnce(rateLimited());

    const result = await clearTrackConflicts(INPUT, plan);

    expect(result).toMatchObject({ kind: "create_failed", deleted: [{ id: "asr-en" }], error: { code: MUX_AI_ERROR_CODES.DEPENDENCY_RATE_LIMITED } });
  });

  it("returns, not retries, a failure after an earlier step's deletes", async () => {
    inStep(1);
    retrieve.mockRejectedValue(rateLimited());

    expect(await clearTrackConflicts(INPUT, plan, true)).toMatchObject({ kind: "create_failed", deleted: [] });
  });
});

describe("createTextTrackOnMux (step)", () => {
  it("throws a delayed retry on a 429, and the classified error once attempts are spent", async () => {
    createTrackCall.mockRejectedValue(rateLimited());

    inStep(1);
    const retry = await createTextTrackOnMux("asset-1", "en", "English", INPUT.presignedUrl).catch((caught: unknown) => caught);
    expect(RetryableError.is(retry)).toBe(true);

    inStep(MUX_VIDEO_RATE_LIMIT_POLICY.maxRetries + 1);
    const final = await createTextTrackOnMux("asset-1", "en", "English", INPUT.presignedUrl).catch((caught: unknown) => caught);
    expect(RetryableError.is(final)).toBe(false);
    expect(final).toMatchObject({ code: MUX_AI_ERROR_CODES.DEPENDENCY_RATE_LIMITED });
  });

  it("sets each rate-limited step's retry budget to the policy's", () => {
    for (const step of [createTrack, clearTrackConflicts, createTextTrackOnMux]) {
      expect((step as unknown as { maxRetries: number }).maxRetries).toBe(MUX_VIDEO_RATE_LIMIT_POLICY.maxRetries);
    }
  });
});
