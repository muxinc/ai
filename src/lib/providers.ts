import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";

import type { Env } from "@mux/ai/env";
import env from "@mux/ai/env";
import { resolveProviderApiKey, resolveWorkflowCredentials } from "@mux/ai/lib/workflow-credentials";
import type { MuxAIOptions, WorkflowCredentialsInput } from "@mux/ai/types";

import type { EmbeddingModel, LanguageModel } from "ai";

export type SupportedProvider = "openai" | "baseten" | "anthropic" | "google";
export type SupportedEmbeddingProvider = "openai" | "baseten" | "google";

// Model ID unions inferred from ai-sdk provider call signatures
type OpenAIModelId = Parameters<ReturnType<typeof createOpenAI>["chat"]>[0];
type BasetenModelId = string;
type AnthropicModelId = Parameters<ReturnType<typeof createAnthropic>["chat"]>[0];
type GoogleModelId = Parameters<ReturnType<typeof createGoogleGenerativeAI>["chat"]>[0];

type OpenAIEmbeddingModelId = Parameters<ReturnType<typeof createOpenAI>["embedding"]>[0];
type BasetenEmbeddingModelId = string;
type GoogleEmbeddingModelId = Parameters<ReturnType<typeof createGoogleGenerativeAI>["textEmbeddingModel"]>[0];

export interface ModelIdByProvider {
  openai: OpenAIModelId;
  baseten: BasetenModelId;
  anthropic: AnthropicModelId;
  google: GoogleModelId;
}

