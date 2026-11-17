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
      providerCode: "RESOURCE_EXHAUSTED",
      quotaIds: ["GenerateRequestsPerDayPerProjectPerModel"],
    });
  });

  it("prefers the newer snake_case error code as providerCode", () => {
    expect(googleErrorFacts(JSON.stringify({ error: { code: "quota_exceeded", message: "free text" } }))).toEqual({ providerCode: "quota_exceeded" });
  });

  it("returns nothing for a body it can't read", () => {
    expect(googleErrorFacts(undefined)).toEqual({});
    expect(googleErrorFacts("<html>bad gateway</html>")).toEqual({});
    expect(googleErrorFacts(JSON.stringify({ error: { status: "not a token!" } }))).toEqual({});
  });
});

describe("googleCallError", () => {
  it("doesn't retry a spent per-day quota, although it's a 429", () => {
    const error = googleCallError(geminiError(429, QUOTA_BODY), "translate_vtt failed (HTTP 429)", { call: "translate_vtt", facts: { provider: "google" } });

    expect(error).toMatchObject({
      code: "provider_quota_exhausted",
      type: "server_error",
      source: "internal",
      dependency: "ai_provider",
      transient: false,
      retryable: false,
      facts: { call: "translate_vtt", status: 429, requestId: "req-g", provider: "google", providerStatus: "RESOURCE_EXHAUSTED", quotaIds: ["GenerateRequestsPerDayPerProjectPerModel"] },
    });
  });

  it("reads a per-day quota from the newer error code too", () => {
    expect(googleCallError(geminiError(429, { error: { code: "quota_exceeded" } }), "x", { call: "c" })).toMatchObject({ code: "provider_quota_exhausted", transient: false });
  });

  it.each([
    ["a per-minute quota", { error: { status: "RESOURCE_EXHAUSTED", details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel" }] }] } }],
    ["a 429 without quota details", { error: { status: "RESOURCE_EXHAUSTED" } }],
    ["no body", undefined],
  ])("retries a rate limit (%s)", (_, body) => {
    expect(googleCallError(geminiError(429, body), "x", { call: "c" })).toMatchObject({ code: "provider_rate_limited", type: "capacity_error", source: "upstream", transient: true, retryable: true });
  });

  it("doesn't retry a spent prepaid balance (402)", () => {
    expect(googleCallError(geminiError(402, { error: { code: "payment_required" } }), "x", { call: "c" })).toMatchObject({ code: "provider_quota_exhausted", transient: false, retryable: false, facts: { providerCode: "payment_required" } });
  });

  it.each([401, 403])("calls a %s the service's own key or account", (status) => {
    expect(googleCallError(geminiError(status, { error: { status: "PERMISSION_DENIED" } }), "x", { call: "c" })).toMatchObject({ code: "provider_credentials_rejected", source: "internal", transient: false });
  });

  it("codes DEADLINE_EXCEEDED as a timeout and retries it", () => {
    expect(googleCallError(geminiError(504, { error: { status: "DEADLINE_EXCEEDED" } }), "x", { call: "c" })).toMatchObject({ code: "dependency_timeout", type: "timeout_error", transient: true });
  });

  it("treats a rejected request as the service's own (internal), by its status", () => {
    expect(googleCallError(geminiError(400, { error: { status: "INVALID_ARGUMENT" } }), "x", { call: "translate_vtt" })).toMatchObject({ code: "dependency_request_rejected", source: "internal", type: "server_error", transient: false });
    expect(googleCallError(geminiError(400, { error: { status: "FAILED_PRECONDITION" } }), "x", { call: "translate_vtt" })).toMatchObject({ code: "dependency_request_rejected", transient: false });
  });

  it("codes an overload as provider_unavailable and retries it", () => {
    expect(googleCallError(geminiError(503, { error: { status: "UNAVAILABLE" } }), "x", { call: "translate_vtt" })).toMatchObject({ code: "provider_unavailable", source: "upstream", type: "capacity_error", transient: true, facts: { providerStatus: "UNAVAILABLE" } });
  });

  it("falls back to the status for a 500", () => {
    expect(googleCallError(geminiError(500, { error: { status: "INTERNAL" } }), "x", { call: "translate_vtt" })).toMatchObject({ code: "dependency_server_error", transient: true });
  });
});
