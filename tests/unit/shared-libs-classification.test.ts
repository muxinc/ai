import { APICallError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getGeneratedOutputWithContentPolicyHandling,
  withContentPolicyErrorHandling,
} from "../../src/lib/content-policy-error.ts";
import { MuxAiError } from "../../src/lib/mux-ai-error.ts";
import { toPublicError } from "../../src/lib/public-error.ts";
import { resolveRenderableVideoScope, resolveWorkflowScope } from "../../src/lib/workflow-scope.ts";
import { fetchTranscriptDataForUrl } from "../../src/primitives/transcripts.ts";

const context = { call: "generate_summary", provider: "openai", model: "gpt-test" };

function apiCallError(statusCode: number) {
  return new APICallError({
    message: "provider detail",
    url: "https://example.com/v1/responses",
    requestBodyValues: {},
    statusCode,
    responseHeaders: { "x-request-id": "req-123" },
    responseBody: "{}",
  });
}

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("model calls", () => {
  it("leaves raw provider errors alone without a call context", async () => {
    const raw = apiCallError(429);
    await expect(withContentPolicyErrorHandling(() => Promise.reject(raw))).rejects.toBe(raw);
  });

  it("classifies provider API failures by status with a call context", async () => {
    const limited = await withContentPolicyErrorHandling(() => Promise.reject(apiCallError(429)), context).catch(e => e);
    expect(MuxAiError.is(limited)).toBe(true);
    expect(limited).toMatchObject({
      type: "capacity_error",
      source: "upstream",
      dependency: "ai_provider",
      transient: true,
      retryable: true,
      facts: { call: "generate_summary", provider: "openai", model: "gpt-test", status: 429, requestId: "req-123" },
    });

    // Our own key and request shape: not the caller's, and not worth repeating.
    const rejected = await withContentPolicyErrorHandling(() => Promise.reject(apiCallError(401)), context).catch(e => e);
    expect(rejected).toMatchObject({ type: "server_error", source: "internal", transient: false, retryable: false });
  });

  it("names the call on content-policy refusals", () => {
    const error = capture(() => getGeneratedOutputWithContentPolicyHandling({ finishReason: "content-filter", rawFinishReason: "SAFETY", output: undefined }, context));
    expect(error).toMatchObject({
      code: "content_policy_blocked",
      type: "content_policy_error",
      source: "asset",
      facts: { call: "generate_summary", provider: "openai", reason: "SAFETY" },
    });
    expect(toPublicError(error as MuxAiError)).toEqual({
      type: "content_policy_error",
      code: "content_policy_blocked",
      message: "The content was blocked by a content policy (reason: SAFETY).",
      retryable: false,
      facts: { reason: "SAFETY" },
    });
  });

  it("raises model_output_missing for a stop without output only with a call context", () => {
    expect(getGeneratedOutputWithContentPolicyHandling({ finishReason: "stop", output: undefined })).toBeUndefined();
    expect(capture(() => getGeneratedOutputWithContentPolicyHandling({ finishReason: "stop", output: undefined }, context))).toMatchObject({
      code: "model_output_missing",
      facts: { call: "generate_summary" },
      transient: true,
    });
  });

  it("keeps the incomplete-generation retry policy", () => {
    expect(capture(() => getGeneratedOutputWithContentPolicyHandling({ finishReason: "length", output: undefined }))).toMatchObject({
      code: "model_output_truncated",
      source: "internal",
      retryable: false,
      transient: false,
    });
    expect(capture(() => getGeneratedOutputWithContentPolicyHandling({ finishReason: "error", output: undefined }))).toMatchObject({
      code: "model_output_incomplete",
      source: "upstream",
      retryable: true,
      transient: false,
    });
  });
});

describe("workflow scope", () => {
  it("keeps the asset and range facts end users saw before", () => {
    const duration = capture(() => resolveWorkflowScope(undefined, undefined)) as MuxAiError;
    expect(toPublicError(duration)).toMatchObject({ type: "validation_error", code: "asset_duration_unavailable", message: "The asset has no valid duration." });

    const exceeds = capture(() => resolveWorkflowScope({ endTime: 90 }, 60)) as MuxAiError;
    expect(toPublicError(exceeds)).toMatchObject({
      code: "invalid_scope",
      message: "The requested end time (90s) is after the end of the asset (60s).",
    });

    const noVideo = capture(() => resolveRenderableVideoScope({ startTime: 40 }, 60, 30)) as MuxAiError;
    expect(noVideo).toMatchObject({ code: "invalid_scope", source: "request", facts: { reason: "no_video", videoTrackDurationSeconds: 30 } });
  });
});

describe("transcript fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies a missing transcript file as the asset's and a 5xx as transient", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(fetchTranscriptDataForUrl("https://stream.mux.com/p/text/t.vtt")).rejects.toMatchObject({
      type: "validation_error",
      source: "asset",
      dependency: "mux_video",
      transient: false,
      facts: { call: "fetch_transcript", status: 404 },
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    await expect(fetchTranscriptDataForUrl("https://stream.mux.com/p/text/t.vtt")).rejects.toMatchObject({
      source: "upstream",
      transient: true,
    });
  });
});
