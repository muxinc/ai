import { createAnthropic } from "@ai-sdk/anthropic";
import { createGateway } from "@ai-sdk/gateway";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";

import type { Env } from "@mux/ai/env";
import env from "@mux/ai/env";
import { resolveProviderApiKey } from "@mux/ai/lib/workflow-credentials";
import type { MuxAIOptions, WorkflowCredentialsInput } from "@mux/ai/types";

import type { EmbeddingModel, LanguageModel } from "ai";

export type EvalSupportedProvider = "openai" | "anthropic" | "google";
export type SupportedProvider = EvalSupportedProvider | "vercel";
export type SupportedEmbeddingProvider = "openai" | "google";

// Model ID unions inferred from ai-sdk provider call signatures
type OpenAIModelId = Parameters<ReturnType<typeof createOpenAI>["chat"]>[0];
type AnthropicModelId = Parameters<ReturnType<typeof createAnthropic>["chat"]>[0];
type GoogleModelId = Parameters<ReturnType<typeof createGoogleGenerativeAI>["chat"]>[0];
type VercelModelId = Parameters<ReturnType<typeof createGateway>["chat"]>[0];

type OpenAIEmbeddingModelId = Parameters<ReturnType<typeof createOpenAI>["embedding"]>[0];
type GoogleEmbeddingModelId = Parameters<ReturnType<typeof createGoogleGenerativeAI>["textEmbeddingModel"]>[0];

