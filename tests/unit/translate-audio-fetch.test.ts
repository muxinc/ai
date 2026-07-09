import { afterEach, describe, expect, it, vi } from "vitest";

import { MuxAiError } from "../../src/lib/mux-ai-error";
import { fetchAudioFromMux } from "../../src/workflows/translate-audio";

const AUDIO_URL = "https://stream.mux.com/playback/audio.m4a";

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () => new ArrayBuffer(8),
  } as unknown as Response;
}

function errorResponse(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchAudioFromMux", () => {
  it("throws a MuxAiError carrying the HTTP status code and does not retry 4xx", async () => {
    const fetchMock = vi.fn(async () => errorResponse(403, "Forbidden"));
    vi.stubGlobal("fetch", fetchMock);

    const error = await fetchAudioFromMux(AUDIO_URL).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MuxAiError);
    expect((error as MuxAiError).message).toContain("HTTP 403 Forbidden");
    expect((error as MuxAiError).retryable).toBe(false);
    // 4xx responses won't self-resolve, so we must not retry them.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("includes the status even when statusText is empty (e.g. a bare 403)", async () => {
    const fetchMock = vi.fn(async () => errorResponse(403, ""));
    vi.stubGlobal("fetch", fetchMock);

    const error = await fetchAudioFromMux(AUDIO_URL).catch((e: unknown) => e);

    expect((error as MuxAiError).message).toContain("HTTP 403");
    expect((error as MuxAiError).message).not.toContain("Unknown error");
  });

  it("normalizes a thrown non-Error value into a MuxAiError with a real detail", async () => {
    const fetchMock = vi.fn(async () => {
      throw "ECONNRESET"; // eslint-disable-line no-throw-literal
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await fetchAudioFromMux(AUDIO_URL).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MuxAiError);
    expect((error as MuxAiError).message).toContain("ECONNRESET");
    expect((error as MuxAiError).message).not.toContain("Unknown error");
  });

  it("surfaces a timeout as a distinct, retryable timeout error", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    const fetchMock = vi.fn(async () => {
      throw abortError;
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await fetchAudioFromMux(AUDIO_URL).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MuxAiError);
    expect((error as MuxAiError).message).toContain("timed out");
    expect((error as MuxAiError).publicType).toBe("timeout_error");
    expect((error as MuxAiError).retryable).toBe(true);
  });

  it("retries transient 5xx failures and eventually succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(503, "Service Unavailable"))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAudioFromMux(AUDIO_URL);

    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
