import env from "@mux/ai/env";
import type {
  ModelRequestOptions,
  SupportedProvider,
} from "@mux/ai/lib/providers";
import {
  resolveLanguageModel,
} from "@mux/ai/lib/providers";
import { resolveMuxCredentials, resolveProviderApiKey } from "@mux/ai/lib/workflow-credentials";
import type { WorkflowCredentialsInput } from "@mux/ai/types";

/**
 * Gets Mux credentials from workflow credentials or environment variables.
 * Used internally by workflow steps to avoid passing credentials through step I/O.
 * Throws if credentials are not available.
 */
export async function getMuxCredentialsFromEnv(
  credentials?: WorkflowCredentialsInput,
): Promise<{ muxTokenId: string; muxTokenSecret: string }> {
  return resolveMuxCredentials(credentials);
}

/**
 * Gets an API key from workflow credentials or environment variables for the specified provider.
 * Used internally by workflow steps to avoid passing credentials through step I/O.
 * Throws if the API key is not available.
 */
export async function getApiKeyFromEnv(
  provider: "openai" | "anthropic" | "google" | "hive" | "elevenlabs",
  credentials?: WorkflowCredentialsInput,
): Promise<string> {
  return resolveProviderApiKey(provider, credentials);
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
  requiredProvider?: SupportedProvider,
): Promise<ValidatedCredentials> {
  const muxTokenId = env.MUX_TOKEN_ID;
  const muxTokenSecret = env.MUX_TOKEN_SECRET;
  const openaiApiKey = env.OPENAI_API_KEY;
  const anthropicApiKey = env.ANTHROPIC_API_KEY;
  const googleApiKey = env.GOOGLE_GENERATIVE_AI_API_KEY;

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
  credentials: ValidatedCredentials;
  provider: SupportedProvider;
  modelId: string;
}

/**
 * Validates credentials and resolves model configuration for a workflow.
 * This function is NOT a workflow step to avoid exposing credentials in step I/O.
 */
export async function createWorkflowConfig(
  options: ModelRequestOptions,
  provider?: SupportedProvider,
): Promise<WorkflowConfig> {
  const providerToUse = provider || options.provider || "openai";
  const credentials = await validateCredentials(providerToUse);
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
