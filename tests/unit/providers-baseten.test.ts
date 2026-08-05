import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createBasetenMock } = vi.hoisted(() => {
  const createBasetenMock = vi.fn((config: { apiKey?: string; baseURL?: string; modelURL?: string }) => {
    const provider = vi.fn((modelId: string) => ({
      config,
      kind: "language",
      modelId,
    }));
    provider.chatModel = vi.fn((modelId: string) => ({
      config,
      kind: "language",
      modelId,
    }));
    provider.embeddingModel = vi.fn((modelId: string) => ({
      config,
      kind: "embedding",
      modelId,
    }));
    return provider;
  });

  return { createBasetenMock };
});

vi.mock("@ai-sdk/baseten", () => ({
  createBaseten: createBasetenMock,
}));

function stubBaseEnv() {
  vi.stubEnv("MUX_TOKEN_ID", "test-token-id");
  vi.stubEnv("MUX_TOKEN_SECRET", "test-token-secret");
  vi.stubEnv("BASETEN_API_KEY", "");
  vi.stubEnv("BASETEN_BASE_URL", "");
  vi.stubEnv("BASETEN_MODEL_URL", "");
  vi.stubEnv("BASETEN_EMBEDDING_BASE_URL", "");
  vi.stubEnv("BASETEN_EMBEDDING_MODEL_URL", "");
  vi.stubEnv("BASETEN_MODEL", "");
  vi.stubEnv("BASETEN_EMBEDDING_MODEL", "");
}

describe("baseten provider integration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    createBasetenMock.mockClear();
    stubBaseEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves Baseten language model defaults from BASETEN_MODEL", async () => {
    vi.stubEnv("BASETEN_MODEL", "mux-summarizer");

    const { resolveLanguageModelConfig } = await import("../../src/lib/providers");

    expect(resolveLanguageModelConfig({ provider: "baseten" })).toEqual({
      provider: "baseten",
      modelId: "mux-summarizer",
    });
  });

  it("requires an explicit Baseten language model when no default is configured", async () => {
    const { resolveLanguageModelConfig } = await import("../../src/lib/providers");

    expect(() => resolveLanguageModelConfig({ provider: "baseten" })).toThrow(
      "Baseten model is required.",
    );
  });

  it("excludes Baseten from eval model selection", async () => {
    const { resolveEvalModelConfigs } = await import("../../src/lib/providers");

    expect(resolveEvalModelConfigs({ selection: "all" }).some(config => String(config.provider) === "baseten")).toBe(false);
    expect(resolveEvalModelConfigs({ modelPairs: ["baseten:mux-summarizer"] })).toEqual([]);
    expect(resolveEvalModelConfigs({ modelPairs: ["baseten:mux-summarizer", "openai:gpt-5.1"] })).toEqual([
      { provider: "openai", modelId: "gpt-5.1" },
    ]);
  });

  it("creates Baseten language models from workflow credentials", async () => {
    const { setWorkflowCredentialsProvider } = await import("../../src/lib/workflow-credentials");
    const { createLanguageModelFromConfig } = await import("../../src/lib/providers");

    setWorkflowCredentialsProvider(() => ({
      basetenApiKey: "bt-key",
      basetenModelUrl: "https://model-123.api.baseten.co/environments/production/sync/v1/chat/completions",
    }));
    const model = await createLanguageModelFromConfig("baseten", "mux-summarizer");
    setWorkflowCredentialsProvider(undefined);

    expect(model).toMatchObject({ kind: "language", modelId: "mux-summarizer" });
    expect(createBasetenMock).toHaveBeenCalledWith({
      apiKey: "bt-key",
      modelURL: "https://model-123.api.baseten.co/environments/production/sync/v1",
    });
    expect(createBasetenMock.mock.results[0]?.value).toHaveBeenCalledWith("mux-summarizer");
  });

  it("uses Baseten embedding-specific model and URL configuration", async () => {
    vi.stubEnv("BASETEN_API_KEY", "bt-key");
    vi.stubEnv("BASETEN_EMBEDDING_MODEL_URL", "https://model-456.api.baseten.co/environments/production/sync");
    vi.stubEnv("BASETEN_EMBEDDING_MODEL", "mux-embedding-model");

    const {
      createEmbeddingModelFromConfig,
      resolveEmbeddingModelConfig,
    } = await import("../../src/lib/providers");

    expect(resolveEmbeddingModelConfig({ provider: "baseten" })).toEqual({
      provider: "baseten",
      modelId: "mux-embedding-model",
    });

    const model = await createEmbeddingModelFromConfig("baseten", "mux-embedding-model");

    expect(model).toMatchObject({ kind: "embedding", modelId: "mux-embedding-model" });
    expect(createBasetenMock).toHaveBeenCalledWith({
      apiKey: "bt-key",
      modelURL: "https://model-456.api.baseten.co/environments/production/sync",
    });
    expect(createBasetenMock.mock.results[0]?.value.embeddingModel).toHaveBeenCalledWith("mux-embedding-model");
  });

  it("does not fall back to the language deployment for embeddings", async () => {
    vi.stubEnv("BASETEN_API_KEY", "bt-key");
    vi.stubEnv("BASETEN_MODEL", "mux-language-model");
    vi.stubEnv("BASETEN_MODEL_URL", "https://model-123.api.baseten.co/environments/production/sync/v1");

    const {
      createEmbeddingModelFromConfig,
      resolveEmbeddingModelConfig,
    } = await import("../../src/lib/providers");

    expect(() => resolveEmbeddingModelConfig({ provider: "baseten" })).toThrow(
      "Baseten embedding model is required.",
    );
    await expect(createEmbeddingModelFromConfig("baseten", "mux-embedding-model")).rejects.toThrow(
      "Baseten embedding model URL is required.",
    );
  });

  it("rejects Baseten /predict URLs for language models", async () => {
    vi.stubEnv("BASETEN_API_KEY", "bt-key");
    vi.stubEnv("BASETEN_MODEL_URL", "https://model-123.api.baseten.co/environments/production/predict");

    const { createLanguageModelFromConfig } = await import("../../src/lib/providers");

    await expect(createLanguageModelFromConfig("baseten", "mux-summarizer")).rejects.toThrow(
      "Baseten language models require a dedicated /sync/v1 model URL",
    );
  });

  it("rejects Baseten language model URLs the SDK would silently ignore", async () => {
    vi.stubEnv("BASETEN_API_KEY", "bt-key");
    vi.stubEnv("BASETEN_MODEL_URL", "https://llm.example.com/v1");

    const { createLanguageModelFromConfig } = await import("../../src/lib/providers");

    await expect(createLanguageModelFromConfig("baseten", "mux-summarizer")).rejects.toThrow(
      "Baseten language models require a dedicated /sync/v1 model URL",
    );
  });
});
