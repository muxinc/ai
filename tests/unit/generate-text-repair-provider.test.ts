import { APICallError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateText } from "../../src/workflows/generate-text.ts";

const state = vi.hoisted(() => ({ requests: [] as Record<string, any>[], failure: "" as "" | "length" | "truncated-json" | "filter" | "refusal" | "refusal-with-reasoning" | "policy" | "auth" | "transient", providerMessage: "Provider rejected gpt-private for org-internal: rate-limit quota details" }));

vi.mock("../../src/lib/providers", async () => {
  const { createOpenAI } = await import("@ai-sdk/openai");
  return {
    resolveLanguageModelConfig: () => ({ provider: "openai", modelId: "gpt-6-luna" }),
    createLanguageModelFromConfig: async () => createOpenAI({
      apiKey: "test-key",
      fetch: async (_url, init) => {
        const request = JSON.parse(init!.body as string);
        state.requests.push(request);
        const name = request.text.format.name;
        const output = name === "editorial_brief" ?
            {
              centralIdea: "Source about careful editing.",
              readerValue: "Keep source meaning.",
              keyPoints: ["Grounded writing"],
              sourceSpecifics: [],
              visualContext: [],
              voiceSignals: [],
              claimsToQualify: [],
            } :
          name === "generated_text" ? { content: `Keep exactly.\n\n${"x".repeat(300)}` } : { p_2: "Short enough." };
        const repair = name === "paragraph_replacements";
        if (repair && (state.failure === "auth" || state.failure === "transient" || state.failure === "policy")) {
          return new Response(JSON.stringify({ error: { message: state.providerMessage, type: "invalid_request_error", code: state.failure === "policy" ? "content_policy_violation" : "test_error", param: null } }), { status: state.failure === "auth" ? 401 : state.failure === "policy" ? 400 : 429, headers: { "content-type": "application/json", "x-request-id": "req-repair-test", "x-private-header": "internal-header" } });
        }
        const refused = repair && (state.failure === "refusal" || state.failure === "refusal-with-reasoning");
        return new Response(JSON.stringify({
          id: `resp_${state.requests.length}`,
          created_at: 1_790_000_000,
          model: "gpt-6-luna",
          status: repair && (state.failure === "length" || state.failure === "filter" || state.failure === "truncated-json") ? "incomplete" : "completed",
          incomplete_details: repair && (state.failure === "length" || state.failure === "filter" || state.failure === "truncated-json") ? { reason: state.failure === "filter" ? "content_filter" : "max_output_tokens" } : null,
          output: [
            ...(repair && state.failure === "refusal-with-reasoning" ? [{ id: "rs_test", type: "reasoning", summary: [], content: null }] : []),
            { id: "msg_test", type: "message", role: "assistant", content: refused ? [{ type: "refusal", refusal: "Unable to help." }] : [{ type: "output_text", text: repair && state.failure === "truncated-json" ? "{" : JSON.stringify(output), annotations: [] }] },
          ],
          usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 }, output_tokens_details: { reasoning_tokens: 0 } },
        }), { headers: { "content-type": "application/json" } });
      },
    }).responses("gpt-6-luna"),
  };
});

vi.mock("../../src/lib/mux-assets", () => ({
  getAssetDurationSecondsFromAsset: () => 120,
  getVideoTrackDurationSecondsFromAsset: () => 120,
  isAudioOnlyAsset: () => true,
  getPlaybackIdForAsset: async () => ({ asset: { id: "asset-test", duration: 120 }, playbackId: "playback-test", policy: "public" }),
}));
vi.mock("../../src/lib/workflow-credentials", () => ({ resolveMuxSigningContext: async () => undefined }));
vi.mock("../../src/primitives/transcripts", () => ({
  getReliableLanguageCode: () => "en",
  fetchTranscriptForAsset: async () => ({ track: { language_code: "en" }, transcriptText: "Source about careful editing." }),
}));

