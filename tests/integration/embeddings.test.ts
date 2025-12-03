import { describe, expect, it } from "vitest";

import { generateVideoEmbeddings } from "../../src/workflows";

import "../../src/env";

describe("embeddings Integration Tests", () => {
  const assetId = "88Lb01qNUqFJrOFMITk00Ck201F00Qmcbpc5qgopNV4fCOk";

  it("should generate embeddings with OpenAI provider", async () => {
    const result = await generateVideoEmbeddings(assetId, {
      provider: "openai",
      chunkingStrategy: { type: "token", maxTokens: 500, overlap: 100 },
    });

    // Assert that the result exists
    expect(result).toBeDefined();
    expect(result.assetId).toBe(assetId);
    expect(result.provider).toBe("openai");

    // Assert that chunks array exists and has content
    expect(result.chunks).toBeDefined();
    expect(Array.isArray(result.chunks)).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(0);

    // Verify chunk embedding structure
    result.chunks.forEach((chunk) => {
      expect(chunk).toHaveProperty("chunkId");
      expect(chunk).toHaveProperty("embedding");
      expect(chunk).toHaveProperty("metadata");

      // Verify embedding is an array of numbers
      expect(Array.isArray(chunk.embedding)).toBe(true);
      expect(chunk.embedding.length).toBeGreaterThan(0);
      expect(typeof chunk.embedding[0]).toBe("number");

      // Verify metadata structure
      expect(chunk.metadata).toHaveProperty("tokenCount");
      expect(typeof chunk.metadata.tokenCount).toBe("number");
      expect(chunk.metadata.tokenCount).toBeGreaterThan(0);
    });

    // Assert that averaged embedding exists and is valid
    expect(result.averagedEmbedding).toBeDefined();
    expect(Array.isArray(result.averagedEmbedding)).toBe(true);
    expect(result.averagedEmbedding.length).toBe(result.chunks[0].embedding.length);

    // Verify all embeddings have the same dimensions
    const embeddingDimensions = result.chunks[0].embedding.length;
    result.chunks.forEach((chunk) => {
      expect(chunk.embedding.length).toBe(embeddingDimensions);
    });

    // Verify metadata
    expect(result.metadata).toBeDefined();
    expect(result.metadata.totalChunks).toBe(result.chunks.length);
    expect(result.metadata.totalTokens).toBeGreaterThan(0);
    expect(result.metadata.embeddingDimensions).toBe(embeddingDimensions);
    expect(result.metadata.generatedAt).toBeDefined();

    // Verify that averaged embedding values are within reasonable range
    result.averagedEmbedding.forEach((value) => {
      expect(typeof value).toBe("number");
      expect(Number.isFinite(value)).toBe(true);
    });
  });

  it("should generate embeddings with custom chunking strategy", async () => {
    const result = await generateVideoEmbeddings(assetId, {
      provider: "openai",
      chunkingStrategy: { type: "token", maxTokens: 300, overlap: 50 },
    });

    expect(result).toBeDefined();
    expect(result.chunks.length).toBeGreaterThan(0);

    // Verify chunks respect max token limit (with some tolerance for approximation)
    result.chunks.forEach((chunk) => {
      expect(chunk.metadata.tokenCount).toBeLessThanOrEqual(350); // 300 + some tolerance
    });
  });

  it("should always generate averaged embedding", async () => {
    const result = await generateVideoEmbeddings(assetId, {
      provider: "openai",
    });

    expect(result).toBeDefined();
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.averagedEmbedding.length).toBeGreaterThan(0);
    expect(result.averagedEmbedding.length).toBe(result.chunks[0].embedding.length);
  });
});
