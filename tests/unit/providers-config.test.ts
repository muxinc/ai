import { describe, expect, it } from "vitest";

import {
  calculateCost,
  DEFAULT_LANGUAGE_MODELS,
  resolveEmbeddingModelConfig,
  resolveLanguageModelConfig,
} from "../../src/lib/providers";

describe("provider model config", () => {
  it("resolves default language models for bedrock and vertex", () => {
    const bedrock = resolveLanguageModelConfig({ provider: "bedrock" });
    const vertex = resolveLanguageModelConfig({ provider: "vertex" });

    expect(bedrock.modelId).toBe(DEFAULT_LANGUAGE_MODELS.bedrock);
    expect(vertex.modelId).toBe(DEFAULT_LANGUAGE_MODELS.vertex);
  });

  it("resolves default embedding models for bedrock and vertex", () => {
    const bedrock = resolveEmbeddingModelConfig({ provider: "bedrock" });
    const vertex = resolveEmbeddingModelConfig({ provider: "vertex" });

    expect(bedrock.modelId).toBe("amazon.titan-embed-text-v2:0");
    expect(vertex.modelId).toBe("text-embedding-005");
  });

  it("calculates non-zero costs for bedrock and vertex", () => {
    const bedrockCost = calculateCost("bedrock", 1_000_000, 1_000_000);
    const vertexCost = calculateCost("vertex", 1_000_000, 1_000_000);

    expect(bedrockCost).toBeGreaterThan(0);
    expect(vertexCost).toBeGreaterThan(0);
  });
});
