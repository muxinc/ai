import type {
  ModelIdByProvider,
  ModelRequestOptions,
  SupportedProvider,
} from "@mux/ai/lib/providers";
import {
  resolveLanguageModel,
} from "@mux/ai/lib/providers";
import type { ApiKeyProvider } from "@mux/ai/lib/workflow-credentials";
import { resolveMuxClient, resolveProviderApiKey } from "@mux/ai/lib/workflow-credentials";
import type { WorkflowCredentialsInput, WorkflowMuxClient } from "@mux/ai/types";

/**
 * Gets a WorkflowMuxClient from workflow credentials or environment variables.
 * Used internally by workflow steps to avoid passing credentials through step I/O.
 * Throws if Mux credentials are not available.
 */
export async function getMuxClientFromEnv(
  credentials?: WorkflowCredentialsInput,
): Promise<WorkflowMuxClient> {
  return resolveMuxClient(credentials);
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

export interface WorkflowConfig<P extends SupportedProvider = SupportedProvider> {
  muxClient: WorkflowMuxClient;
  provider: P;
  modelId: ModelIdByProvider[P];
}

/**
 * Resolves Mux client and model configuration for a workflow.
 * This function is NOT a workflow step to avoid exposing credentials in step I/O.
 */
export async function createWorkflowConfig<P extends SupportedProvider = SupportedProvider>(
  options: ModelRequestOptions<P>,
  provider?: P,
): Promise<WorkflowConfig<P>> {
  const providerToUse = provider || options.provider || ("openai" as P);
  const muxClient = await resolveMuxClient(options.credentials);
  const resolved = resolveLanguageModel({
    ...options,
    provider: providerToUse,
  });

  return {
    muxClient,
    provider: resolved.provider,
    modelId: resolved.modelId,
  };
}