beforeEach(() => {
  state.requests = [];
  state.failure = "";
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("production repair through the real AI SDK provider", () => {
  it("sends no reasoning and strict replacement fields while preserving every usage category", async () => {
    const result = await generateText("asset-test", { artifacts: [{ key: "post", channel: "x" }] });
    expect(result.variants[0].artifacts[0].content).toBe("Keep exactly.\n\nShort enough.");
    expect(state.requests).toHaveLength(3);
    expect(state.requests[2]).toMatchObject({
      reasoning: { effort: "none" },
      store: false,
      text: { format: { type: "json_schema", strict: true, schema: { required: ["p_2"], additionalProperties: false } } },
    });
    expect(JSON.stringify(state.requests[2].input)).not.toContain("Source about careful editing.");
    expect(result.usage).toMatchObject({ inputTokens: 300, outputTokens: 30, totalTokens: 330, cachedInputTokens: 60, cacheWriteTokens: 90, reasoningTokens: 0 });
  });

  it("retains provider usage and stops when the real adapter receives incomplete repair output", async () => {
    state.failure = "length";
    await expect(generateText("asset-test", { artifacts: [{ key: "post", channel: "x" }] })).rejects.toMatchObject({
      publicType: "processing_error",
      retryable: false,
      usage: { totalTokens: 330, cacheWriteTokens: 90 },
    });
    expect(state.requests).toHaveLength(3);
  });
  it.each(["filter", "refusal", "refusal-with-reasoning"] as const)("preserves %s policy classification and usage with one repair request", async (failure) => {
    state.failure = failure;
    await expect(generateText("asset-test", { artifacts: [{ key: "post", channel: "x" }] })).rejects.toMatchObject({
      publicType: "content_policy_error",
      retryable: false,
      usage: { totalTokens: 330, cachedInputTokens: 60, cacheWriteTokens: 90 },
    });
    expect(state.requests).toHaveLength(3);
  });

  it.each([["auth", false, 401], ["transient", true, 429]] as const)("keeps %s diagnostics internal and preserves retryability without retrying inside repair", async (failure, retryable, statusCode) => {
    state.failure = failure;
    const error = await generateText("asset-test", { artifacts: [{ key: "post", channel: "x" }] }).catch(error => error);
    expect(error).toMatchObject({
      __robots_error: true,
      message: "Unable to complete text generation.",
      publicMessage: "Unable to complete text generation.",
      publicType: "processing_error",
      retryable,
      usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220, cachedInputTokens: 40, cacheWriteTokens: 60, reasoningTokens: 0 },
    });
    expect(APICallError.isInstance(error.cause)).toBe(true);
    expect(error.cause).toMatchObject({ message: state.providerMessage, statusCode, responseHeaders: { "x-request-id": "req-repair-test" } });
    expect(Object.getOwnPropertyDescriptor(error, "cause")?.enumerable).toBe(false);
    expect(JSON.stringify(error)).not.toContain(state.providerMessage);
    expect(JSON.stringify(error)).not.toContain("req-repair-test");
    expect(console.warn).toHaveBeenCalledExactlyOnceWith("[@mux/ai] Bounded text repair failed.", {
      provider: "openai",
      modelId: "gpt-6-luna",
      reason: state.providerMessage,
      errorName: "AI_APICallError",
      statusCode,
      requestId: "req-repair-test",
    });
    expect(state.requests).toHaveLength(3);
  });
  it("normalizes a truncated JSON exception before generateText can return, retaining usage", async () => {
    state.failure = "truncated-json";
    await expect(generateText("asset-test", { artifacts: [{ key: "post", channel: "x" }] })).rejects.toMatchObject({
      publicType: "processing_error",
      retryable: false,
      finishReason: "length",
      usage: { totalTokens: 330, cacheWriteTokens: 90 },
    });
    expect(state.requests).toHaveLength(3);
  });

  it("normalizes an OpenAI API policy failure before recording the repair error", async () => {
    state.failure = "policy";
    await expect(generateText("asset-test", { artifacts: [{ key: "post", channel: "x" }] })).rejects.toMatchObject({
      publicType: "content_policy_error",
      retryable: false,
      usage: { totalTokens: 220 },
    });
    expect(state.requests).toHaveLength(3);
  });
});
