import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createOpenAIMock = vi.fn((config: { apiKey: string; baseURL?: string }) => {
  const callable = vi.fn((modelId: string) => ({
    config,
    kind: "language",
    modelId,
    transport: "responses",
  }));
  callable.chat = vi.fn((modelId: string) => ({
    config,
    kind: "language",
    modelId,
    transport: "chat",
  }));
  callable.embedding = vi.fn((modelId: string) => ({
    config,
    kind: "embedding",
    modelId,
  }));
  return callable;
});

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: createOpenAIMock,
}));

const resolveProviderApiKeyMock = vi.fn(async (
  provider: string,
  credentials?: Record<string, unknown>,
) => {
  if (provider === "baseten") {
    const direct = typeof credentials?.basetenApiKey === "string" ? credentials.basetenApiKey : undefined;
    const processLike = Reflect.get(globalThis, "process") as { env?: Record<string, string | undefined> } | undefined;
    return direct ?? processLike?.env?.BASETEN_API_KEY ?? "";
  }

  throw new Error(`Unexpected provider in test mock: ${provider}`);
});

const resolveWorkflowCredentialsMock = vi.fn(async (credentials?: Record<string, unknown>) => credentials ?? {});

vi.mock("@mux/ai/lib/workflow-credentials", () => ({
  resolveProviderApiKey: resolveProviderApiKeyMock,
  resolveWorkflowCredentials: resolveWorkflowCredentialsMock,
}));

function stubBaseEnv() {
  vi.stubEnv("MUX_TOKEN_ID", "test-token-id");
  vi.stubEnv("MUX_TOKEN_SECRET", "test-token-secret");
  vi.stubEnv("BASETEN_API_KEY", "");
  vi.stubEnv("BASETEN_BASE_URL", "");
  vi.stubEnv("BASETEN_EMBEDDING_BASE_URL", "");
  vi.stubEnv("BASETEN_MODEL", "");
  vi.stubEnv("BASETEN_EMBEDDING_MODEL", "");
}

describe("baseten provider integration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    createOpenAIMock.mockClear();
    resolveProviderApiKeyMock.mockClear();
    resolveWorkflowCredentialsMock.mockClear();
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

  it("requires an explicit Baseten model when no default is configured", async () => {
    const { resolveLanguageModelConfig } = await import("../../src/lib/providers");

    expect(() => resolveLanguageModelConfig({ provider: "baseten" })).toThrow(
      "Baseten model is required.",
    );
  });

  it("normalizes Baseten chat endpoints for workflow language models", async () => {
    const { createLanguageModelFromConfig } = await import("../../src/lib/providers");

    const model = await createLanguageModelFromConfig(
      "baseten",
      "mux-summarizer",
      {
        basetenApiKey: "bt-key",
        basetenBaseUrl: "https://model-123.api.baseten.co/environments/production/sync/v1/chat/completions",
      },
    );

    expect(model).toMatchObject({ kind: "language", modelId: "mux-summarizer", transport: "chat" });
    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: "bt-key",
      baseURL: "https://model-123.api.baseten.co/environments/production/sync/v1",
    });
    expect(createOpenAIMock.mock.results[0]?.value.chat).toHaveBeenCalledWith("mux-summarizer");
  });

  it("uses Baseten embedding-specific defaults and base URL fallback", async () => {
    vi.stubEnv("BASETEN_API_KEY", "bt-key");
    vi.stubEnv("BASETEN_BASE_URL", "https://model-456.api.baseten.co/environments/production/sync/v1");
    vi.stubEnv("BASETEN_MODEL", "mux-shared-model");

    const {
      resolveEmbeddingModelConfig,
      createEmbeddingModelFromConfig,
    } = await import("../../src/lib/providers");

    expect(resolveEmbeddingModelConfig({ provider: "baseten" })).toEqual({
      provider: "baseten",
      modelId: "mux-shared-model",
    });

    const model = await createEmbeddingModelFromConfig("baseten", "mux-shared-model");

    expect(model).toMatchObject({ kind: "embedding", modelId: "mux-shared-model" });
    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: "bt-key",
      baseURL: "https://model-456.api.baseten.co/environments/production/sync/v1",
    });
  });
});
