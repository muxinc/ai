import { describe, expect, it } from "vitest";

import { elevenLabsResponseError, isRetryableElevenLabsStatus } from "../../src/lib/elevenlabs-errors";
import { MuxAiError } from "../../src/lib/mux-ai-error";

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

describe("elevenLabsResponseError", () => {
  it("classifies a rejected request as a fatal ai_provider error with the reason in facts", async () => {
    const error = await elevenLabsResponseError(
      "ElevenLabs API error",
      jsonResponse({ detail: { status: "unsupported_target_language", message: "Target language 'ur' is not supported.", request_id: "req_1" } }, 400, "Bad Request"),
      { call: "elevenlabs_create_dubbing", facts: { targetLanguage: "ur" } },
    );

    expect(MuxAiError.is(error)).toBe(true);
    expect(error.name).toBe("FatalError");
    expect(error.message).toBe("ElevenLabs API error (HTTP 400)");
    expect(error.type).toBe("server_error");
    expect(error.source).toBe("internal");
    expect(error.dependency).toBe("ai_provider");
    expect(error.transient).toBe(false);
    expect(error.facts).toEqual({
      call: "elevenlabs_create_dubbing",
      status: 400,
      requestId: "req_1",
      provider: "elevenlabs",
      providerCode: "unsupported_target_language",
      detail: "Target language 'ur' is not supported.",
      targetLanguage: "ur",
    });
  });

  it("leaves rate limits and server errors transient", async () => {
    const rateLimited = await elevenLabsResponseError("ElevenLabs API error", jsonResponse({ detail: "slow down" }, 429, "Too Many Requests"));
    const unavailable = await elevenLabsResponseError("ElevenLabs API error", new Response("", { status: 503, statusText: "Service Unavailable" }));

    expect(rateLimited.name).toBe("Error");
    expect(rateLimited.transient).toBe(true);
    expect(rateLimited.source).toBe("upstream");
    expect(rateLimited.type).toBe("capacity_error");
    expect(rateLimited.facts.detail).toBe("slow down");
    expect(unavailable.name).toBe("Error");
    expect(unavailable.type).toBe("processing_error");
    expect(unavailable.message).toBe("ElevenLabs API error (HTTP 503)");
    expect(unavailable.facts.detail).toBeUndefined();
  });

  it("leaves a dub that is not ready to download yet (425) transient", async () => {
    const error = await elevenLabsResponseError(
      "Failed to fetch dubbed audio",
      jsonResponse({ detail: { status: "dubbing_not_ready", message: "Dubbing not ready." } }, 425, "Too Early"),
    );

    expect(error.name).toBe("Error");
    expect(error.transient).toBe(true);
    expect(error.facts.providerCode).toBe("dubbing_not_ready");
  });

  it("treats a rejected API key as our own (internal) problem", async () => {
    const error = await elevenLabsResponseError("ElevenLabs API error", jsonResponse({ detail: "bad key" }, 401, "Unauthorized"));

    expect(error.name).toBe("FatalError");
    expect(error.source).toBe("internal");
    expect(error.facts.provider).toBe("elevenlabs");
  });

  it("keeps the message to the status when there is no body", async () => {
    const error = await elevenLabsResponseError("Status check failed", new Response(null, { status: 404 }));

    expect(error.message).toBe("Status check failed (HTTP 404)");
    expect(error.facts).toEqual({ call: "elevenlabs_request", status: 404, provider: "elevenlabs" });
  });
});
