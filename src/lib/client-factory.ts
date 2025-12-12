import env from "../env.ts";

import type {
  ModelRequestOptions,
  SupportedProvider,
} from "./providers.ts";
import {
  resolveLanguageModel,
} from "./providers.ts";

/**
 * Gets Mux credentials, preferring explicit credentials over environment variables.
 * Used internally by workflow steps.
 *
 * @param explicit - Credentials explicitly passed by the user (safe to use in step I/O)
 * @param explicit.muxTokenId - Mux token ID
 * @param explicit.muxTokenSecret - Mux token secret
 */
export function getMuxCredentials(explicit?: { muxTokenId?: string; muxTokenSecret?: string }): { muxTokenId: string; muxTokenSecret: string } {
  const muxTokenId = explicit?.muxTokenId ?? env.MUX_TOKEN_ID;
  const muxTokenSecret = explicit?.muxTokenSecret ?? env.MUX_TOKEN_SECRET;

  if (!muxTokenId || !muxTokenSecret) {
    throw new Error(
      "Mux credentials are required. Set MUX_TOKEN_ID and MUX_TOKEN_SECRET environment variables.",
    );
  }

  return { muxTokenId, muxTokenSecret };
}

/**
 * Gets an API key for the specified provider, preferring explicit credentials over environment variables.
 * Used internally by workflow steps.
 *
 * @param provider - The provider to get credentials for
 * @param explicit - Credentials explicitly passed by the user (safe to use in step I/O)
 * @param explicit.openaiApiKey - OpenAI API key
 * @param explicit.anthropicApiKey - Anthropic API key
 * @param explicit.googleApiKey - Google API key
 * @param explicit.hiveApiKey - Hive API key
 * @param explicit.elevenLabsApiKey - ElevenLabs API key
 */
export function getApiKey(
  provider: "openai" | "anthropic" | "google" | "hive" | "elevenlabs",
  explicit?: { openaiApiKey?: string; anthropicApiKey?: string; googleApiKey?: string; hiveApiKey?: string; elevenLabsApiKey?: string },
): string {
  const explicitKeyMap: Record<string, string | undefined> = {
    openai: explicit?.openaiApiKey,
    anthropic: explicit?.anthropicApiKey,
    google: explicit?.googleApiKey,
    hive: explicit?.hiveApiKey,
    elevenlabs: explicit?.elevenLabsApiKey,
  };

  const envVarMap: Record<string, string | undefined> = {
    openai: env.OPENAI_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    google: env.GOOGLE_GENERATIVE_AI_API_KEY,
    hive: env.HIVE_API_KEY,
    elevenlabs: env.ELEVENLABS_API_KEY,
  };

  const apiKey = explicitKeyMap[provider] ?? envVarMap[provider];
  if (!apiKey) {
    const envVarNames: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      google: "GOOGLE_GENERATIVE_AI_API_KEY",
      hive: "HIVE_API_KEY",
      elevenlabs: "ELEVENLABS_API_KEY",
    };
    throw new Error(
      `${provider} API key is required. Set ${envVarNames[provider]} environment variable.`,
    );
  }

  return apiKey;
}

export interface ClientCredentials {
  muxTokenId?: string;
  muxTokenSecret?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
}

export interface ValidatedCredentials {
  muxTokenId: string;
  muxTokenSecret: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
}

/**
 * Validates and retrieves credentials from options or environment variables.
 * This function is NOT a workflow step to avoid exposing credentials in step I/O.
 */
export async function validateCredentials(
  options: ClientCredentials,
  requiredProvider?: SupportedProvider,
): Promise<ValidatedCredentials> {
  const muxTokenId = options.muxTokenId ?? env.MUX_TOKEN_ID;
  const muxTokenSecret = options.muxTokenSecret ?? env.MUX_TOKEN_SECRET;
  const openaiApiKey = options.openaiApiKey ?? env.OPENAI_API_KEY;
  const anthropicApiKey = options.anthropicApiKey ?? env.ANTHROPIC_API_KEY;
  const googleApiKey = options.googleApiKey ?? env.GOOGLE_GENERATIVE_AI_API_KEY;

  if (!muxTokenId || !muxTokenSecret) {
    throw new Error(
      "Mux credentials are required. Provide muxTokenId and muxTokenSecret in options or set MUX_TOKEN_ID and MUX_TOKEN_SECRET environment variables.",
    );
  }

  if (requiredProvider === "openai" && !openaiApiKey) {
    throw new Error(
      "OpenAI API key is required. Provide openaiApiKey in options or set OPENAI_API_KEY environment variable.",
    );
  }

  if (requiredProvider === "anthropic" && !anthropicApiKey) {
    throw new Error(
      "Anthropic API key is required. Provide anthropicApiKey in options or set ANTHROPIC_API_KEY environment variable.",
    );
  }

  if (requiredProvider === "google" && !googleApiKey) {
    throw new Error(
      "Google Generative AI API key is required. Provide googleApiKey in options or set GOOGLE_GENERATIVE_AI_API_KEY environment variable.",
    );
  }

  return {
    muxTokenId,
    muxTokenSecret,
    openaiApiKey,
    anthropicApiKey,
    googleApiKey,
  };
}

export interface WorkflowConfig {
  provider: SupportedProvider;
  modelId: string;
  /** Credentials passed explicitly by the user (not from ENV). Safe to pass through step I/O. */
  explicitCredentials?: Partial<ValidatedCredentials>;
}

/**
 * Validates credentials and resolves model configuration for a workflow.
 * This function is NOT a workflow step to avoid exposing credentials in step I/O.
 *
 * Only credentials explicitly passed in options are included in explicitCredentials.
 * ENV-based credentials are validated but not returned (steps fetch them internally).
 */
export async function createWorkflowConfig(
  options: ModelRequestOptions,
  provider?: SupportedProvider,
): Promise<WorkflowConfig> {
  const providerToUse = provider || options.provider || "openai";

  // Validate that all required credentials are available (from options or ENV)
  await validateCredentials(options, providerToUse);

  const resolved = resolveLanguageModel({
    ...options,
    provider: providerToUse,
  });

  // Only include credentials that were explicitly passed (not from ENV)
  // These are safe to pass through step I/O since user opted in
  const explicitCredentials: Partial<ValidatedCredentials> = {};
  if (options.muxTokenId)
    explicitCredentials.muxTokenId = options.muxTokenId;
  if (options.muxTokenSecret)
    explicitCredentials.muxTokenSecret = options.muxTokenSecret;
  if (options.openaiApiKey)
    explicitCredentials.openaiApiKey = options.openaiApiKey;
  if (options.anthropicApiKey)
    explicitCredentials.anthropicApiKey = options.anthropicApiKey;
  if (options.googleApiKey)
    explicitCredentials.googleApiKey = options.googleApiKey;

  return {
    provider: resolved.provider,
    modelId: resolved.modelId as string,
    explicitCredentials: Object.keys(explicitCredentials).length > 0 ? explicitCredentials : undefined,
  };
}
