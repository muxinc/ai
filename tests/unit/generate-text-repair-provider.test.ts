import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateText } from "../../src/workflows/generate-text.ts";

const state = vi.hoisted(() => ({ requests: [] as Record<string, any>[], failRepair: false }));

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
        return new Response(JSON.stringify({
          id: `resp_${state.requests.length}`,
          created_at: 1_790_000_000,
          model: "gpt-6-luna",
          status: name === "paragraph_replacements" && state.failRepair ? "incomplete" : "completed",
          incomplete_details: name === "paragraph_replacements" && state.failRepair ? { reason: "max_output_tokens" } : null,
          output: [{ id: "msg_test", type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }] }],
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
  state.failRepair = false;
});

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
    state.failRepair = true;
    await expect(generateText("asset-test", { artifacts: [{ key: "post", channel: "x" }] })).rejects.toMatchObject({
      publicType: "processing_error",
      usage: { totalTokens: 330, cacheWriteTokens: 90 },
    });
    expect(state.requests).toHaveLength(3);
  });
});
