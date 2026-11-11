import { APICallError } from "ai";
import { describe, expect, it } from "vitest";

import { googleCallError, googleErrorFacts } from "../../src/lib/google-errors.ts";

function geminiError(statusCode: number, body?: unknown) {
  return new APICallError({
    message: "Gemini said no",
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent",
    requestBodyValues: {},
    statusCode,
    responseHeaders: { "x-request-id": "req-g" },
    responseBody: body === undefined ? undefined : JSON.stringify(body),
  });
}

const QUOTA_BODY = {
  error: {
    code: 429,
    message: "You exceeded your current quota. Free text that must not be kept.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "37s" },
    ],
  },
};

describe("googleErrorFacts", () => {
  it("keeps Google's status and the quota that ran out, never the message", () => {
    expect(googleErrorFacts(JSON.stringify(QUOTA_BODY))).toEqual({
      providerStatus: "RESOURCE_EXHAUSTED",
      quotaIds: ["GenerateRequestsPerDayPerProjectPerModel"],
    });
  });

  it("returns nothing for a body it can't read", () => {
    expect(googleErrorFacts(undefined)).toEqual({});
    expect(googleErrorFacts("<html>bad gateway</html>")).toEqual({});
    expect(googleErrorFacts(JSON.stringify({ error: { status: "not a token!" } }))).toEqual({});
  });
});

describe("googleCallError", () => {
  it("classifies a 429 as an upstream capacity failure, with Google's facts", () => {
    const error = googleCallError(geminiError(429, QUOTA_BODY), "translate_vtt failed (HTTP 429)", { call: "translate_vtt", facts: { provider: "google" } });

    expect(error).toMatchObject({
      type: "capacity_error",
      source: "upstream",
      dependency: "ai_provider",
      transient: true,
      retryable: true,
      facts: { call: "translate_vtt", status: 429, requestId: "req-g", provider: "google", providerStatus: "RESOURCE_EXHAUSTED" },
    });
  });

  it("treats a rejected request or API key as the service's own (internal)", () => {
    expect(googleCallError(geminiError(400, { error: { status: "INVALID_ARGUMENT" } }), "x", { call: "translate_vtt" })).toMatchObject({ source: "internal", type: "server_error", transient: false });
    expect(googleCallError(geminiError(403, { error: { status: "PERMISSION_DENIED" } }), "x", { call: "translate_vtt" })).toMatchObject({ source: "internal", transient: false });
  });

  it("treats an outage as upstream and transient", () => {
    expect(googleCallError(geminiError(503, { error: { status: "UNAVAILABLE" } }), "x", { call: "translate_vtt" })).toMatchObject({ source: "upstream", type: "processing_error", transient: true, facts: { providerStatus: "UNAVAILABLE" } });
  });
});