export interface ModelIdByProvider {
  openai: OpenAIModelId;
  anthropic: AnthropicModelId;
  google: GoogleModelId;
  vercel: VercelModelId;
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

export const DEFAULT_LANGUAGE_MODELS: { [K in EvalSupportedProvider]: ModelIdByProvider[K] } = {
  openai: "gpt-5.1",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-3-flash-preview",
};

const DEFAULT_EMBEDDING_MODELS: { [K in SupportedEmbeddingProvider]: EmbeddingModelIdByProvider[K] } = {
  openai: "text-embedding-3-small",
  google: "gemini-embedding-001",
};

/**
 * All language models available per provider.
 * Includes the default model plus any additional models for evaluation and selection.
 * New models are additive — existing defaults are unchanged.
 */
export const LANGUAGE_MODELS: { [K in EvalSupportedProvider]: ModelIdByProvider[K][] } = {
  openai: ["gpt-5.1", "gpt-5-mini"],
  anthropic: ["claude-sonnet-4-5"],
  google: ["gemini-3-flash-preview", "gemini-2.5-flash"],
};

const EVAL_DEFAULT_LANGUAGE_MODELS = DEFAULT_LANGUAGE_MODELS;

const EVAL_LANGUAGE_MODELS = LANGUAGE_MODELS;

/**
 * A (provider, modelId) pair used for evaluation iteration.
 */
export interface EvalModelConfig {
  provider: EvalSupportedProvider;
  modelId: ModelIdByProvider[EvalSupportedProvider];
}

export type EvalModelSelection = "default" | "all";

export interface ResolveEvalModelConfigsOptions {
  selection?: EvalModelSelection;
  modelPairs?: string[];
}

function getDefaultEvalModelConfigs(): EvalModelConfig[] {
  return (Object.entries(EVAL_DEFAULT_LANGUAGE_MODELS) as [EvalSupportedProvider, ModelIdByProvider[EvalSupportedProvider]][])
    .map(([provider, modelId]) => ({ provider, modelId }));
}

function getAllEvalModelConfigs(): EvalModelConfig[] {
  return (Object.entries(EVAL_LANGUAGE_MODELS) as [EvalSupportedProvider, ModelIdByProvider[EvalSupportedProvider][]][])
    .flatMap(([provider, models]) => models.map(modelId => ({ provider, modelId })));
}

function isSupportedEvalProvider(value: string): value is EvalSupportedProvider {
  return value === "openai" || value === "anthropic" || value === "google";
}

function parseEvalModelPair(value: string): EvalModelConfig {
  const trimmed = value.trim();
  const [providerRaw, modelIdRaw] = trimmed.split(":", 2);
  const provider = providerRaw?.trim();
  const modelId = modelIdRaw?.trim();

  if (!provider || !modelId) {
    throw new Error(
      `Invalid eval model pair "${value}". Use "provider:model" (example: "openai:gpt-5.1").`,
    );
  }

  if (!isSupportedEvalProvider(provider)) {
    throw new Error(
      `Unsupported eval provider "${provider}" in "${value}". Supported providers: ${Object.keys(EVAL_LANGUAGE_MODELS).join(", ")}.`,
    );
  }

  const supportedModels = EVAL_LANGUAGE_MODELS[provider] as string[];
  if (!supportedModels.includes(modelId)) {
    throw new Error(
      `Unsupported eval model "${modelId}" for provider "${provider}". Supported models: ${supportedModels.join(", ")}.`,
    );
  }

  return {
    provider,
    modelId: modelId as ModelIdByProvider[EvalSupportedProvider],
  };
}

/**
 * Resolves eval model configurations.
 *
 * Selection order:
 * 1) Explicit model pairs (provider:model)
 * 2) Selection mode ("default" | "all")
 * 3) Default mode ("default")
 */
export function resolveEvalModelConfigs(options: ResolveEvalModelConfigsOptions = {}): EvalModelConfig[] {
  const explicitPairs = options.modelPairs?.map(value => value.trim()).filter(Boolean) ?? [];
  if (explicitPairs.length > 0) {
    const dedupedPairs = Array.from(new Set(explicitPairs));
    return dedupedPairs.map(parseEvalModelPair);
  }

  const selection = options.selection ?? "default";
  if (selection === "all") {
    return getAllEvalModelConfigs();
  }

  return getDefaultEvalModelConfigs();
}

/**
 * Environment variables for selecting eval models at runtime.
 *
 * - MUX_AI_EVAL_MODEL_SET: "default" | "all" (default: "default")
 * - MUX_AI_EVAL_MODELS: comma-separated "provider:model" pairs
 *   (takes precedence over MUX_AI_EVAL_MODEL_SET)
 */
export function resolveEvalModelConfigsFromEnv(environment: Env = env): EvalModelConfig[] {
  const rawSelection = environment.MUX_AI_EVAL_MODEL_SET?.trim();
  const rawModelPairs = environment.MUX_AI_EVAL_MODELS?.trim();
  let selection: EvalModelSelection;
  if (!rawSelection || rawSelection === "default") {
    selection = "default";
  } else if (rawSelection === "all") {
    selection = "all";
  } else {
    throw new Error(
      `Invalid MUX_AI_EVAL_MODEL_SET="${rawSelection}". Expected "default" or "all".`,
    );
  }

  let modelPairs: string[] | undefined;
  if (rawModelPairs) {
    modelPairs = rawModelPairs.split(",").map(value => value.trim()).filter(Boolean);
  }

  return resolveEvalModelConfigs({
    selection,
    modelPairs,
  });
}

/**
 * Flattened list of (provider, modelId) pairs for evaluation iteration.
 * Resolved from env so eval runs can target default models, all models, or an explicit list.
 */
export const EVAL_MODEL_CONFIGS: EvalModelConfig[] = resolveEvalModelConfigsFromEnv();

function resolveRequestedLanguageModelId<P extends SupportedProvider>(
  provider: P,
  requestedModelId: ModelIdByProvider[P] | undefined,
): ModelIdByProvider[P] {
  if (provider === "vercel") {
    if (!requestedModelId) {
      throw new Error(
        "Provider \"vercel\" requires an explicit model (e.g. \"openai/gpt-5-mini\"). AI Gateway model routing is open-ended and has no fixed default in @mux/ai.",
      );
    }
    return requestedModelId;
  }

  return (requestedModelId ?? DEFAULT_LANGUAGE_MODELS[provider as EvalSupportedProvider]) as ModelIdByProvider[P];
}

export function resolveLanguageModelConfig<P extends SupportedProvider = SupportedProvider>(
  options: ModelRequestOptions<P> = {},
): { provider: P; modelId: ModelIdByProvider[P] } {
  const provider = options.provider || ("openai" as P);
  const modelId = resolveRequestedLanguageModelId(provider, options.model);

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
// Sources (verified on 2026-02-17):
// - OpenAI: https://openai.com/api/pricing
// - Anthropic: https://www.anthropic.com/pricing
// - Google: https://ai.google.dev/gemini-api/docs/pricing
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
 * Per-model pricing data for all supported language models.
 * Used for model-specific cost estimation in evaluations and expense tracking.
 *
 * @remarks
 * Prices are subject to change. Verify against official sources before production use.
 * When adding a new model to LANGUAGE_MODELS, add its pricing here as well.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI models
  // Reference: https://openai.com/api/pricing
  "gpt-5.1": {
    inputPerMillion: 1.25,
    outputPerMillion: 10.00,
    cachedInputPerMillion: 0.125,
    pricingUrl: "https://openai.com/api/pricing",
  },
  "gpt-5-mini": {
    inputPerMillion: 0.25,
    outputPerMillion: 2.00,
    cachedInputPerMillion: 0.025,
    pricingUrl: "https://openai.com/api/pricing",
  },
  // Anthropic models
  // Reference: https://www.anthropic.com/pricing
  "claude-sonnet-4-5": {
    inputPerMillion: 3.00,
    outputPerMillion: 15.00,
    cachedInputPerMillion: 0.30,
    pricingUrl: "https://www.anthropic.com/pricing",
  },

  // Google models
  // Reference: https://ai.google.dev/pricing
  "gemini-3-flash-preview": {
    inputPerMillion: 0.50,
    outputPerMillion: 3.00,
    cachedInputPerMillion: 0.05,
    pricingUrl: "https://ai.google.dev/gemini-api/docs/pricing",
  },
  "gemini-2.5-flash": {
    inputPerMillion: 0.30,
    outputPerMillion: 2.50,
    cachedInputPerMillion: 0.03,
    pricingUrl: "https://ai.google.dev/gemini-api/docs/pricing",
  },
};

/**
 * Calculates the estimated cost for a request based on token usage and model-specific pricing.
 *
 * @param modelId - The specific model ID used
 * @param inputTokens - Number of input tokens consumed
 * @param outputTokens - Number of output tokens generated
 * @param cachedInputTokens - Number of input tokens served from cache (optional)
 * @returns Estimated cost in USD
 *
 * @example
 * ```typescript
 * const cost = calculateModelCost('gpt-5-mini', 2000, 500);
 * console.log(`Estimated cost: $${cost.toFixed(6)}`);
 * ```
 */
export function calculateModelCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
): number {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing) {
    throw new Error(`No pricing data for model: ${modelId}. Add pricing to MODEL_PRICING in providers.ts.`);
  }

  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);

  const inputCost = (uncachedInputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  let cachedCost = 0;
  if (pricing.cachedInputPerMillion) {
    cachedCost = (cachedInputTokens / 1_000_000) * pricing.cachedInputPerMillion;
  }

  return inputCost + outputCost + cachedCost;
}

