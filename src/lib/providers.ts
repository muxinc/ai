import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";

import env from "@mux/ai/env";
import { resolveProviderApiKey } from "@mux/ai/lib/workflow-credentials";
import type { MuxAIOptions, WorkflowCredentialsInput } from "@mux/ai/types";

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

export const DEFAULT_LANGUAGE_MODELS: { [K in SupportedProvider]: ModelIdByProvider[K] } = {
  openai: "gpt-5.1",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-3-flash-preview",
};

const DEFAULT_EMBEDDING_MODELS: { [K in SupportedEmbeddingProvider]: EmbeddingModelIdByProvider[K] } = {
  openai: "text-embedding-3-small",
  google: "gemini-embedding-001",
};

export function resolveLanguageModelConfig<P extends SupportedProvider = SupportedProvider>(
  options: ModelRequestOptions<P> = {},
): { provider: P; modelId: ModelIdByProvider[P] } {
  const provider = options.provider || ("openai" as P);
  const modelId = (options.model || DEFAULT_LANGUAGE_MODELS[provider]) as ModelIdByProvider[P];

  return { provider, modelId };
}

export function resolveEmbeddingModelConfig<P extends SupportedEmbeddingProvider = "openai">(
  options: MuxAIOptions & { provider?: P; model?: EmbeddingModelIdByProvider[P] } = {},
): { provider: P; modelId: EmbeddingModelIdByProvider[P] } {
  const provider = options.provider || ("openai" as P);
  const modelId = (options.model || DEFAULT_EMBEDDING_MODELS[provider]) as EmbeddingModelIdByProvider[P];

  return { provider, modelId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Model Pricing
// ─────────────────────────────────────────────────────────────────────────────
//
// Pricing is in USD per million tokens. These values are used for cost estimation
// in evaluations and should be periodically verified against official sources.
//
// Sources (as of December 2025):
// - OpenAI: https://openai.com/api/pricing
// - Anthropic: https://www.anthropic.com/pricing
// - Google: https://ai.google.dev/pricing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pricing structure for a language model.
 * All costs are in USD per million tokens.
 */
export interface ModelPricing {
  /** Cost per million input tokens (USD). */
  inputPerMillion: number;
  /** Cost per million output tokens (USD). */
  outputPerMillion: number;
  /** Cost per million cached input tokens (USD), if supported. */
  cachedInputPerMillion?: number;
  /** URL to the official pricing page for verification. */
  pricingUrl: string;
}

/**
 * Pricing data for the default language models.
 * Used for cost estimation in evaluations and expense tracking.
 *
 * @remarks
 * Prices are subject to change. Verify against official sources before production use.
 */
export const THIRD_PARTY_MODEL_PRICING: { [K in SupportedProvider]: ModelPricing } = {
  // OpenAI GPT-5.1
  // Reference: https://openai.com/api/pricing
  openai: {
    inputPerMillion: 1.25,
    outputPerMillion: 10.00,
    cachedInputPerMillion: 0.125,
    pricingUrl: "https://openai.com/api/pricing",
  },

  // Anthropic Claude Sonnet 4.5
  // Reference: https://www.anthropic.com/pricing
  anthropic: {
    inputPerMillion: 3.00,
    outputPerMillion: 15.00,
    cachedInputPerMillion: 0.30, // Prompt caching read cost (≤200K tokens)
    pricingUrl: "https://www.anthropic.com/pricing",
  },

  // Google Gemini 3 Flash Preview
  // Reference: https://ai.google.dev/pricing
  google: {
    inputPerMillion: 0.50,
    outputPerMillion: 3.00,
    cachedInputPerMillion: 0.05, // Context caching price
    pricingUrl: "https://ai.google.dev/pricing",
  },
};

/**
 * Calculates the estimated cost for a request based on token usage.
 *
 * @param provider - The AI provider used
 * @param inputTokens - Number of input tokens consumed
 * @param outputTokens - Number of output tokens generated
 * @param cachedInputTokens - Number of input tokens served from cache (optional)
 * @returns Estimated cost in USD
 *
 * @example
 * ```typescript
 * const cost = calculateCost('openai', 2000, 500);
 * console.log(`Estimated cost: $${cost.toFixed(6)}`);
 * ```
 */
export function calculateCost(
  provider: SupportedProvider,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
): number {
  const pricing = THIRD_PARTY_MODEL_PRICING[provider];

  // Adjust input tokens: cached tokens are charged at cached rate, rest at full rate
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);

  const inputCost = (uncachedInputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  let cachedCost = 0;
  if (pricing.cachedInputPerMillion) {
    cachedCost = (cachedInputTokens / 1_000_000) * pricing.cachedInputPerMillion;
  }

  return inputCost + outputCost + cachedCost;
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}. Set ${name} in your environment or pass it in options.`);
  }
  return value;
}

/**
 * Creates a language model instance from serializable config.
 * Use this in steps to instantiate models from config passed through workflow.
 * Fetches credentials internally from environment variables to avoid exposing them in step I/O.
 */
export async function createLanguageModelFromConfig<P extends SupportedProvider = SupportedProvider>(
  provider: P,
  modelId: ModelIdByProvider[P],
  credentials?: WorkflowCredentialsInput,
): Promise<LanguageModel> {
  switch (provider) {
    case "openai": {
      const apiKey = await resolveProviderApiKey("openai", credentials);
      const openai = createOpenAI({ apiKey });
      return openai(modelId);
    }
    case "anthropic": {
      const apiKey = await resolveProviderApiKey("anthropic", credentials);
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelId);
    }
    case "google": {
      const apiKey = await resolveProviderApiKey("google", credentials);
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelId);
    }
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported provider: ${exhaustiveCheck}`);
    }
  }
}

/**
 * Creates an embedding model instance from serializable config.
 * Use this in steps to instantiate embedding models from config passed through workflow.
 * Fetches credentials internally from environment variables to avoid exposing them in step I/O.
 */
export async function createEmbeddingModelFromConfig<
  P extends SupportedEmbeddingProvider = SupportedEmbeddingProvider,
>(
  provider: P,
  modelId: EmbeddingModelIdByProvider[P],
  credentials?: WorkflowCredentialsInput,
): Promise<EmbeddingModel<string>> {
  switch (provider) {
    case "openai": {
      const apiKey = await resolveProviderApiKey("openai", credentials);
      const openai = createOpenAI({ apiKey });
      return openai.embedding(modelId);
    }
    case "google": {
      const apiKey = await resolveProviderApiKey("google", credentials);
      const google = createGoogleGenerativeAI({ apiKey });
      return google.textEmbeddingModel(modelId);
    }
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported embedding provider: ${exhaustiveCheck}`);
    }
  }
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
      const apiKey = env.OPENAI_API_KEY;
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
      const apiKey = env.ANTHROPIC_API_KEY;
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
      const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY;
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
      const apiKey = env.OPENAI_API_KEY;
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
      const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY;
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
