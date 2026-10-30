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
  resolveWorkflowCredentials: async () => ({}),
}));

vi.mock("../../src/lib/client-factory", () => ({
  getApiKeyFromEnv: vi.fn(),
  getMuxClientFromEnv: vi.fn(),
}));

vi.mock("../../src/lib/mux-tracks", async importOriginal => ({
  ...(await importOriginal<object>()),
  createTextTrackOnMux: vi.fn(),
}));

const { getAssetDurationSecondsFromAsset, getPlaybackIdForAsset } = await import("../../src/lib/mux-assets");
const { resolveMuxClient } = await import("../../src/lib/workflow-credentials");
const { getApiKeyFromEnv } = await import("../../src/lib/client-factory");
const { translateAudio } = await import("../../src/workflows/translate-audio");
const { MuxAiError } = await import("../../src/lib/mux-ai-error");

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

  it("waits up to 30 minutes for a requested rendition before timing out", async () => {
    const { retrieve, deleteStaticRendition } = mockMuxClient({
      initialAsset: buildAsset(),
      polledAsset: buildAsset({
        files: [{ id: CREATED_RENDITION_ID, name: "audio.m4a", status: "preparing" }],
      }),
    });
    stubElevenLabsFetch();

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", BASE_OPTIONS));

    expect(error).toMatchObject({ publicType: "timeout_error", retryable: true });
    expect(retrieve).toHaveBeenCalledTimes(180);
    expect(deleteStaticRendition).toHaveBeenCalledWith(ASSET_ID, CREATED_RENDITION_ID);
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

function stubElevenLabsCreateFailure(response: Response) {
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    if (String(input).endsWith("/v1/dubbing") && init?.method === "POST") {
      return response;
    }
    throw new Error(`Unexpected fetch in test: ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const UNSUPPORTED_LANGUAGE_BODY = {
  detail: {
    type: "validation_error",
    code: "invalid_parameters",
    message: "Target language 'ur' is not supported.",
    status: "unsupported_target_language",
    request_id: "ce841eacec9f38158a9ef2f4b66b0940",
    param: "target_lang",
  },
};

describe("translateAudio ElevenLabs language codes", () => {
  beforeEach(() => {
    mockMuxClient({ initialAsset: readyRenditionAsset("rendition-pre-existing") });
  });

  function sentDubbingForm(fetchMock: ReturnType<typeof stubElevenLabsFetch>): FormData {
    const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/v1/dubbing") && init?.method === "POST");
    return call![1].body as FormData;
  }

  it("drops region subtags from the target and source languages", async () => {
    const fetchMock = stubElevenLabsFetch();

    await translateAudio(ASSET_ID, "pt-BR", { ...BASE_OPTIONS, fromLanguageCode: "en_US" });

    const form = sentDubbingForm(fetchMock);
    expect(form.get("target_lang")).toBe("por");
    expect(form.get("source_lang")).toBe("eng");
  });

  it("still converts bare codes to ISO 639-3", async () => {
    const fetchMock = stubElevenLabsFetch();

    await translateAudio(ASSET_ID, "fr", BASE_OPTIONS);

    expect(sentDubbingForm(fetchMock).get("target_lang")).toBe("fra");
  });
});

describe("translateAudio ElevenLabs error reporting", () => {
  beforeEach(() => {
    mockMuxClient({ initialAsset: readyRenditionAsset("rendition-pre-existing") });
  });

  it("includes the status and ElevenLabs reason when dub creation is rejected", async () => {
    stubElevenLabsCreateFailure(new Response(JSON.stringify(UNSUPPORTED_LANGUAGE_BODY), { status: 400, statusText: "Bad Request" }));

    const error = await captureRejection(translateAudio(ASSET_ID, "ur", BASE_OPTIONS));

    expect((error as Error).message).toBe(
      "Failed to create ElevenLabs dubbing job: ElevenLabs API error: 400 Bad Request: unsupported_target_language: Target language 'ur' is not supported. (param: target_lang, request_id: ce841eacec9f38158a9ef2f4b66b0940)",
    );
  });

  it("keeps provider detail out of customer-safe errors", async () => {
    stubElevenLabsCreateFailure(new Response(JSON.stringify(UNSUPPORTED_LANGUAGE_BODY), { status: 400, statusText: "Bad Request" }));

    const error = await captureRejection(translateAudio(ASSET_ID, "ur", BASE_OPTIONS));

    expect(MuxAiError.is(error)).toBe(false);
  });

  it("lists field errors from a 422 validation response", async () => {
    stubElevenLabsCreateFailure(new Response(
      JSON.stringify({ detail: [{ loc: ["body", "target_lang"], msg: "field required", type: "missing" }] }),
      { status: 422, statusText: "Unprocessable Entity" },
    ));

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", BASE_OPTIONS));

    expect((error as Error).message).toContain("422 Unprocessable Entity: body.target_lang: field required");
  });

  it("keeps the 429 status in the message so callers can still detect rate limits", async () => {
    stubElevenLabsCreateFailure(new Response(
      JSON.stringify({ detail: { status: "too_many_concurrent_requests", message: "Too many concurrent requests." } }),
      { status: 429, statusText: "Too Many Requests" },
    ));

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", BASE_OPTIONS));

    expect((error as Error).message).toContain("429 Too Many Requests: too_many_concurrent_requests: Too many concurrent requests.");
  });

  it("truncates a non-JSON error body", async () => {
    stubElevenLabsCreateFailure(new Response(`<html>${"x".repeat(1000)}</html>`, { status: 502, statusText: "Bad Gateway" }));

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", BASE_OPTIONS));

    expect((error as Error).message).toContain("502 Bad Gateway: <html>xxx");
    expect((error as Error).message).not.toContain("</html>");
  });

  it("includes the ElevenLabs reason when a status check is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
      if (String(input).endsWith("/v1/dubbing") && init?.method === "POST") {
        return new Response(JSON.stringify({ dubbing_id: "dub-1" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ detail: { status: "dubbing_not_found", message: "Dubbing project not found." } }),
        { status: 404, statusText: "Not Found" },
      );
    }));

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", BASE_OPTIONS));

    expect((error as Error).message).toBe(
      "Failed to check dubbing status: Status check failed: 404 Not Found: dubbing_not_found: Dubbing project not found.",
    );
  });

  it("logs the ElevenLabs reason for a failed dub without changing the customer-facing error", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
      if (String(input).endsWith("/v1/dubbing") && init?.method === "POST") {
        return new Response(JSON.stringify({ dubbing_id: "dub-1" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ status: "failed", target_languages: [], error: "Source audio could not be decoded." }),
        { status: 200 },
      );
    }));

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", BASE_OPTIONS));

    expect(error).toMatchObject({
      publicType: "processing_error",
      publicMessage: "ElevenLabs reported that the dubbing job failed.",
    });
    expect(console.warn).toHaveBeenCalledWith("❌ ElevenLabs dubbing job dub-1 failed: Source audio could not be decoded.");
  });
});

function legacyAsset(mp4Support: string, staticRenditions?: object) {
  return { ...buildAsset(staticRenditions), mp4_support: mp4Support };
}

function dubbingSourceUrl(fetchMock: ReturnType<typeof vi.fn>): string | undefined {
  const createCall = fetchMock.mock.calls.find(([input, init]) =>
    String(input).endsWith("/v1/dubbing") && init?.method === "POST");
  return (createCall?.[1]?.body as FormData | undefined)?.get("source_url")?.toString();
}

describe("translateAudio on assets using the deprecated mp4_support option", () => {
  it.each([
    ["capped-1080p", ["capped-1080p.mp4"], "capped-1080p.mp4"],
    ["audio-only", ["audio.m4a"], "audio.m4a"],
    ["audio-only,capped-1080p", ["audio.m4a", "capped-1080p.mp4"], "audio.m4a"],
    ["standard", ["low.mp4", "medium.mp4", "high.mp4"], "low.mp4"],
  ])("dubs from the existing files for mp4_support=%s without touching static renditions", async (mp4Support, fileNames, expected) => {
    const { createStaticRendition, deleteStaticRendition } = mockMuxClient({
      initialAsset: legacyAsset(mp4Support, { status: "ready", files: fileNames.map(name => ({ name, filesize: "1000" })) }),
    });
    const fetchMock = stubElevenLabsFetch();

    const result = await translateAudio(ASSET_ID, "fr", BASE_OPTIONS);

    expect(dubbingSourceUrl(fetchMock)).toMatch(new RegExp(`/playback-123/${expected.replace(".", "\\.")}$`));
    expect(createStaticRendition).not.toHaveBeenCalled();
    expect(deleteStaticRendition).not.toHaveBeenCalled();
    expect(result.createdStaticRenditionId).toBeUndefined();
    expect(result.staticRenditionCleanup).toBe("not_created");
  });

  it("waits for preparing mp4_support renditions instead of requesting new ones", async () => {
    const { createStaticRendition, retrieve } = mockMuxClient({
      initialAsset: legacyAsset("capped-1080p", { status: "preparing" }),
      polledAsset: legacyAsset("capped-1080p", { status: "ready", files: [{ name: "capped-1080p.mp4" }] }),
    });
    const fetchMock = stubElevenLabsFetch();

    await translateAudio(ASSET_ID, "fr", BASE_OPTIONS);

    expect(retrieve).toHaveBeenCalled();
    expect(createStaticRendition).not.toHaveBeenCalled();
    expect(dubbingSourceUrl(fetchMock)).toMatch(/\/playback-123\/capped-1080p\.mp4$/);
  });

  it("rejects an mp4_support file too large to dub before calling ElevenLabs", async () => {
    const { createStaticRendition, deleteStaticRendition } = mockMuxClient({
      initialAsset: legacyAsset("capped-1080p", { status: "ready", files: [{ name: "capped-1080p.mp4", filesize: "1500000000" }] }),
    });
    const fetchMock = stubElevenLabsFetch();

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", BASE_OPTIONS));

    expect(error).toMatchObject({ publicType: "validation_error", retryable: false });
    expect((error as Error).message).toContain("capped-1080p.mp4 static rendition (1.5 GB) is larger than the 1 GB");
    expect((error as Error).message).toContain("Static Renditions API");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createStaticRendition).not.toHaveBeenCalled();
    expect(deleteStaticRendition).not.toHaveBeenCalled();
  });

  it("fails errored mp4_support renditions without re-requesting them", async () => {
    const { createStaticRendition } = mockMuxClient({
      initialAsset: legacyAsset("audio-only", { status: "errored" }),
    });
    const fetchMock = stubElevenLabsFetch();

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", BASE_OPTIONS));

    expect(error).toMatchObject({ publicType: "validation_error" });
    expect((error as Error).message).toContain("static renditions are errored");
    expect(createStaticRendition).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("times out after 30 minutes of preparing mp4_support renditions", async () => {
    const { retrieve } = mockMuxClient({
      initialAsset: legacyAsset("capped-1080p", { status: "preparing" }),
    });
    stubElevenLabsFetch();

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", BASE_OPTIONS));

    expect(error).toMatchObject({ publicType: "timeout_error", retryable: true });
    expect(retrieve).toHaveBeenCalledTimes(180);
  });
});
