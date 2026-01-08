/**
 * Workflow Credentials Management
 *
 * This module provides a unified way to resolve credentials from multiple sources:
 * 1. A custom credentials provider (set via `setWorkflowCredentialsProvider`)
 * 2. Encrypted credentials passed directly to workflow functions
 * 3. Environment variables as fallback
 *
 * Credentials are merged in order of precedence: direct input > provider > environment.
 */
import env from "@mux/ai/env";
import type { Env } from "@mux/ai/env";
import type { SigningContext } from "@mux/ai/lib/url-signing";
import { decryptFromWorkflow, isEncryptedPayload } from "@mux/ai/lib/workflow-crypto";
import type { WorkflowCredentials, WorkflowCredentialsInput } from "@mux/ai/types";

/**
 * A function that returns workflow credentials, either synchronously or asynchronously.
 * Used to inject credentials from external sources (e.g., a secrets manager).
 */
export type WorkflowCredentialsProvider =
  () => Promise<WorkflowCredentials | undefined> | WorkflowCredentials | undefined;

/** Module-level credentials provider, set via `setWorkflowCredentialsProvider` */
let workflowCredentialsProvider: WorkflowCredentialsProvider | undefined;

/**
 * Registers a custom credentials provider for the module.
 * The provider will be called whenever credentials need to be resolved.
 */
export function setWorkflowCredentialsProvider(provider?: WorkflowCredentialsProvider): void {
  workflowCredentialsProvider = provider;
}

/**
 * Retrieves the workflow secret key from environment variables.
 * This key is used to decrypt encrypted credential payloads.
 */
function getWorkflowSecretKeyFromEnv(): string {
  const key = env.MUX_AI_WORKFLOW_SECRET_KEY;
  if (!key) {
    throw new Error("Workflow secret key is required. Set MUX_AI_WORKFLOW_SECRET_KEY environment variable.");
  }
  return key;
}

/**
 * Invokes the registered credentials provider (if any) and validates the result.
 */
async function resolveProviderCredentials(): Promise<WorkflowCredentials | undefined> {
  if (!workflowCredentialsProvider) {
    return undefined;
  }

  const provided = await workflowCredentialsProvider();
  if (!provided) {
    return undefined;
  }

  if (typeof provided !== "object") {
    throw new TypeError("Workflow credentials provider must return an object.");
  }

  return provided;
}

/**
 * Resolves workflow credentials by merging from multiple sources.
 *
 * Resolution order (later sources override earlier):
 * 1. Credentials from the registered provider
 * 2. Decrypted credentials (if input is an encrypted payload)
 *    OR plain credentials object (if input is already decrypted)
 *
 * @param credentials - Optional credentials input (encrypted or plain object)
 * @returns Merged credentials object
 */
export async function resolveWorkflowCredentials(
  credentials?: WorkflowCredentialsInput,
): Promise<WorkflowCredentials> {
  // Start with provider credentials as the base
  const providerCredentials = await resolveProviderCredentials();
  const resolved: WorkflowCredentials = providerCredentials ? { ...providerCredentials } : {};

  if (!credentials) {
    return resolved;
  }

  // Handle encrypted payloads by decrypting them first
  if (isEncryptedPayload(credentials)) {
    try {
      const decrypted = decryptFromWorkflow<WorkflowCredentials>(credentials, getWorkflowSecretKeyFromEnv());
      return { ...resolved, ...decrypted };
    } catch {
      throw new Error("Failed to decrypt workflow credentials.");
    }
  }

  // Plain credentials object - merge directly
  return { ...resolved, ...credentials };
}

/**
 * Resolves Mux API credentials (token ID and secret).
 *
 * Checks resolved workflow credentials first, then falls back to environment variables.
 * Throws if neither source provides valid credentials.
 *
 * @param credentials - Optional workflow credentials input
 * @returns Object containing muxTokenId and muxTokenSecret
 * @throws Error if Mux credentials are not available
 */
export async function resolveMuxCredentials(
  credentials?: WorkflowCredentialsInput,
): Promise<{ muxTokenId: string; muxTokenSecret: string }> {
  const resolved = await resolveWorkflowCredentials(credentials);

  // Try resolved credentials first, fall back to environment variables
  const muxTokenId = resolved.muxTokenId ?? env.MUX_TOKEN_ID;
  const muxTokenSecret = resolved.muxTokenSecret ?? env.MUX_TOKEN_SECRET;

  if (!muxTokenId || !muxTokenSecret) {
    throw new Error(
      "Mux credentials are required. Provide encrypted workflow credentials or set MUX_TOKEN_ID and MUX_TOKEN_SECRET environment variables.",
    );
  }

  return { muxTokenId, muxTokenSecret };
}

/** Supported AI/ML provider identifiers for API key resolution */
type ProviderApiKey = "openai" | "anthropic" | "google" | "hive" | "elevenlabs";

/**
 * Resolves an API key for a specific AI/ML provider.
 *
 * Checks resolved workflow credentials first, then falls back to the
 * provider-specific environment variable.
 *
 * @param provider - The provider identifier (e.g., "openai", "anthropic")
 * @param credentials - Optional workflow credentials input
 * @returns The resolved API key string
 * @throws Error if no API key is available for the specified provider
 */
export async function resolveProviderApiKey(
  provider: ProviderApiKey,
  credentials?: WorkflowCredentialsInput,
): Promise<string> {
  const resolved = await resolveWorkflowCredentials(credentials);

  // Map each provider to its credential field and env var fallback
  const apiKeyMap: Record<ProviderApiKey, string | undefined> = {
    openai: resolved.openaiApiKey ?? env.OPENAI_API_KEY,
    anthropic: resolved.anthropicApiKey ?? env.ANTHROPIC_API_KEY,
    google: resolved.googleApiKey ?? env.GOOGLE_GENERATIVE_AI_API_KEY,
    hive: resolved.hiveApiKey ?? env.HIVE_API_KEY,
    elevenlabs: resolved.elevenLabsApiKey ?? env.ELEVENLABS_API_KEY,
  };

  const apiKey = apiKeyMap[provider];
  if (!apiKey) {
    // Provide helpful error message with the correct env var name.
    // Using `satisfies` ensures these stay in sync with the Env schema.
    const envVarNames = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      google: "GOOGLE_GENERATIVE_AI_API_KEY",
      hive: "HIVE_API_KEY",
      elevenlabs: "ELEVENLABS_API_KEY",
    } as const satisfies Record<ProviderApiKey, keyof Env>;

    throw new Error(
      `${provider} API key is required. Provide encrypted workflow credentials or set ${envVarNames[provider]} environment variable.`,
    );
  }

  return apiKey;
}

/**
 * Resolves Mux URL signing context for generating signed playback URLs.
 *
 * Unlike other resolve functions, this returns undefined if signing keys
 * are not configured (signing is optional for public assets).
 *
 * @param credentials - Optional workflow credentials input
 * @returns SigningContext if keys are available, undefined otherwise
 */
export async function resolveMuxSigningContext(
  credentials?: WorkflowCredentialsInput,
): Promise<SigningContext | undefined> {
  const resolved = await resolveWorkflowCredentials(credentials);

  // Check both key components - both are required for signing
  const keyId = resolved.muxSigningKey ?? env.MUX_SIGNING_KEY;
  const keySecret = resolved.muxPrivateKey ?? env.MUX_PRIVATE_KEY;

  if (!keyId || !keySecret) {
    return undefined;
  }

  return { keyId, keySecret };
}