/**
 * Calculates the estimated cost for a request based on token usage.
 * Uses each provider's default model pricing from MODEL_PRICING.
 * Provider "vercel" is intentionally excluded because AI Gateway model pricing
 * is open-ended and depends on the routed model.
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
  if (provider === "vercel") {
    throw new Error(
      "calculateCost does not support provider 'vercel'. Vercel AI Gateway can route to many model families with different prices. Use calculateModelCost(modelId, ...) with explicit pricing data instead.",
    );
  }

  const defaultModelId = DEFAULT_LANGUAGE_MODELS[provider];
  return calculateModelCost(defaultModelId, inputTokens, outputTokens, cachedInputTokens);
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
    case "vercel": {
      const apiKey = await resolveProviderApiKey("vercel", credentials);
      const gateway = createGateway({ apiKey });
      return gateway(modelId);
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
): Promise<EmbeddingModel> {
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
  const modelId = resolveRequestedLanguageModelId(provider, options.model);

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
    case "vercel": {
      const apiKey = env.AI_GATEWAY_API_KEY;
      requireEnv(apiKey, "AI_GATEWAY_API_KEY");
      const gateway = createGateway({
        apiKey,
      });

      return {
        provider,
        modelId,
        model: gateway(modelId),
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
): { provider: P; modelId: EmbeddingModelIdByProvider[P]; model: EmbeddingModel } {
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
