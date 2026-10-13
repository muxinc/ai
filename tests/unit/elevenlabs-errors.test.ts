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
  it("marks a rejected request as fatal so Workflow DevKit does not retry the step", async () => {
    const error = await elevenLabsResponseError(
      "ElevenLabs API error",
      jsonResponse({ detail: { status: "unsupported_target_language", message: "Target language 'ur' is not supported." } }, 400, "Bad Request"),
    );

    expect(error.name).toBe("FatalError");
    expect(error.message).toBe("ElevenLabs API error: 400 Bad Request: unsupported_target_language: Target language 'ur' is not supported.");
  });

  it("leaves rate limits and server errors retryable", async () => {
    const rateLimited = await elevenLabsResponseError("ElevenLabs API error", jsonResponse({ detail: "slow down" }, 429, "Too Many Requests"));
    const unavailable = await elevenLabsResponseError("ElevenLabs API error", new Response("", { status: 503, statusText: "Service Unavailable" }));

    expect(rateLimited.name).toBe("Error");
    expect(rateLimited.message).toBe("ElevenLabs API error: 429 Too Many Requests: slow down");
    expect(unavailable.name).toBe("Error");
    expect(unavailable.message).toBe("ElevenLabs API error: 503 Service Unavailable");
  });

  it("leaves a dub that is not ready to download yet (425) retryable", async () => {
    const error = await elevenLabsResponseError(
      "Failed to fetch dubbed audio",
      jsonResponse({ detail: { status: "dubbing_not_ready", message: "Dubbing not ready." } }, 425, "Too Early"),
    );

    expect(error.name).toBe("Error");
    expect(error.message).toBe("Failed to fetch dubbed audio: 425 Too Early: dubbing_not_ready: Dubbing not ready.");
  });

  it("is never a customer-safe MuxAiError, even when fatal", async () => {
    const error = await elevenLabsResponseError("ElevenLabs API error", jsonResponse({ detail: "bad key" }, 401, "Unauthorized"));

    expect(error.name).toBe("FatalError");
    expect(MuxAiError.is(error)).toBe(false);
  });

  it("falls back to the status line when there is no status text or body", async () => {
    const error = await elevenLabsResponseError("Status check failed", new Response(null, { status: 404 }));

    expect(error.message).toBe("Status check failed: 404");
  });
});
