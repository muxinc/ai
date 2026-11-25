import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MuxAiError } from "../../src/lib/mux-ai-error.ts";

// Provider configuration failures: classified on the language-model path (every workflow
// that uses it has moved), opt-in on the embedding path (embeddings haven't). None is
// step-retried: configuration and request options don't change between attempts.

function stubProviderEnv() {
  for (const name of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "HIVE_API_KEY",
    "BASETEN_API_KEY",
    "BASETEN_URL",
    "BASETEN_EMBEDDING_URL",
    "BASETEN_MODEL",
    "BASETEN_EMBEDDING_MODEL",
    "OPENAI_COMPATIBLE_API_KEY",
    "OPENAI_COMPATIBLE_BASE_URL",
    "OPENAI_COMPATIBLE_EMBEDDING_BASE_URL",
    "OPENAI_COMPATIBLE_MODEL",
    "OPENAI_COMPATIBLE_EMBEDDING_MODEL",
  ]) {
    vi.stubEnv(name, "");
  }
}

async function caught(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

const NOT_RETRIED = { transient: false, retryable: false, name: "FatalError" };

function notConfigured(facts: Record<string, unknown>) {
  return {
    code: "provider_not_configured",
    type: "server_error",
    source: "internal",
    ...NOT_RETRIED,
    facts,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  stubProviderEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("language models", () => {
  it("codes a missing API key provider_not_configured, naming the settings but never a value", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret-value");
    const { createLanguageModelFromConfig } = await import("../../src/lib/providers");

    const error = await caught(() => createLanguageModelFromConfig("openai", "gpt-5.6-luna"));

    expect(MuxAiError.is(error)).toBe(true);
    expect(error).toMatchObject(notConfigured({ provider: "openai", reason: "api_key_missing", settings: ["OPENAI_API_KEY", "openaiApiKey"] }));
    expect(JSON.stringify((error as MuxAiError).facts)).not.toContain("secret");
  });

  it("codes a missing API key from the environment-only resolver the same way", async () => {
    const { resolveLanguageModel } = await import("../../src/lib/providers");

    const error = await caught(() => resolveLanguageModel({ provider: "google" }));

    expect(error).toMatchObject(notConfigured({ provider: "google", reason: "api_key_missing", settings: ["GOOGLE_GENERATIVE_AI_API_KEY"] }));
  });

  it("codes a missing default model provider_not_configured", async () => {
    const { resolveLanguageModelConfig } = await import("../../src/lib/providers");

    expect(await caught(() => resolveLanguageModelConfig({ provider: "baseten" })))
      .toMatchObject(notConfigured({ provider: "baseten", reason: "model_missing", settings: ["BASETEN_MODEL"] }));
    expect(await caught(() => resolveLanguageModelConfig({ provider: "openai-compatible" })))
      .toMatchObject(notConfigured({ provider: "openai-compatible", reason: "model_missing", settings: ["OPENAI_COMPATIBLE_MODEL"] }));
  });

  it("codes a missing or unusable endpoint URL provider_not_configured", async () => {
    vi.stubEnv("BASETEN_API_KEY", "bt-key");
    vi.stubEnv("BASETEN_URL", "https://model-123.api.baseten.co/environments/production/predict");
    const { createLanguageModelFromConfig } = await import("../../src/lib/providers");

    expect(await caught(() => createLanguageModelFromConfig("baseten", "mux-summarizer")))
      .toMatchObject(notConfigured({ provider: "baseten", reason: "base_url_unsupported", settings: ["BASETEN_URL", "basetenUrl"] }));
    expect(await caught(() => createLanguageModelFromConfig("openai-compatible", "llama")))
      .toMatchObject(notConfigured({ provider: "openai-compatible", reason: "base_url_missing", settings: ["OPENAI_COMPATIBLE_BASE_URL", "openaiCompatibleBaseUrl"] }));
  });

  it("codes an unsupported provider model_unsupported, blamed on the caller's provider option", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const { createLanguageModelFromConfig, resolveLanguageModel } = await import("../../src/lib/providers");
    const expected = {
      code: "model_unsupported",
      type: "validation_error",
      source: "request",
      ...NOT_RETRIED,
      facts: { reason: "provider_unsupported", provider: "mistral", inputs: ["provider"] },
    };

    expect(await caught(() => createLanguageModelFromConfig("mistral" as never, "m" as never))).toMatchObject(expected);
    expect(await caught(() => resolveLanguageModel({ provider: "mistral" as never, model: "m" as never }))).toMatchObject(expected);
  });

  it("codes a retired model model_unsupported, blamed on the caller's model option", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "g-test");
    const { createLanguageModelFromConfig, resolveLanguageModelConfig } = await import("../../src/lib/providers");
    const expected = {
      code: "model_unsupported",
      type: "validation_error",
      source: "request",
      ...NOT_RETRIED,
      facts: {
        reason: "model_retired",
        provider: "google",
        model: "gemini-3.1-flash-lite-preview",
        replacementModel: "gemini-3.1-flash-lite",
        inputs: ["model"],
      },
    };

    expect(await caught(() => resolveLanguageModelConfig({ provider: "google", model: "gemini-3.1-flash-lite-preview" }))).toMatchObject(expected);
    expect(await caught(() => createLanguageModelFromConfig("google", "gemini-3.1-flash-lite-preview"))).toMatchObject(expected);
  });

  it("never defaults to a retired model, so model_retired is always the caller's choice", async () => {
    const { DEFAULT_LANGUAGE_MODELS, getLanguageModelDeprecation } = await import("../../src/lib/providers");

    for (const [provider, modelId] of Object.entries(DEFAULT_LANGUAGE_MODELS)) {
      expect(getLanguageModelDeprecation(provider as keyof typeof DEFAULT_LANGUAGE_MODELS, modelId)?.phase).not.toBe("blocked");
    }
  });
});

