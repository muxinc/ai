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

function stubElevenLabsFetch({ dubbingStatus = "completed" }: { dubbingStatus?: string } = {}) {
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/v1/dubbing/project") && init?.method === "POST") {
      return new Response(JSON.stringify(dubbingProject()), { status: 200 });
    }
    if (url.endsWith("/v1/dubbing/project/proj_1")) {
      return new Response(JSON.stringify(dubbingProject()));
    }
    if (url.endsWith("/v1/dubbing/project/proj_1/language/lang_1")) {
      return new Response(
        JSON.stringify(dubbingLanguage({ status: dubbingStatus })),
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
    expect(result.dubbingId).toBe("proj_1");
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

    expect(error).toMatchObject({ publicMessage: "Audio dubbing failed." });
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

    expect(result.dubbingId).toBe("proj_1");
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
    if (String(input).endsWith("/v1/dubbing/project") && init?.method === "POST") {
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

  it.each([
    { target: "pt-BR", source: "en_US", providerTarget: "pt", providerSource: "en", requestedTag: "pt-br" },
    { target: "mr-in", source: "zh-Hant-TW", providerTarget: "mr", providerSource: "zh", requestedTag: "mr-in" },
    { target: "zh-Hant", source: "pt_BR", providerTarget: "zh", providerSource: "pt", requestedTag: "zh-hant" },
  ])("sends the base language for $target while preserving the requested result tag", async ({ target, source, providerTarget, providerSource, requestedTag }) => {
    const fetchMock = stubElevenLabsFetch();
    const result = await translateAudio(ASSET_ID, target, { ...BASE_OPTIONS, fromLanguageCode: source });
    const create = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/v1/dubbing/project") && init?.method === "POST")!;
    const form = create[1].body as FormData;
    expect(form.get("target_language")).toBe(providerTarget);
    expect(form.get("source_language")).toBe(providerSource);
    expect(result.targetLanguageCode).toBe(requestedTag);
  });
});

const TEMPORARILY_UNAVAILABLE = "The dubbing service is temporarily unavailable. Please try again.";

function expectCustomerError(error: unknown, expected: { type: string; message: string; retryable: boolean }) {
  expect(MuxAiError.is(error)).toBe(true);
  expect(error).toMatchObject({ publicType: expected.type, publicMessage: expected.message, retryable: expected.retryable });
}

function jsonError(detail: unknown, status: number, statusText: string) {
  return new Response(JSON.stringify({ detail }), { status, statusText });
}

describe("translateAudio ElevenLabs project creation failures", () => {
  beforeEach(() => {
    mockMuxClient({ initialAsset: readyRenditionAsset("rendition-pre-existing") });
  });

  it.each([
    {
      name: "unsupported target language",
      response: () => jsonError(UNSUPPORTED_LANGUAGE_BODY.detail, 400, "Bad Request"),
      expected: { type: "validation_error", message: "Audio dubbing does not support the target language \"ur\".", retryable: false },
      logged: "400 Bad Request: unsupported_target_language: Target language 'ur' is not supported. (param: target_lang, request_id: ce841eacec9f38158a9ef2f4b66b0940)",
    },
    {
      name: "invalid API key",
      response: () => jsonError({ status: "invalid_api_key", message: "Invalid API key" }, 401, "Unauthorized"),
      expected: { type: "processing_error", message: "Audio dubbing could not be started.", retryable: false },
      logged: "401 Unauthorized: invalid_api_key: Invalid API key",
    },
    {
      // Needs someone to raise the quota, so a customer retry cannot fix it.
      name: "exhausted quota",
      response: () => jsonError({ status: "quota_exceeded", message: "This request exceeds your quota." }, 401, "Unauthorized"),
      expected: { type: "processing_error", message: "Audio dubbing could not be started.", retryable: false },
      logged: "401 Unauthorized: quota_exceeded: This request exceeds your quota.",
    },
    {
      name: "422 field errors",
      response: () => jsonError([{ loc: ["body", "target_language"], msg: "field required", type: "missing" }], 422, "Unprocessable Entity"),
      expected: { type: "processing_error", message: "Audio dubbing could not be started.", retryable: false },
      logged: "422 Unprocessable Entity: body.target_language: field required",
    },
    {
      name: "rate limit",
      response: () => jsonError({ status: "too_many_concurrent_requests", message: "Too many concurrent requests." }, 429, "Too Many Requests"),
      expected: { type: "processing_error", message: `Audio dubbing could not be started. ${TEMPORARILY_UNAVAILABLE}`, retryable: true },
      logged: "429 Too Many Requests: too_many_concurrent_requests: Too many concurrent requests.",
    },
    {
      // Robots used to classify 500 and 502 as non-retryable from their status text alone.
      name: "500",
      response: () => jsonError({ status: "internal_error", message: "Internal error." }, 500, "Internal Server Error"),
      expected: { type: "processing_error", message: `Audio dubbing could not be started. ${TEMPORARILY_UNAVAILABLE}`, retryable: true },
      logged: "500 Internal Server Error: internal_error: Internal error.",
    },
    {
      name: "502 with a non-JSON body",
      response: () => new Response(`<html>${"x".repeat(1000)}</html>`, { status: 502, statusText: "Bad Gateway" }),
      expected: { type: "processing_error", message: `Audio dubbing could not be started. ${TEMPORARILY_UNAVAILABLE}`, retryable: true },
      logged: "502 Bad Gateway: <html>xxx",
    },
  ])("maps a $name to a customer-safe error and logs the provider detail", async ({ response, expected, logged }) => {
    const fetchMock = stubElevenLabsCreateFailure(response());

    const error = await captureRejection(translateAudio(ASSET_ID, "ur", BASE_OPTIONS));

    expectCustomerError(error, expected);
    // Creation is paid, so it is never retried automatically.
    expect(fetchMock).toHaveBeenCalledOnce();
    const warnings = vi.mocked(console.warn).mock.calls.map(([message]) => String(message));
    expect(warnings.some(message => message.includes(logged))).toBe(true);
    expect(warnings.some(message => message.includes("</html>"))).toBe(false);
  });

  it("names an unsupported source language the caller asked for", async () => {
    stubElevenLabsCreateFailure(jsonError(
      { status: "unsupported_source_language", message: "Source language 'ak' is not supported for transcription.", param: "source_language" },
      400,
      "Bad Request",
    ));

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", { ...BASE_OPTIONS, fromLanguageCode: "ak" }));

    expectCustomerError(error, { type: "validation_error", message: "Audio dubbing does not support the source language \"ak\".", retryable: false });
  });

  it("treats a create with no response as retryable and logs that it may have been billed", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", BASE_OPTIONS));

    expectCustomerError(error, { type: "processing_error", message: `Audio dubbing could not be started. ${TEMPORARILY_UNAVAILABLE}`, retryable: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("The project may have been created; check ElevenLabs before retrying."));
  });
});

/** Answers creation, then serves status responses in order (the last one repeats). */
function stubStatusResponses(statusResponses: Array<() => Response>) {
  let call = 0;
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/v1/dubbing/project") && init?.method === "POST") {
      return new Response(JSON.stringify(dubbingProject()), { status: 200 });
    }
    if (url.endsWith("/v1/dubbing/project/proj_1")) {
      const respond = statusResponses[Math.min(call, statusResponses.length - 1)];
      call++;
      return respond();
    }
    if (url.endsWith("/v1/dubbing/project/proj_1/language/lang_1")) {
      return new Response(JSON.stringify(dubbingLanguage()), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const STATUS_500 = () => jsonError({ status: "internal_error", message: "Internal error." }, 500, "Internal Server Error");

describe("translateAudio ElevenLabs status check failures", () => {
  beforeEach(() => {
    mockMuxClient({ initialAsset: readyRenditionAsset("rendition-pre-existing") });
  });

  it("fails without retrying when the project no longer exists", async () => {
    stubStatusResponses([() => jsonError({ status: "dubbing_not_found", message: "Dubbing project not found." }, 404, "Not Found")]);

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", BASE_OPTIONS));

    expectCustomerError(error, { type: "processing_error", message: "Could not check audio dubbing progress.", retryable: false });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("404 Not Found: dubbing_not_found: Dubbing project not found."));
  });

  it("keeps polling through a transient failure", async () => {
    stubStatusResponses([STATUS_500, STATUS_500, () => new Response(JSON.stringify(dubbingProject()), { status: 200 })]);

    const result = await translateAudio(ASSET_ID, "fr", BASE_OPTIONS);

    expect(result.dubbingId).toBe("proj_1");
  });

  it("fails as retryable once transient failures persist", async () => {
    const fetchMock = stubStatusResponses([STATUS_500]);

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", BASE_OPTIONS));

    expectCustomerError(error, { type: "processing_error", message: `Could not check audio dubbing progress. ${TEMPORARILY_UNAVAILABLE}`, retryable: true });
    const statusChecks = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/v1/dubbing/project/proj_1"));
    expect(statusChecks).toHaveLength(6);
  });
});

describe("translateAudio failed dubs", () => {
  beforeEach(() => {
    mockMuxClient({ initialAsset: readyRenditionAsset("rendition-pre-existing") });
  });

  function stubFailedDub(error: unknown) {
    stubStatusResponses([() => new Response(JSON.stringify(dubbingProject({ status: "failed", error })), { status: 200 })]);
  }

  it("passes on ElevenLabs' display message and retryability", async () => {
    stubFailedDub({ code: "source_download_failed", message: "The source media could not be downloaded from the provided URL.", retryable: true });

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", BASE_OPTIONS));

    expectCustomerError(error, {
      type: "processing_error",
      message: "Audio dubbing failed: The source media could not be downloaded from the provided URL. Please try again.",
      retryable: true,
    });
    expect(console.warn).toHaveBeenCalledWith("❌ ElevenLabs dubbing project proj_1 (language lang_1) failed: source_download_failed: The source media could not be downloaded from the provided URL.");
  });

  it("does not invite a retry ElevenLabs says cannot succeed", async () => {
    // Illustrative code: ElevenLabs does not publish a list of failure codes.
    stubFailedDub({ code: "no_speech_detected", message: "No speech was detected in the source media.", retryable: false });

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", BASE_OPTIONS));

    expectCustomerError(error, { type: "processing_error", message: "Audio dubbing failed: No speech was detected in the source media.", retryable: false });
  });

  it("reports a failure without a reason as not retryable", async () => {
    stubFailedDub(null);

    const error = await captureRejection(translateAudio(ASSET_ID, "fr", BASE_OPTIONS));

    expectCustomerError(error, { type: "processing_error", message: "Audio dubbing failed.", retryable: false });
  });
});

function legacyAsset(mp4Support: string, staticRenditions?: object) {
  return { ...buildAsset(staticRenditions), mp4_support: mp4Support };
}

function dubbingSourceUrl(fetchMock: ReturnType<typeof vi.fn>): string | undefined {
  const createCall = fetchMock.mock.calls.find(([input, init]) =>
    String(input).endsWith("/v1/dubbing/project") && init?.method === "POST");
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

describe("translateAudio project API", () => {
  beforeEach(() => {
    mockMuxClient({ initialAsset: readyRenditionAsset("existing") });
  });

  it("pins v1, queues the first target, and preserves source-language aliases", async () => {
    const fetchMock = stubElevenLabsFetch();
    const result = await translateAudio(ASSET_ID, "fra", { ...BASE_OPTIONS, fromLanguageCode: "eng" });
    const create = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    const form = create[1].body as FormData;
    expect(form.get("model_id")).toBe("dubbing_v1");
    expect(form.get("target_language")).toBe("fr");
    expect(form.get("source_language")).toBe("en");
    expect(form.has("num_speakers")).toBe(false);
    expect(result).toMatchObject({ dubbingId: "proj_1", targetLanguageCode: "fr", targetLanguage: { iso639_1: "fr", iso639_3: "fra" } });
  });

  it("does not mistake a ready project for a completed language target", async () => {
    stubElevenLabsFetch({ dubbingStatus: "queued" });
    await expect(translateAudio(ASSET_ID, "fr", { ...BASE_OPTIONS, dubbingPollTimeoutSeconds: 1 }))
      .rejects
      .toMatchObject({ publicType: "timeout_error" });
  });

  it.each([
    { input: "yue", tag: "yue", iso3: "yue" },
    { input: "urd", tag: "ur", iso3: "urd" },
    { input: "hye", tag: "hy", iso3: "hye" },
  ])("sends $input as $tag and preserves result language metadata", async ({ input, tag, iso3 }) => {
    const fetchMock = stubElevenLabsFetch();
    const result = await translateAudio(ASSET_ID, input, BASE_OPTIONS);
    const create = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect((create[1].body as FormData).get("target_language")).toBe(tag);
    expect(result).toMatchObject({ targetLanguageCode: tag, targetLanguage: { iso639_1: tag, iso639_3: iso3 } });
  });

  it("lets ElevenLabs reject an unsupported base language without retrying creation", async () => {
    const fetchMock = stubElevenLabsCreateFailure(new Response(
      JSON.stringify({ detail: { status: "unsupported_target_language", message: "Unsupported target language" } }),
      { status: 400, statusText: "Bad Request" },
    ));
    await expect(translateAudio(ASSET_ID, "eu", BASE_OPTIONS)).rejects.toMatchObject({
      publicType: "validation_error",
      publicMessage: "Audio dubbing does not support the target language \"eu\".",
    });
    expect(getPlaybackIdForAsset).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0][1].body as FormData).get("target_language")).toBe("eu");
  });

  it.each([
    { input: undefined, expected: null },
    { input: " AUTO ", expected: null },
    { input: "", expected: null },
    { input: "hye", expected: "hy" },
    { input: "ak", expected: "ak" },
  ])("sends the correct source-language hint for $input", async ({ input, expected }) => {
    const fetchMock = stubElevenLabsFetch();
    await translateAudio(ASSET_ID, "fr", { ...BASE_OPTIONS, fromLanguageCode: input });
    const create = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect((create[1].body as FormData).get("source_language")).toBe(expected);
  });

  it("rejects speaker-count overrides before requesting media or creating a paid project", async () => {
    const fetchMock = stubElevenLabsFetch();
    await expect(translateAudio(ASSET_ID, "fr", { ...BASE_OPTIONS, numSpeakers: 2 }))
      .rejects
      .toMatchObject({ publicType: "validation_error", publicMessage: expect.stringContaining("numSpeakers") });
    expect(getPlaybackIdForAsset).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry an ambiguous paid create inside the SDK", async () => {
    const fetchMock = stubElevenLabsCreateFailure(new Response("upstream unavailable", { status: 503 }));
    await expect(translateAudio(ASSET_ID, "fr", BASE_OPTIONS)).rejects.toMatchObject({ retryable: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
