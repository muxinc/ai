import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async importOriginal => ({
  ...await importOriginal<typeof import("ai")>(),
  embed: vi.fn(),
}));

vi.mock("../../src/lib/mux-assets", () => ({
  getAssetDurationSecondsFromAsset: vi.fn(),
  getPlaybackIdForAsset: vi.fn(),
}));

vi.mock("../../src/lib/providers", () => ({
  createEmbeddingModelFromConfig: vi.fn(),
  resolveEmbeddingModelConfig: vi.fn(),
}));

vi.mock("../../src/lib/workflow-credentials", () => ({
  resolveMuxSigningContext: vi.fn(),
}));

vi.mock("../../src/primitives/text-chunking", () => ({
  chunkText: vi.fn(),
  chunkVTTCues: vi.fn(),
}));

vi.mock("../../src/primitives/transcripts", () => ({
  fetchTranscriptForAsset: vi.fn(),
  parseVTTCues: vi.fn(),
}));

const { embed } = await import("ai");
const { getAssetDurationSecondsFromAsset, getPlaybackIdForAsset } = await import("../../src/lib/mux-assets");
const { createEmbeddingModelFromConfig, resolveEmbeddingModelConfig } = await import("../../src/lib/providers");
const { resolveMuxSigningContext } = await import("../../src/lib/workflow-credentials");
const { chunkText } = await import("../../src/primitives/text-chunking");
const { fetchTranscriptForAsset } = await import("../../src/primitives/transcripts");
const { generateEmbeddings } = await import("../../src/workflows/embeddings");
const { MuxAiError } = await import("../../src/lib/mux-ai-error");

beforeEach(() => {
  vi.resetAllMocks();

  vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
    asset: { id: "asset-123" },
    playbackId: "playback-123",
    policy: "public",
  } as any);
  vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(undefined);
  vi.mocked(resolveMuxSigningContext).mockResolvedValue(undefined);
  vi.mocked(resolveEmbeddingModelConfig).mockReturnValue({
    provider: "openai",
    modelId: "text-embedding-3-small",
  } as any);
  vi.mocked(createEmbeddingModelFromConfig).mockResolvedValue({} as any);
  vi.mocked(fetchTranscriptForAsset).mockResolvedValue({
    transcriptText: "A short transcript",
  } as any);
  vi.mocked(chunkText).mockReturnValue([{
    id: "chunk-0",
    text: "A short transcript",
    tokenCount: 3,
  }] as any);
  vi.mocked(embed).mockResolvedValue({
    embedding: [0.1, 0.2],
    usage: { tokens: 3 },
  } as any);
});

describe("generateEmbeddings scope handling", () => {
  it("treats an empty scope like an omitted scope without requiring asset duration", async () => {
    await expect(generateEmbeddings("asset-123", { scope: {} })).resolves.toBeDefined();

    expect(vi.mocked(fetchTranscriptForAsset).mock.calls[0][2].scope).toBeUndefined();
  });
});

describe("generateEmbeddings failures", () => {
  it("passes a classified chunk failure through and keeps usage from every chunk", async () => {
    vi.mocked(chunkText).mockReturnValue([
      { id: "chunk-0", text: "one", tokenCount: 1 },
      { id: "chunk-1", text: "two", tokenCount: 1 },
    ] as any);
    const failure = Object.assign(new MuxAiError("provider down", {
      type: "processing_error",
      source: "upstream",
      dependency: "ai_provider",
      facts: { status: 503 },
    }), { usage: { inputTokens: 2, totalTokens: 2 } });
    vi.mocked(embed)
      .mockResolvedValueOnce({ embedding: [0.1], usage: { tokens: 3 } } as any)
      .mockRejectedValueOnce(failure);

    const error = await generateEmbeddings("asset-123").catch(e => e);

    expect(error).toBe(failure);
    expect(error).toMatchObject({
      source: "upstream",
      dependency: "ai_provider",
      facts: { status: 503, call: "embed_chunk", provider: "openai", chunkCount: 2, failedCount: 1 },
      usage: { inputTokens: 5, totalTokens: 5 },
    });
  });

  it("raises the shared signing-credentials error for a signed playback ID without keys", async () => {
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue({
      asset: { id: "asset-123" },
      playbackId: "playback-123",
      policy: "signed",
    } as any);

    await expect(generateEmbeddings("asset-123")).rejects.toMatchObject({ code: "signing_credentials_missing", source: "internal" });
  });
});