describe("provider API keys for other calls", () => {
  it("codes a missing key provider_not_configured", async () => {
    const { resolveProviderApiKey } = await import("../../src/lib/workflow-credentials");

    expect(await caught(() => resolveProviderApiKey("hive")))
      .toMatchObject(notConfigured({ provider: "hive", reason: "api_key_missing", settings: ["HIVE_API_KEY", "hiveApiKey"] }));
  });

  it("keeps a plain Error without the opt-in", async () => {
    const { resolveProviderApiKeyFromCredentials } = await import("../../src/lib/workflow-credentials");

    const error = await caught(() => resolveProviderApiKeyFromCredentials("openai", {}));

    expect(MuxAiError.is(error)).toBe(false);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("embedding models (opt-in)", () => {
  const cases: Array<{ name: string; run: (opts: { classifiedErrors?: boolean }) => Promise<unknown>; expected: Record<string, unknown> }> = [
    {
      name: "a missing API key",
      run: async (opts) => {
        const { createEmbeddingModelFromConfig } = await import("../../src/lib/providers");
        return createEmbeddingModelFromConfig("openai", "text-embedding-3-small", undefined, opts);
      },
      expected: notConfigured({ provider: "openai", reason: "api_key_missing", settings: ["OPENAI_API_KEY", "openaiApiKey"] }),
    },
    {
      name: "a missing default model",
      run: async (opts) => {
        const { resolveEmbeddingModelConfig } = await import("../../src/lib/providers");
        return resolveEmbeddingModelConfig({ provider: "baseten" }, opts);
      },
      expected: notConfigured({ provider: "baseten", reason: "model_missing", settings: ["BASETEN_EMBEDDING_MODEL"] }),
    },
    {
      name: "a missing endpoint URL",
      run: async (opts) => {
        vi.stubEnv("BASETEN_API_KEY", "bt-key");
        const { createEmbeddingModelFromConfig } = await import("../../src/lib/providers");
        return createEmbeddingModelFromConfig("baseten", "mux-embedding-model", undefined, opts);
      },
      expected: notConfigured({ provider: "baseten", reason: "base_url_missing", settings: ["BASETEN_EMBEDDING_URL", "basetenEmbeddingUrl"] }),
    },
    {
      name: "an endpoint URL that isn't a dedicated deployment",
      run: async (opts) => {
        vi.stubEnv("BASETEN_API_KEY", "bt-key");
        vi.stubEnv("BASETEN_EMBEDDING_URL", "https://llm.example.com/v1");
        const { createEmbeddingModelFromConfig } = await import("../../src/lib/providers");
        return createEmbeddingModelFromConfig("baseten", "mux-embedding-model", undefined, opts);
      },
      expected: notConfigured({ provider: "baseten", reason: "base_url_unsupported", settings: ["BASETEN_EMBEDDING_URL", "basetenEmbeddingUrl"] }),
    },
    {
      name: "an unsupported provider",
      run: async (opts) => {
        const { createEmbeddingModelFromConfig } = await import("../../src/lib/providers");
        return createEmbeddingModelFromConfig("anthropic" as never, "m" as never, undefined, opts);
      },
      expected: { code: "model_unsupported", source: "request", ...NOT_RETRIED, facts: { reason: "provider_unsupported", provider: "anthropic", inputs: ["provider"] } },
    },
    {
      name: "a missing API key from the environment-only resolver",
      run: async (opts) => {
        const { resolveEmbeddingModel } = await import("../../src/lib/providers");
        return resolveEmbeddingModel({ provider: "google" }, opts);
      },
      expected: notConfigured({ provider: "google", reason: "api_key_missing", settings: ["GOOGLE_GENERATIVE_AI_API_KEY"] }),
    },
  ];

  for (const { name, run, expected } of cases) {
    it(`classifies ${name} with the opt-in, and keeps it a plain Error (step-retried, as before) without`, async () => {
      const classified = await caught(() => run({ classifiedErrors: true }));
      expect(classified).toMatchObject(expected);

      vi.resetModules();
      const legacy = await caught(() => run({}));
      expect(MuxAiError.is(legacy)).toBe(false);
      expect(legacy).toBeInstanceOf(Error);
      expect((legacy as Error).name).toBe("Error");
      // Same text as the classified error's developer message, as before classification.
      expect((legacy as Error).message).toBe((classified as Error).message);
    });
  }
});

describe("eval tooling", () => {
  it("raises its own configuration failures as internal errors", async () => {
    const { calculateModelCost, resolveEvalModelConfigs } = await import("../../src/lib/providers");

    expect(await caught(() => calculateModelCost("unknown-model", 1, 1)))
      .toMatchObject({ type: "server_error", source: "internal", ...NOT_RETRIED, facts: { model: "unknown-model" } });
    expect(await caught(() => resolveEvalModelConfigs({ modelPairs: ["no-separator"] })))
      .toMatchObject({ type: "server_error", source: "internal", facts: { setting: "MUX_AI_EVAL_MODELS", reason: "invalid_format" } });
    expect(await caught(() => resolveEvalModelConfigs({ modelPairs: ["openai:not-a-model"] })))
      .toMatchObject({ type: "server_error", source: "internal", facts: { setting: "MUX_AI_EVAL_MODELS", reason: "model_unsupported", provider: "openai" } });
  });
});
