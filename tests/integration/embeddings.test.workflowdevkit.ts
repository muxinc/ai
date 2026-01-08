import { describe, expect, it } from "vitest";
import { start } from "workflow/api";

import type { SupportedEmbeddingProvider } from "../../src/lib/providers";
import { generateEmbeddings } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("Embeddings Integration Tests for Workflow DevKit", () => {
  const assetId = muxTestAssets.assetId;
  const providers: SupportedEmbeddingProvider[] = ["openai", "google"];

  it.each(providers)("should generate embeddings with %s provider", async (provider) => {
    const run = await start(generateEmbeddings, [assetId, {
      provider,
      chunkingStrategy: { type: "token", maxTokens: 500, overlap: 100 },
    }]);
    expect(run.runId).toMatch(/^wrun_/);

    const result = await run.returnValue;

    // Assert that the result exists
    expect(result).toBeDefined();

    // Verify structure
    expect(result).toHaveProperty("assetId");
    expect(result).toHaveProperty("chunks");
    expect(result).toHaveProperty("averagedEmbedding");
    expect(result).toHaveProperty("provider");
    expect(result).toHaveProperty("model");
    expect(result).toHaveProperty("metadata");

    // Verify asset ID matches
    expect(result.assetId).toBe(assetId);

    // Verify provider
    expect(result.provider).toBe(provider);

    // Verify chunks array
    expect(Array.isArray(result.chunks)).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(0);

    // Verify chunk structure
    result.chunks.forEach((chunk) => {
      expect(chunk).toHaveProperty("chunkId");
      expect(chunk).toHaveProperty("embedding");
      expect(chunk).toHaveProperty("metadata");
      expect(Array.isArray(chunk.embedding)).toBe(true);
      expect(chunk.embedding.length).toBeGreaterThan(0);
    });

    // Verify averaged embedding
    expect(Array.isArray(result.averagedEmbedding)).toBe(true);
    expect(result.averagedEmbedding.length).toBe(result.chunks[0].embedding.length);

    // Verify metadata
    expect(result.metadata).toHaveProperty("totalChunks");
    expect(result.metadata).toHaveProperty("totalTokens");
    expect(result.metadata).toHaveProperty("embeddingDimensions");
    expect(result.metadata.totalChunks).toBe(result.chunks.length);
  }, 120000); // 2 minute timeout for AI processing
});
