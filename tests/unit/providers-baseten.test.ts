import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createOpenAICompatibleMock } = vi.hoisted(() => {
  const createOpenAICompatibleMock = vi.fn((config: { name: string; apiKey?: string; baseURL: string }) => {
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
    provider.textEmbeddingModel = vi.fn((modelId: string) => ({
      config,
      kind: "embedding",
      modelId,
    }));
    return provider;
  });

  return { createOpenAICompatibleMock };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

function stubBaseEnv() {
  vi.stubEnv("MUX_TOKEN_ID", "test-token-id");
  vi.stubEnv("MUX_TOKEN_SECRET", "test-token-secret");
  vi.stubEnv("BASETEN_API_KEY", "");
  vi.stubEnv("BASETEN_URL", "");
  vi.stubEnv("BASETEN_EMBEDDING_URL", "");
  vi.stubEnv("BASETEN_MODEL", "");
  vi.stubEnv("BASETEN_EMBEDDING_MODEL", "");
  vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "");
  vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "");
  vi.stubEnv("OPENAI_COMPATIBLE_EMBEDDING_BASE_URL", "");
  vi.stubEnv("OPENAI_COMPATIBLE_MODEL", "");
  vi.stubEnv("OPENAI_COMPATIBLE_EMBEDDING_MODEL", "");
}

describe("baseten provider integration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    createOpenAICompatibleMock.mockClear();
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
      basetenUrl: "https://model-123.api.baseten.co/environments/production/sync/v1/chat/completions",
    }));
    const model = await createLanguageModelFromConfig("baseten", "mux-summarizer");
    setWorkflowCredentialsProvider(undefined);

    expect(model).toMatchObject({ kind: "language", modelId: "mux-summarizer" });
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "baseten",
      apiKey: "bt-key",
      baseURL: "https://model-123.api.baseten.co/environments/production/sync/v1",
    });
    expect(createOpenAICompatibleMock.mock.results[0]?.value.chatModel).toHaveBeenCalledWith("mux-summarizer");
  });

  it("defaults Baseten language models to the shared Model APIs when no URL is configured", async () => {
    vi.stubEnv("BASETEN_API_KEY", "bt-key");

    const { createLanguageModelFromConfig } = await import("../../src/lib/providers");

    await createLanguageModelFromConfig("baseten", "mux-summarizer");

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "baseten",
      apiKey: "bt-key",
      baseURL: "https://inference.baseten.co/v1",
    });
  });

  it("uses Baseten embedding-specific model and URL configuration", async () => {
    vi.stubEnv("BASETEN_API_KEY", "bt-key");
    vi.stubEnv("BASETEN_EMBEDDING_URL", "https://model-456.api.baseten.co/environments/production/sync");
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
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "baseten",
      apiKey: "bt-key",
      baseURL: "https://model-456.api.baseten.co/environments/production/sync/v1",
    });
    expect(createOpenAICompatibleMock.mock.results[0]?.value.textEmbeddingModel).toHaveBeenCalledWith("mux-embedding-model");
  });

  it("does not fall back to the language deployment for embeddings", async () => {
    vi.stubEnv("BASETEN_API_KEY", "bt-key");
    vi.stubEnv("BASETEN_MODEL", "mux-language-model");
    vi.stubEnv("BASETEN_URL", "https://model-123.api.baseten.co/environments/production/sync/v1");

    const {
      createEmbeddingModelFromConfig,
      resolveEmbeddingModelConfig,
    } = await import("../../src/lib/providers");

    expect(() => resolveEmbeddingModelConfig({ provider: "baseten" })).toThrow(
      "Baseten embedding model is required.",
    );
    await expect(createEmbeddingModelFromConfig("baseten", "mux-embedding-model")).rejects.toThrow(
      "Baseten embedding URL is required.",
    );
  });

  it("rejects Baseten /predict URLs for language models", async () => {
    vi.stubEnv("BASETEN_API_KEY", "bt-key");
    vi.stubEnv("BASETEN_URL", "https://model-123.api.baseten.co/environments/production/predict");

    const { createLanguageModelFromConfig } = await import("../../src/lib/providers");

    await expect(createLanguageModelFromConfig("baseten", "mux-summarizer")).rejects.toThrow(
      "Baseten dedicated deployment URLs must be /sync/v1 endpoints for language models",
    );
  });

  it("treats non-deployment URLs as shared OpenAI-compatible base URLs", async () => {
    vi.stubEnv("BASETEN_API_KEY", "bt-key");
    vi.stubEnv("BASETEN_URL", "https://llm.example.com/v1");

    const { createLanguageModelFromConfig } = await import("../../src/lib/providers");

    await createLanguageModelFromConfig("baseten", "mux-summarizer");

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "baseten",
      apiKey: "bt-key",
      baseURL: "https://llm.example.com/v1",
    });
  });
});
