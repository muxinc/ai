import { APICallError } from "ai";
import { describe, expect, it } from "vitest";

import { modelStepError } from "../../src/lib/content-policy-error";
import { openAICallError, parseOpenAIErrorBody } from "../../src/lib/openai-errors";

// Bodies shaped as OpenAI's error codes guide shows them: { error: { message, type, param, code } }.
function openAIError(statusCode: number | undefined, error?: { code?: string | null; type?: string }) {
  return new APICallError({
    message: "OpenAI says something about https://example.test/?sig=SECRET",
    url: "https://api.openai.com/v1/responses",
    requestBodyValues: {},
    statusCode,
    responseHeaders: { "x-request-id": "req_123" },
    responseBody: error ? JSON.stringify({ error: { message: "free text", param: null, ...error } }) : undefined,
    isRetryable: statusCode === undefined || statusCode === 429 || statusCode >= 500,
  });
}

const facts = { call: "detect_burned_in_captions", provider: "openai", model: "gpt-test" };

describe("parseOpenAIErrorBody", () => {
  it("reads OpenAI's code and type, only as tokens", () => {
    expect(parseOpenAIErrorBody(JSON.stringify({ error: { code: "slow_down", type: "rate_limit_error" } }))).toEqual({ code: "slow_down", type: "rate_limit_error" });
    expect(parseOpenAIErrorBody(JSON.stringify({ error: { code: null, type: "server_error" } }))).toEqual({ type: "server_error" });
    expect(parseOpenAIErrorBody(JSON.stringify({ error: { code: "not a token" } }))).toEqual({});
    expect(parseOpenAIErrorBody("Bad Gateway")).toEqual({});
    expect(parseOpenAIErrorBody(undefined)).toEqual({});
  });
});

describe("openAICallError", () => {
  it.each([
    ["insufficient_quota", "insufficient_quota"],
    ["credit_balance_exhausted", "insufficient_quota"],
    ["organization_spend_limit_exceeded", "insufficient_quota"],
    ["project_spend_limit_exceeded", "insufficient_quota"],
    ["organization_usage_limit_exceeded", "insufficient_quota"],
  ])("doesn't retry a spent quota or spend limit, although it's a 429 (%s)", (code, type) => {
    expect(openAICallError(openAIError(429, { code, type }), "x", { call: "c" })).toMatchObject({
      code: "provider_quota_exhausted",
      type: "server_error",
      source: "internal",
      transient: false,
      retryable: false,
      facts: { status: 429, providerCode: code },
    });
  });

  it("reads a billing error's type when it has no code", () => {
    expect(openAICallError(openAIError(429, { type: "insufficient_quota" }), "x", { call: "c" })).toMatchObject({ code: "provider_quota_exhausted", facts: { providerCode: "insufficient_quota" } });
  });

  it.each(["slow_down", "rate_limit_exceeded"])("retries a rate limit (%s)", (code) => {
    expect(openAICallError(openAIError(429, { code, type: "requests" }), "x", { call: "c" })).toMatchObject({ code: "provider_rate_limited", type: "capacity_error", source: "upstream", transient: true });
  });

  it.each(["server_is_overloaded", "service_unavailable_error"])("retries an overload (%s)", (code) => {
    expect(openAICallError(openAIError(503, { code }), "x", { call: "c" })).toMatchObject({ code: "provider_unavailable", type: "capacity_error", source: "upstream", transient: true });
  });

  it("calls a 401 the service's own credentials", () => {
    expect(openAICallError(openAIError(401, { code: "invalid_api_key", type: "invalid_request_error" }), "x", { call: "c" })).toMatchObject({
      code: "provider_credentials_rejected",
      source: "internal",
      transient: false,
      facts: { providerCode: "invalid_api_key" },
    });
  });

  it.each([
    [429, undefined, "dependency_rate_limited", true],
    [500, { type: "server_error" }, "dependency_server_error", true],
    [400, { code: "invalid_value", type: "invalid_request_error" }, "dependency_request_rejected", false],
    [403, undefined, "dependency_auth_rejected", false],
    [404, { code: "model_not_found" }, "dependency_not_found", false],
    // Not in OpenAI's guide, so fatal by default, though the AI SDK would retry it.
    [409, undefined, "dependency_request_rejected", false],
    [undefined, undefined, "dependency_no_response", true],
  ] as const)("falls back to the status for anything no rule names (%s)", (status, error, code, transient) => {
    expect(openAICallError(openAIError(status, error), "x", { call: "c" })).toMatchObject({ code, transient });
  });

  it("keeps OpenAI's free text out of facts, and its request id in", () => {
    const error = openAICallError(openAIError(429, { code: "insufficient_quota" }), "x", { call: "c" });

    expect(error.facts).toMatchObject({ call: "c", requestId: "req_123" });
    expect(JSON.stringify(error.facts)).not.toMatch(/free text|SECRET/);
  });
});

describe("openAI model calls", () => {
  it("are classified with the call's facts and usage", () => {
    const raw = openAIError(429, { code: "insufficient_quota", type: "insufficient_quota" });

    expect(modelStepError(raw, "Detection failed", facts)).toMatchObject({
      code: "provider_quota_exhausted",
      dependency: "ai_provider",
      transient: false,
      name: "FatalError",
      facts: { ...facts, status: 429, providerCode: "insufficient_quota" },
    });
  });
});
