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
  vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "");
  vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "");
  vi.stubEnv("OPENAI_COMPATIBLE_EMBEDDING_BASE_URL", "");
  vi.stubEnv("OPENAI_COMPATIBLE_MODEL", "");
  vi.stubEnv("OPENAI_COMPATIBLE_EMBEDDING_MODEL", "");
}

describe("openai-compatible provider integration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    createOpenAICompatibleMock.mockClear();
    stubBaseEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves language model defaults from OPENAI_COMPATIBLE_MODEL", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_MODEL", "llama-3.3-70b-instruct");

    const { resolveLanguageModelConfig } = await import("../../src/lib/providers");

    expect(resolveLanguageModelConfig({ provider: "openai-compatible" })).toEqual({
      provider: "openai-compatible",
      modelId: "llama-3.3-70b-instruct",
    });
  });

  it("requires an explicit model when no default is configured", async () => {
    const { resolveLanguageModelConfig } = await import("../../src/lib/providers");

    expect(() => resolveLanguageModelConfig({ provider: "openai-compatible" })).toThrow(
      "OpenAI-compatible model is required.",
    );
  });

  it("requires a base URL", async () => {
    const { createLanguageModelFromConfig } = await import("../../src/lib/providers");

    await expect(createLanguageModelFromConfig("openai-compatible", "llama-3.3-70b-instruct")).rejects.toThrow(
      "OpenAI-compatible base URL is required.",
    );
  });

  it("creates language models without an API key for keyless endpoints", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "http://localhost:11434/v1/");

    const { createLanguageModelFromConfig } = await import("../../src/lib/providers");

    const model = await createLanguageModelFromConfig("openai-compatible", "llama-3.3-70b-instruct");

    expect(model).toMatchObject({ kind: "language", modelId: "llama-3.3-70b-instruct" });
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "openai-compatible",
      apiKey: undefined,
      baseURL: "http://localhost:11434/v1",
      supportsStructuredOutputs: true,
    });
    expect(createOpenAICompatibleMock.mock.results[0]?.value.chatModel).toHaveBeenCalledWith("llama-3.3-70b-instruct");
  });

  it("creates language models from workflow credentials", async () => {
    const { setWorkflowCredentialsProvider } = await import("../../src/lib/workflow-credentials");
    const { createLanguageModelFromConfig } = await import("../../src/lib/providers");

    setWorkflowCredentialsProvider(() => ({
      openaiCompatibleApiKey: "oc-key",
      openaiCompatibleBaseUrl: "https://my-endpoint.example.com/v1/chat/completions",
    }));
    const model = await createLanguageModelFromConfig("openai-compatible", "qwen-2.5-vl");
    setWorkflowCredentialsProvider(undefined);

    expect(model).toMatchObject({ kind: "language", modelId: "qwen-2.5-vl" });
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "openai-compatible",
      apiKey: "oc-key",
      baseURL: "https://my-endpoint.example.com/v1",
      supportsStructuredOutputs: true,
    });
  });

  it("falls back to the shared base URL for embeddings", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "oc-key");
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "https://my-endpoint.example.com/v1");
    vi.stubEnv("OPENAI_COMPATIBLE_EMBEDDING_MODEL", "bge-large");

    const {
      createEmbeddingModelFromConfig,
      resolveEmbeddingModelConfig,
    } = await import("../../src/lib/providers");

    expect(resolveEmbeddingModelConfig({ provider: "openai-compatible" })).toEqual({
      provider: "openai-compatible",
      modelId: "bge-large",
    });

    const model = await createEmbeddingModelFromConfig("openai-compatible", "bge-large");

    expect(model).toMatchObject({ kind: "embedding", modelId: "bge-large" });
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "openai-compatible",
      apiKey: "oc-key",
      baseURL: "https://my-endpoint.example.com/v1",
      supportsStructuredOutputs: true,
    });
    expect(createOpenAICompatibleMock.mock.results[0]?.value.textEmbeddingModel).toHaveBeenCalledWith("bge-large");
  });

  it("prefers the embedding-specific base URL when configured", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "https://my-endpoint.example.com/v1");
    vi.stubEnv("OPENAI_COMPATIBLE_EMBEDDING_BASE_URL", "https://embeddings.example.com/v1");

    const { createEmbeddingModelFromConfig } = await import("../../src/lib/providers");

    await createEmbeddingModelFromConfig("openai-compatible", "bge-large");

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "openai-compatible",
      apiKey: undefined,
      baseURL: "https://embeddings.example.com/v1",
      supportsStructuredOutputs: true,
    });
  });

  it("excludes openai-compatible from eval model selection", async () => {
    const { resolveEvalModelConfigs } = await import("../../src/lib/providers");

    expect(resolveEvalModelConfigs({ selection: "all" }).some(config => String(config.provider) === "openai-compatible")).toBe(false);
    expect(resolveEvalModelConfigs({ modelPairs: ["openai-compatible:llama-3.3-70b-instruct"] })).toEqual([]);
  });
});
