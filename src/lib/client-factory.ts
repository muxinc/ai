import Mux from "@mux/mux-node";

import env from "@mux/ai/env";
import type {
  ModelIdByProvider,
  ModelRequestOptions,
  SupportedProvider,
} from "@mux/ai/lib/providers";
import {
  resolveLanguageModel,
} from "@mux/ai/lib/providers";
import type { ApiKeyProvider } from "@mux/ai/lib/workflow-credentials";
import { resolveMuxCredentials, resolveProviderApiKey } from "@mux/ai/lib/workflow-credentials";
import type { WorkflowCredentialsInput } from "@mux/ai/types";

/**
 * Gets Mux credentials from workflow credentials or environment variables.
 * Used internally by workflow steps to avoid passing credentials through step I/O.
 * Throws if credentials are not available.
 */
export async function getMuxCredentialsFromEnv(
  credentials?: WorkflowCredentialsInput,
): Promise<{ muxTokenId?: string; muxTokenSecret?: string; authorizationToken?: string }> {
  return resolveMuxCredentials(credentials);
}

/**
 * Gets an API key from workflow credentials or environment variables for the specified provider.
 * Used internally by workflow steps to avoid passing credentials through step I/O.
 * Throws if the API key is not available.
 */
export async function getApiKeyFromEnv(
  provider: ApiKeyProvider,
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
  hiveApiKey?: string;
  elevenLabsApiKey?: string;
}

/**
 * Validates and retrieves credentials from options or environment variables.
 * This function is NOT a workflow step to avoid exposing credentials in step I/O.
 */
export async function validateCredentials<P extends ApiKeyProvider = SupportedProvider>(
  requiredProvider?: P,
): Promise<ValidatedCredentials> {
  const muxTokenId = env.MUX_TOKEN_ID;
  const muxTokenSecret = env.MUX_TOKEN_SECRET;
  const openaiApiKey = env.OPENAI_API_KEY;
  const anthropicApiKey = env.ANTHROPIC_API_KEY;
  const googleApiKey = env.GOOGLE_GENERATIVE_AI_API_KEY;
  const hiveApiKey = env.HIVE_API_KEY;
  const elevenLabsApiKey = env.ELEVENLABS_API_KEY;

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

  if (requiredProvider === "hive" && !hiveApiKey) {
    throw new Error(
      "Hive API key is required. Provide hiveApiKey in options or set HIVE_API_KEY environment variable.",
    );
  }

  if (requiredProvider === "elevenlabs" && !elevenLabsApiKey) {
    throw new Error(
      "ElevenLabs API key is required. Provide elevenLabsApiKey in options or set ELEVENLABS_API_KEY environment variable.",
    );
  }

  return {
    muxTokenId,
    muxTokenSecret,
    openaiApiKey,
    anthropicApiKey,
    googleApiKey,
    hiveApiKey,
    elevenLabsApiKey,
  };
}

export interface WorkflowConfig<P extends SupportedProvider = SupportedProvider> {
  credentials: ValidatedCredentials;
  provider: P;
  modelId: ModelIdByProvider[P];
}

/**
 * Validates credentials and resolves model configuration for a workflow.
 * This function is NOT a workflow step to avoid exposing credentials in step I/O.
 */
export async function createWorkflowConfig<P extends SupportedProvider = SupportedProvider>(
  options: ModelRequestOptions<P>,
  provider?: P,
): Promise<WorkflowConfig<P>> {
  const providerToUse = provider || options.provider || ("openai" as P);
  const credentials = await validateCredentials(providerToUse);
  const resolved = resolveLanguageModel({
    ...options,
    provider: providerToUse,
  });

  return {
    credentials,
    provider: resolved.provider,
    modelId: resolved.modelId,
  };
}

export async function muxClient(credentials?: WorkflowCredentialsInput) {
  const { muxTokenId, muxTokenSecret, authorizationToken } = await getMuxCredentialsFromEnv(credentials);

  const client = new Mux({
    tokenId: muxTokenId,
    tokenSecret: muxTokenSecret,
    authorizationToken,
  });

  return client;
}
