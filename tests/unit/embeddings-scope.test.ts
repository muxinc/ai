import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
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
