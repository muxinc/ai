import { describe, expect, it } from "vitest";

import { elevenLabsFailureError, elevenLabsResponseFailure, elevenLabsSdkFailure, isRetryableElevenLabsStatus } from "../../src/lib/elevenlabs-errors";

function jsonResponse(body: unknown, status: number, statusText: string) {
  return new Response(JSON.stringify(body), { status, statusText });
}

describe("isRetryableElevenLabsStatus", () => {
  it.each([408, 425, 429, 500, 502, 503, 504])("retries %i", (status) => {
    expect(isRetryableElevenLabsStatus(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])("does not retry %i", (status) => {
    expect(isRetryableElevenLabsStatus(status)).toBe(false);
  });
});

describe("elevenLabsResponseFailure", () => {
  it("keeps the status, ElevenLabs' reason and the request ID for diagnostics", async () => {
    const failure = await elevenLabsResponseFailure(jsonResponse({
      detail: { status: "unsupported_target_language", code: "invalid_parameters", message: "Target language 'ur' is not supported.", request_id: "req-1", param: "target_language" },
    }, 400, "Bad Request"));

    expect(failure).toEqual({
      httpStatus: 400,
      reason: "unsupported_target_language",
      requestId: "req-1",
      retryable: false,
      detail: "400 Bad Request: unsupported_target_language: Target language 'ur' is not supported. (param: target_language, request_id: req-1)",
    });
  });

  it("marks rate limits, server errors and not-ready outputs retryable", async () => {
    await expect(elevenLabsResponseFailure(jsonResponse({ detail: "slow down" }, 429, "Too Many Requests"))).resolves.toMatchObject({ retryable: true, detail: "429 Too Many Requests: slow down" });
    await expect(elevenLabsResponseFailure(new Response("", { status: 503, statusText: "Service Unavailable" }))).resolves.toMatchObject({ retryable: true, detail: "503 Service Unavailable" });
    await expect(elevenLabsResponseFailure(jsonResponse({ detail: { status: "dubbing_not_ready", message: "Not ready." } }, 425, "Too Early"))).resolves.toMatchObject({ retryable: true, reason: "dubbing_not_ready" });
  });

  it("lists 422 field errors", async () => {
    const failure = await elevenLabsResponseFailure(jsonResponse({ detail: [{ loc: ["body", "target_language"], msg: "field required" }] }, 422, "Unprocessable Entity"));

    expect(failure).toMatchObject({ retryable: false, detail: "422 Unprocessable Entity: body.target_language: field required" });
    expect(failure.reason).toBeUndefined();
  });

  it("truncates a non-JSON body and falls back to the status line", async () => {
    const html = await elevenLabsResponseFailure(new Response(`<html>${"x".repeat(1000)}</html>`, { status: 502, statusText: "Bad Gateway" }));
    expect(html.detail.startsWith("502 Bad Gateway: <html>xxx")).toBe(true);
    expect(html.detail).not.toContain("</html>");

    await expect(elevenLabsResponseFailure(new Response(null, { status: 404 }))).resolves.toMatchObject({ detail: "404", retryable: false });
  });
});

describe("elevenLabsSdkFailure", () => {
  it("reads the status and body of an SDK HTTP error", () => {
    const error = Object.assign(new Error("Status code: 401"), {
      name: "ElevenLabsError",
      statusCode: 401,
      body: { detail: { status: "invalid_api_key", message: "Invalid API key" } },
      rawResponse: { statusText: "Unauthorized" },
    });

    expect(elevenLabsSdkFailure(error)).toEqual({
      httpStatus: 401,
      reason: "invalid_api_key",
      retryable: false,
      detail: "401 Unauthorized: invalid_api_key: Invalid API key",
    });
  });

  it.each([
    { name: "ElevenLabsTimeoutError", reason: "timeout", retryable: true },
    { name: "ElevenLabsError", reason: "network_error", retryable: true },
    // The API's response no longer matches the SDK, so retrying fails the same way.
    { name: "ParseError", reason: "unexpected_response", retryable: false },
    { name: "TypeError", reason: undefined, retryable: false },
  ])("classifies an SDK $name without a status", ({ name, reason, retryable }) => {
    const error = Object.assign(new Error("something went wrong"), { name });

    const failure = elevenLabsSdkFailure(error);
    expect(failure.reason).toBe(reason);
    expect(failure.retryable).toBe(retryable);
    expect(failure.httpStatus).toBeUndefined();
  });
});

describe("elevenLabsFailureError", () => {
  it("classifies by status and keeps the provider detail in facts, not the message", () => {
    const error = elevenLabsFailureError("Audio dubbing could not be started.", "elevenlabs_create_dubbing_project", {
      httpStatus: 401,
      reason: "invalid_api_key",
      requestId: "req-1",
      retryable: false,
      detail: "401 Unauthorized: invalid_api_key: Invalid API key",
    }, { assetId: "asset-1" });

    expect(error).toMatchObject({
      message: "Audio dubbing could not be started.",
      type: "server_error",
      source: "internal",
      dependency: "ai_provider",
      transient: false,
      retryable: false,
      facts: {
        call: "elevenlabs_create_dubbing_project",
        status: 401,
        requestId: "req-1",
        provider: "elevenlabs",
        providerCode: "invalid_api_key",
        detail: "401 Unauthorized: invalid_api_key: Invalid API key",
        assetId: "asset-1",
      },
    });
  });

  it("is never transient, since the workflow already retried, but keeps the failure's retryability", () => {
    expect(elevenLabsFailureError("x", "elevenlabs_get_dubbing_project", { httpStatus: 503, retryable: true, detail: "503" }))
      .toMatchObject({ type: "processing_error", source: "upstream", transient: false, retryable: true, name: "FatalError" });
    expect(elevenLabsFailureError("x", "elevenlabs_get_dubbing_project", { httpStatus: 429, retryable: true, detail: "429" }))
      .toMatchObject({ type: "capacity_error", source: "upstream", transient: false, retryable: true });
    expect(elevenLabsFailureError("x", "elevenlabs_create_dubbing_project", { reason: "timeout", retryable: true, detail: "timed out" }))
      .toMatchObject({ type: "timeout_error", source: "upstream", transient: false, retryable: true });
    expect(elevenLabsFailureError("x", "elevenlabs_create_dubbing_project", { reason: "unexpected_response", retryable: false, detail: "bad shape" }))
      .toMatchObject({ source: "upstream", transient: false, retryable: false });
  });

  it("strips signed URL tokens from the detail", () => {
    const error = elevenLabsFailureError("x", "elevenlabs_get_dubbed_audio", {
      reason: "network_error",
      retryable: true,
      detail: "Failed to fetch https://storage.example.test/out.flac?X-Signature=SECRET",
    });

    expect(JSON.stringify(error.facts)).not.toContain("SECRET");
  });
});