export interface EmbeddingModelIdByProvider {
  openai: OpenAIEmbeddingModelId;
  baseten: BasetenEmbeddingModelId;
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

export const DEFAULT_LANGUAGE_MODELS: {
  [K in Exclude<SupportedProvider, "baseten">]: ModelIdByProvider[K];
} = {
  openai: "gpt-5.1",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-3-flash-preview",
};

const DEFAULT_EMBEDDING_MODELS: {
  [K in Exclude<SupportedEmbeddingProvider, "baseten">]: EmbeddingModelIdByProvider[K];
} = {
  openai: "text-embedding-3-small",
  google: "gemini-embedding-001",
};

function resolveBasetenLanguageModelId(model?: string): BasetenModelId {
  const resolved = model ?? env.BASETEN_MODEL;
  if (!resolved) {
    throw new Error(
      "Baseten model is required. Pass `model` when provider is \"baseten\" or set BASETEN_MODEL.",
    );
  }
  return resolved;
}

function resolveBasetenEmbeddingModelId(model?: string): BasetenEmbeddingModelId {
  const resolved = model ?? env.BASETEN_EMBEDDING_MODEL ?? env.BASETEN_MODEL;
  if (!resolved) {
    throw new Error(
      "Baseten embedding model is required. Pass `model` when provider is \"baseten\" or set BASETEN_EMBEDDING_MODEL.",
    );
  }
  return resolved;
}

export function getDefaultLanguageModel<P extends SupportedProvider = SupportedProvider>(
  provider: P,
): ModelIdByProvider[P] {
  if (provider === "baseten") {
    return resolveBasetenLanguageModelId() as ModelIdByProvider[P];
  }

  return DEFAULT_LANGUAGE_MODELS[provider as Exclude<SupportedProvider, "baseten">] as ModelIdByProvider[P];
}

export function getDefaultEmbeddingModel<P extends SupportedEmbeddingProvider = SupportedEmbeddingProvider>(
  provider: P,
): EmbeddingModelIdByProvider[P] {
  if (provider === "baseten") {
    return resolveBasetenEmbeddingModelId() as EmbeddingModelIdByProvider[P];
  }

  return DEFAULT_EMBEDDING_MODELS[provider as Exclude<SupportedEmbeddingProvider, "baseten">] as EmbeddingModelIdByProvider[P];
}

/**
 * All language models available per provider.
 * Includes the default model plus any additional models for evaluation and selection.
 * New models are additive — existing defaults are unchanged.
 */
export const LANGUAGE_MODELS: {
  [K in Exclude<SupportedProvider, "baseten">]: ModelIdByProvider[K][];
} = {
  openai: ["gpt-5.1", "gpt-5-mini"],
  anthropic: ["claude-sonnet-4-5"],
  google: ["gemini-3-flash-preview", "gemini-3.1-flash-lite-preview", "gemini-2.5-flash"],
};

export type ModelDeprecationPhase = "warn" | "blocked";

/**
 * Lifecycle metadata for a language model that is being phased out.
 *
 * @remarks
 * - "warn": model is still supported, but logs migration guidance.
 * - "blocked": model is no longer supported and throws with migration guidance.
 */
export interface LanguageModelDeprecation {
  provider: SupportedProvider;
  modelId: string;
  replacementModelId?: string;
  phase: ModelDeprecationPhase;
  deprecatedOn: string;
  sunsetOn?: string;
  reason?: string;
}

/**
 * Deprecated language models that remain supported during a grace period.
 * This enables gradual migration while clearly signaling planned removal.
 */
export const LANGUAGE_MODEL_DEPRECATIONS: LanguageModelDeprecation[] = [
  {
    provider: "google",
    modelId: "gemini-2.5-flash",
    replacementModelId: "gemini-3.1-flash-lite-preview",
    phase: "warn",
    deprecatedOn: "2026-03-03",
    sunsetOn: "2026-06-30",
    reason: "Gemini 3.1 Flash-Lite Preview offers better quality/latency/cost balance in current evals.",
  },
];

const warnedDeprecatedLanguageModels = new Set<string>();

/**
 * Returns deprecation metadata for a provider/model pair, if any.
 */
export function getLanguageModelDeprecation(
  provider: SupportedProvider,
  modelId: string,
): LanguageModelDeprecation | undefined {
  return LANGUAGE_MODEL_DEPRECATIONS.find(
    deprecation => deprecation.provider === provider && deprecation.modelId === modelId,
  );
}

function maybeWarnOrThrowForDeprecatedLanguageModel(provider: SupportedProvider, modelId: string): void {
  const deprecation = getLanguageModelDeprecation(provider, modelId);
  if (!deprecation) {
    return;
  }

  const replacementText = deprecation.replacementModelId ?
    ` Use replacement provider="${provider}" model="${deprecation.replacementModelId}" instead.` :
    "";
  const sunsetText = deprecation.sunsetOn ? ` Planned removal date: ${deprecation.sunsetOn}.` : "";
  const reasonText = deprecation.reason ? ` Reason: ${deprecation.reason}` : "";

  const message =
    deprecation.phase === "blocked" ?
      `Language model is no longer supported for provider="${provider}" model="${modelId}".${replacementText}${reasonText}` :
      `Language model is deprecated and in a grace period for provider="${provider}" model="${modelId}".${replacementText}${sunsetText}${reasonText}`;

  if (deprecation.phase === "blocked") {
    throw new Error(message);
  }

  const warningKey = `${provider}:${modelId}`;
  if (warnedDeprecatedLanguageModels.has(warningKey)) {
    return;
  }

  warnedDeprecatedLanguageModels.add(warningKey);
  console.warn(message);
}

export function resetLanguageModelDeprecationWarningsForTests(): void {
  warnedDeprecatedLanguageModels.clear();
}

/**
 * A (provider, modelId) pair used for evaluation iteration.
 */
export interface EvalModelConfig {
  provider: Exclude<SupportedProvider, "baseten">;
  modelId: ModelIdByProvider[Exclude<SupportedProvider, "baseten">];
}

export type EvalModelSelection = "default" | "all";

export interface ResolveEvalModelConfigsOptions {
  selection?: EvalModelSelection;
  modelPairs?: string[];
}

function getDefaultEvalModelConfigs(): EvalModelConfig[] {
  return (Object.entries(DEFAULT_LANGUAGE_MODELS) as [
    Exclude<SupportedProvider, "baseten">,
    ModelIdByProvider[Exclude<SupportedProvider, "baseten">],
  ][])
    .map(([provider, modelId]) => ({ provider, modelId }));
}

function getAllEvalModelConfigs(): EvalModelConfig[] {
  return (Object.entries(LANGUAGE_MODELS) as [
    Exclude<SupportedProvider, "baseten">,
    ModelIdByProvider[Exclude<SupportedProvider, "baseten">][],
  ][])
    .flatMap(([provider, models]) => models.map(modelId => ({ provider, modelId })));
}

function isSupportedProvider(value: string): value is Exclude<SupportedProvider, "baseten"> {
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

  if (!isSupportedProvider(provider)) {
    throw new Error(
      `Unsupported eval provider "${provider}" in "${value}". Supported providers: ${Object.keys(LANGUAGE_MODELS).join(", ")}.`,
    );
  }

  const supportedModels = LANGUAGE_MODELS[provider] as string[];
  if (!supportedModels.includes(modelId)) {
    throw new Error(
      `Unsupported eval model "${modelId}" for provider "${provider}". Supported models: ${supportedModels.join(", ")}.`,
    );
  }

  maybeWarnOrThrowForDeprecatedLanguageModel(provider, modelId);

  return {
    provider,
    modelId: modelId as ModelIdByProvider[Exclude<SupportedProvider, "baseten">],
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

export function resolveLanguageModelConfig<P extends SupportedProvider = SupportedProvider>(
  options: ModelRequestOptions<P> = {},
): { provider: P; modelId: ModelIdByProvider[P] } {
  const provider = options.provider || ("openai" as P);
  const modelId = (options.model ?? getDefaultLanguageModel(provider)) as ModelIdByProvider[P];
  maybeWarnOrThrowForDeprecatedLanguageModel(provider, modelId);

  return { provider, modelId };
}

export function resolveEmbeddingModelConfig<P extends SupportedEmbeddingProvider = "openai">(
  options: MuxAIOptions & { provider?: P; model?: EmbeddingModelIdByProvider[P] } = {},
): { provider: P; modelId: EmbeddingModelIdByProvider[P] } {
  const provider = options.provider || ("openai" as P);
  const modelId = (options.model ?? getDefaultEmbeddingModel(provider)) as EmbeddingModelIdByProvider[P];

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
  "gemini-3.1-flash-lite-preview": {
    inputPerMillion: 0.25,
    outputPerMillion: 1.50,
    cachedInputPerMillion: 0.025,
    pricingUrl: "https://ai.google.dev/gemini-api/docs/pricing",
  },
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
  if (provider === "baseten") {
    return 0;
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

function normalizeOpenAICompatibleBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed
    .replace(/\/(chat\/completions|responses|embeddings)\/?$/, "")
    .replace(/\/$/, "");
}

async function resolveBasetenBaseUrl(
  credentials?: WorkflowCredentialsInput,
  kind: "language" | "embedding" = "language",
): Promise<string> {
  const resolved = await resolveWorkflowCredentials(credentials);
  const record = resolved as Record<string, unknown>;
  const basetenBaseUrl = typeof record.basetenBaseUrl === "string" ? record.basetenBaseUrl : undefined;
  const basetenEmbeddingBaseUrl = typeof record.basetenEmbeddingBaseUrl === "string" ? record.basetenEmbeddingBaseUrl : undefined;
  const candidates = kind === "embedding" ?
      [basetenEmbeddingBaseUrl, env.BASETEN_EMBEDDING_BASE_URL, basetenBaseUrl, env.BASETEN_BASE_URL] :
      [basetenBaseUrl, env.BASETEN_BASE_URL];
  const normalized = normalizeOpenAICompatibleBaseUrl(candidates.find(Boolean) ?? "");

  if (!normalized) {
    const envVar = kind === "embedding" ? "BASETEN_EMBEDDING_BASE_URL" : "BASETEN_BASE_URL";
    throw new Error(
      `Baseten ${kind} base URL is required. Set ${envVar}${kind === "embedding" ? " (or BASETEN_BASE_URL)" : ""} or provide ${kind === "embedding" ? "basetenEmbeddingBaseUrl" : "basetenBaseUrl"} in credentials.`,
    );
  }

  return normalized;
}

function resolveBasetenBaseUrlFromEnv(kind: "language" | "embedding" = "language"): string {
  const candidates = kind === "embedding" ?
      [env.BASETEN_EMBEDDING_BASE_URL, env.BASETEN_BASE_URL] :
      [env.BASETEN_BASE_URL];
  const normalized = normalizeOpenAICompatibleBaseUrl(candidates.find(Boolean) ?? "");

  if (!normalized) {
    const envVar = kind === "embedding" ? "BASETEN_EMBEDDING_BASE_URL" : "BASETEN_BASE_URL";
    throw new Error(
      `Baseten ${kind} base URL is required. Set ${envVar}${kind === "embedding" ? " (or BASETEN_BASE_URL)" : ""}.`,
    );
  }

  return normalized;
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
  maybeWarnOrThrowForDeprecatedLanguageModel(provider, modelId);

  switch (provider) {
    case "openai": {
      const apiKey = await resolveProviderApiKey("openai", credentials);
      const openai = createOpenAI({ apiKey });
      return openai(modelId);
    }
    case "baseten": {
      const apiKey = await resolveProviderApiKey("baseten", credentials);
      const baseURL = await resolveBasetenBaseUrl(credentials, "language");
      const baseten = createOpenAI({ apiKey, baseURL });
      return baseten.chat(modelId);
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
): Promise<EmbeddingModel> {
  switch (provider) {
    case "openai": {
      const apiKey = await resolveProviderApiKey("openai", credentials);
      const openai = createOpenAI({ apiKey });
      return openai.embedding(modelId);
    }
    case "baseten": {
      const apiKey = await resolveProviderApiKey("baseten", credentials);
      const baseURL = await resolveBasetenBaseUrl(credentials, "embedding");
      const baseten = createOpenAI({ apiKey, baseURL });
      return baseten.embedding(modelId);
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
  const { provider, modelId } = resolveLanguageModelConfig(options);

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
    case "baseten": {
      const apiKey = env.BASETEN_API_KEY;
      requireEnv(apiKey, "BASETEN_API_KEY");
      const baseURL = resolveBasetenBaseUrlFromEnv("language");
      const baseten = createOpenAI({
        apiKey,
        baseURL,
      });

      return {
        provider,
        modelId,
        model: baseten.chat(modelId),
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
): { provider: P; modelId: EmbeddingModelIdByProvider[P]; model: EmbeddingModel } {
  const { provider, modelId } = resolveEmbeddingModelConfig(options);

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
    case "baseten": {
      const apiKey = env.BASETEN_API_KEY;
      requireEnv(apiKey, "BASETEN_API_KEY");
      const baseURL = resolveBasetenBaseUrlFromEnv("embedding");
      const baseten = createOpenAI({
        apiKey,
        baseURL,
      });

      return {
        provider,
        modelId,
        model: baseten.embedding(modelId),
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
