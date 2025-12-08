import env from "../env";

import type {
  ModelRequestOptions,
  ResolvedModel,
  SupportedProvider,
} from "./providers";
import {
  resolveLanguageModel,
} from "./providers";

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
 * Validates and retrieves credentials from options or environment variables
 */
export function validateCredentials(
  options: ClientCredentials,
  requiredProvider?: SupportedProvider,
): ValidatedCredentials {
  const muxTokenId = options.muxTokenId ?? env.MUX_TOKEN_ID;
  const muxTokenSecret = options.muxTokenSecret ?? env.MUX_TOKEN_SECRET;
  const openaiApiKey = options.openaiApiKey ?? env.OPENAI_API_KEY;
  const anthropicApiKey = options.anthropicApiKey ?? env.ANTHROPIC_API_KEY;
  const googleApiKey =
    options.googleApiKey ?? env.GOOGLE_GENERATIVE_AI_API_KEY;

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

/**
 * Validates credentials and resolves model configuration for a workflow.
 * Returns only serializable data suitable for passing to workflow steps.
 */
export interface WorkflowConfig {
  credentials: ValidatedCredentials;
  provider: SupportedProvider;
  modelId: string;
}

export function createWorkflowConfig(
  options: ModelRequestOptions,
  provider?: SupportedProvider,
): WorkflowConfig {
  const providerToUse = provider || options.provider || "openai";
  const credentials = validateCredentials(options, providerToUse);
  const resolved = resolveLanguageModel({
    ...options,
    provider: providerToUse,
  });

  return {
    credentials,
    provider: resolved.provider,
    modelId: resolved.modelId as string,
  };
}
