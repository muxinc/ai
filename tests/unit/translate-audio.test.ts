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

vi.mock("../../src/lib/mux-tracks", () => ({
  createTextTrackOnMux: vi.fn(),
}));

const { getAssetDurationSecondsFromAsset, getPlaybackIdForAsset } = await import("../../src/lib/mux-assets");
const { resolveMuxClient } = await import("../../src/lib/workflow-credentials");
const { getApiKeyFromEnv } = await import("../../src/lib/client-factory");
const { translateAudio } = await import("../../src/workflows/translate-audio");

const ASSET_ID = "asset-123";
const CREATED_RENDITION_ID = "rendition-created-1";

// Neither S3 staging nor Mux track upload is exercised here — every scenario
// targets static rendition lifecycle handling around the dubbing job.
const BASE_OPTIONS = {
  uploadToS3: false,
  uploadToMux: false,
} as const;

function buildAsset(staticRenditions?: object) {
  return {
    id: ASSET_ID,
    duration: 60,
    playback_ids: [{ id: "playback-123", policy: "public" }],
    static_renditions: staticRenditions,
  };
}

function readyRenditionAsset(renditionId: string) {
  return buildAsset({
    status: "ready",
    files: [{ id: renditionId, name: "audio.m4a", status: "ready" }],
  });
}

function mockMuxClient({
  initialAsset,
  polledAsset,
}: {
  initialAsset: object;
  polledAsset?: object;
}) {
  const createStaticRendition = vi.fn(async () => ({
    id: CREATED_RENDITION_ID,
    status: "preparing",
  }));
  const deleteStaticRendition = vi.fn(async () => {});
  const retrieve = vi.fn(async () => polledAsset ?? initialAsset);
  const mux = { video: { assets: { createStaticRendition, deleteStaticRendition, retrieve } } };

  vi.mocked(resolveMuxClient).mockResolvedValue({
    createClient: async () => mux,
    getSigningKey: () => undefined,
    getPrivateKey: () => undefined,
  } as any);
  vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
    asset: initialAsset,
    playbackId: "playback-123",
    policy: "public",
  } as any);

  return { createStaticRendition, deleteStaticRendition, retrieve };
}

function stubElevenLabsFetch({ dubbingStatus = "dubbed" }: { dubbingStatus?: string } = {}) {
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/v1/dubbing") && init?.method === "POST") {
      return new Response(JSON.stringify({ dubbing_id: "dub-1" }), { status: 200 });
    }
    if (url.endsWith("/v1/dubbing/dub-1")) {
      return new Response(
        JSON.stringify({ status: dubbingStatus, target_languages: ["fr"] }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(60);
  vi.mocked(getApiKeyFromEnv).mockResolvedValue("elevenlabs-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("translateAudio static rendition cleanup", () => {
  it("does not create or delete a rendition that already existed", async () => {
    const { createStaticRendition, deleteStaticRendition } = mockMuxClient({
      initialAsset: readyRenditionAsset("rendition-pre-existing"),
    });
    stubElevenLabsFetch();

    const result = await translateAudio(ASSET_ID, "fr", BASE_OPTIONS);

    expect(createStaticRendition).not.toHaveBeenCalled();
    expect(deleteStaticRendition).not.toHaveBeenCalled();
    expect(result.createdStaticRenditionId).toBeUndefined();
    expect(result.staticRenditionCleanup).toBe("not_created");
  });

  it("deletes the rendition it created after a successful dub", async () => {
    const { createStaticRendition, deleteStaticRendition } = mockMuxClient({
      initialAsset: buildAsset(),
      polledAsset: readyRenditionAsset(CREATED_RENDITION_ID),
    });
    stubElevenLabsFetch();

    const result = await translateAudio(ASSET_ID, "fr", BASE_OPTIONS);

    expect(createStaticRendition).toHaveBeenCalledWith(ASSET_ID, { resolution: "audio-only" });
    expect(deleteStaticRendition).toHaveBeenCalledWith(ASSET_ID, CREATED_RENDITION_ID);
    expect(result.createdStaticRenditionId).toBe(CREATED_RENDITION_ID);
    expect(result.staticRenditionCleanup).toBe("deleted");
    expect(result.dubbingId).toBe("dub-1");
  });

  it("treats re-requesting over an errored rendition as created by this run", async () => {
    const { createStaticRendition, deleteStaticRendition } = mockMuxClient({
      initialAsset: buildAsset({
        status: "errored",
        files: [{ id: "rendition-errored", name: "audio.m4a", status: "errored" }],
      }),
      polledAsset: readyRenditionAsset(CREATED_RENDITION_ID),
    });
    stubElevenLabsFetch();

    const result = await translateAudio(ASSET_ID, "fr", BASE_OPTIONS);

    expect(createStaticRendition).toHaveBeenCalledOnce();
    expect(deleteStaticRendition).toHaveBeenCalledWith(ASSET_ID, CREATED_RENDITION_ID);
    expect(result.staticRenditionCleanup).toBe("deleted");
  });

  it("still deletes the rendition it created when dubbing fails", async () => {
    const { deleteStaticRendition } = mockMuxClient({
      initialAsset: buildAsset(),
      polledAsset: readyRenditionAsset(CREATED_RENDITION_ID),
    });
    stubElevenLabsFetch({ dubbingStatus: "failed" });

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", BASE_OPTIONS));

    expect((error as Error).message).toContain("dubbing job failed");
    expect(deleteStaticRendition).toHaveBeenCalledWith(ASSET_ID, CREATED_RENDITION_ID);
  });

  it("keeps the rendition it created when staticRenditionCleanup is 'keep'", async () => {
    const { deleteStaticRendition } = mockMuxClient({
      initialAsset: buildAsset(),
      polledAsset: readyRenditionAsset(CREATED_RENDITION_ID),
    });
    stubElevenLabsFetch();

    const result = await translateAudio(ASSET_ID, "fr", {
      ...BASE_OPTIONS,
      staticRenditionCleanup: "keep",
    });

    expect(deleteStaticRendition).not.toHaveBeenCalled();
    expect(result.createdStaticRenditionId).toBe(CREATED_RENDITION_ID);
    expect(result.staticRenditionCleanup).toBe("kept");
  });

  it("reports delete_failed without masking a successful workflow result", async () => {
    const { deleteStaticRendition } = mockMuxClient({
      initialAsset: buildAsset(),
      polledAsset: readyRenditionAsset(CREATED_RENDITION_ID),
    });
    deleteStaticRendition.mockRejectedValue(
      Object.assign(new Error("Internal server error"), { status: 500 }),
    );
    stubElevenLabsFetch();

    const result = await translateAudio(ASSET_ID, "fr", BASE_OPTIONS);

    expect(result.dubbingId).toBe("dub-1");
    expect(result.staticRenditionCleanup).toBe("delete_failed");
    expect(result.createdStaticRenditionId).toBe(CREATED_RENDITION_ID);
  });

  it("treats an already-deleted rendition (404) as deleted", async () => {
    const { deleteStaticRendition } = mockMuxClient({
      initialAsset: buildAsset(),
      polledAsset: readyRenditionAsset(CREATED_RENDITION_ID),
    });
    deleteStaticRendition.mockRejectedValue(
      Object.assign(new Error("Not found"), { status: 404 }),
    );
    stubElevenLabsFetch();

    const result = await translateAudio(ASSET_ID, "fr", BASE_OPTIONS);

    expect(result.staticRenditionCleanup).toBe("deleted");
  });
});
