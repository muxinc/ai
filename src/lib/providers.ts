import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";

import env from "../env";
import type { MuxAIOptions } from "../types";

import type { EmbeddingModel, LanguageModel } from "ai";

export type SupportedProvider = "openai" | "anthropic" | "google";
export type SupportedEmbeddingProvider = "openai" | "google";

// Model ID unions inferred from ai-sdk provider call signatures
type OpenAIModelId = Parameters<ReturnType<typeof createOpenAI>["chat"]>[0];
type AnthropicModelId = Parameters<ReturnType<typeof createAnthropic>["chat"]>[0];
type GoogleModelId = Parameters<ReturnType<typeof createGoogleGenerativeAI>["chat"]>[0];

type OpenAIEmbeddingModelId = Parameters<ReturnType<typeof createOpenAI>["embedding"]>[0];
type GoogleEmbeddingModelId = Parameters<ReturnType<typeof createGoogleGenerativeAI>["textEmbeddingModel"]>[0];

export interface ModelIdByProvider {
  openai: OpenAIModelId;
  anthropic: AnthropicModelId;
  google: GoogleModelId;
}

export interface EmbeddingModelIdByProvider {
  openai: OpenAIEmbeddingModelId;
  google: GoogleEmbeddingModelId;
}

export interface ModelRequestOptions<P extends SupportedProvider = SupportedProvider> extends MuxAIOptions {
  provider?: P;
  model?: ModelIdByProvider[P];
}

export interface ResolvedModel<P extends SupportedProvider = SupportedProvider> {
  provider: P;
  modelId: ModelIdByProvider[P];
  model: LanguageModel;
}

const DEFAULT_LANGUAGE_MODELS: { [K in SupportedProvider]: ModelIdByProvider[K] } = {
  openai: "gpt-5-mini",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-2.5-flash",
};

const DEFAULT_EMBEDDING_MODELS: { [K in SupportedEmbeddingProvider]: EmbeddingModelIdByProvider[K] } = {
  openai: "text-embedding-3-small",
  google: "gemini-embedding-001",
};

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}. Set ${name} in your environment or pass it in options.`);
  }
  return value;
}

/**
 * Resolves a language model from a suggested provider.
 */
export function resolveLanguageModel<P extends SupportedProvider = SupportedProvider>(
  options: ModelRequestOptions<P> = {},
): ResolvedModel<P> {
  const provider = options.provider || ("openai" as P);
  const modelId = (options.model || DEFAULT_LANGUAGE_MODELS[provider]) as ModelIdByProvider[P];

  switch (provider) {
    case "openai": {
      const apiKey = options.openaiApiKey ?? env.OPENAI_API_KEY;
      requireEnv(apiKey, "OPENAI_API_KEY");
      const openai = createOpenAI({
        apiKey,
      });

      return {
        provider,
        modelId,
        model: openai(modelId),
      };
    }
    case "anthropic": {
      const apiKey = options.anthropicApiKey ?? env.ANTHROPIC_API_KEY;
      requireEnv(apiKey, "ANTHROPIC_API_KEY");
      const anthropic = createAnthropic({
        apiKey,
      });

      return {
        provider,
        modelId,
        model: anthropic(modelId),
      };
    }
    case "google": {
      const apiKey = options.googleApiKey ?? env.GOOGLE_GENERATIVE_AI_API_KEY;
      requireEnv(apiKey, "GOOGLE_GENERATIVE_AI_API_KEY");
      const google = createGoogleGenerativeAI({
        apiKey,
      });

      return {
        provider,
        modelId,
        model: google(modelId),
      };
    }
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported provider: ${exhaustiveCheck}`);
    }
  }
}

/**
 * Resolves an embedding model from a suggested provider.
 */
export function resolveEmbeddingModel<P extends SupportedEmbeddingProvider = "openai">(
  options: MuxAIOptions & { provider?: P; model?: EmbeddingModelIdByProvider[P] } = {},
): { provider: P; modelId: EmbeddingModelIdByProvider[P]; model: EmbeddingModel<string> } {
  const provider = options.provider || ("openai" as P);
  const modelId = (options.model || DEFAULT_EMBEDDING_MODELS[provider]) as EmbeddingModelIdByProvider[P];

  switch (provider) {
    case "openai": {
      const apiKey = options.openaiApiKey ?? env.OPENAI_API_KEY;
      requireEnv(apiKey, "OPENAI_API_KEY");
      const openai = createOpenAI({
        apiKey,
      });

      return {
        provider,
        modelId,
        model: openai.embedding(modelId),
      };
    }
    case "google": {
      const apiKey = options.googleApiKey ?? env.GOOGLE_GENERATIVE_AI_API_KEY;
      requireEnv(apiKey, "GOOGLE_GENERATIVE_AI_API_KEY");
      const google = createGoogleGenerativeAI({
        apiKey,
      });

      return {
        provider,
        modelId,
        model: google.textEmbeddingModel(modelId),
      };
    }
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported embedding provider: ${exhaustiveCheck}`);
    }
  }
}
