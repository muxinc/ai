/**
 * Workflow Credentials Management
 *
 * This module provides a unified way to resolve credentials from multiple sources:
 * 1. A custom credentials provider (set via `setWorkflowCredentialsProvider`)
 * 2. Workflow-native serialized credentials passed directly to workflows
 * 3. Environment variables as fallback
 *
 * Credentials are merged in order of precedence: direct input > provider > environment.
 */
import env from "@mux/ai/env";
import type { Env } from "@mux/ai/env";
import type { SigningContext } from "@mux/ai/lib/url-signing";
import { WorkflowMuxClient } from "@mux/ai/lib/workflow-mux-client";
import { isWorkflowNativeCredentials } from "@mux/ai/lib/workflow-native-credentials";
import {
  normalizeWorkflowAnthropicClient,
  normalizeWorkflowElevenLabsClient,
  normalizeWorkflowGoogleClient,
  normalizeWorkflowHiveClient,
  normalizeWorkflowOpenAIClient,
} from "@mux/ai/lib/workflow-provider-clients";
import type {
  WorkflowAnthropicClient,
  WorkflowElevenLabsClient,
  WorkflowGoogleClient,
  WorkflowHiveClient,
  WorkflowOpenAIClient,
} from "@mux/ai/lib/workflow-provider-clients";
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
 * 2. Workflow-native serialized credentials
 *    OR plain credentials object
 *
 * @param credentials - Optional credentials input
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

  // Workflow-native serialized credentials container
  if (isWorkflowNativeCredentials(credentials)) {
    return { ...resolved, ...credentials.unwrap() };
  }

  // Plain credentials object - merge directly.
  return { ...resolved, ...credentials };
}

/**
 * Resolves a WorkflowMuxClient from workflow credentials or environment variables.
 *
 * Checks resolved workflow credentials for a muxClient first, then falls back
 * to constructing one from MUX_TOKEN_ID / MUX_TOKEN_SECRET (and optional
 * MUX_SIGNING_KEY / MUX_PRIVATE_KEY) environment variables.
 *
 * @param credentials - Optional workflow credentials input
 * @returns A WorkflowMuxClient instance
 * @throws Error if Mux credentials are not available
 */
export async function resolveMuxClient(
  credentials?: WorkflowCredentialsInput,
): Promise<WorkflowMuxClient> {
  const resolved = await resolveWorkflowCredentials(credentials);

  // Prefer a pre-built muxClient from credentials
  if (resolved.muxClient) {
    return resolved.muxClient;
  }

  // Fall back to environment variables
  const muxTokenId = env.MUX_TOKEN_ID;
  const muxTokenSecret = env.MUX_TOKEN_SECRET;

  if (!muxTokenId || !muxTokenSecret) {
    throw new Error(
      "Mux credentials are required. Provide a muxClient via workflow credentials or set MUX_TOKEN_ID and MUX_TOKEN_SECRET environment variables.",
    );
  }

  return new WorkflowMuxClient({
    tokenId: muxTokenId,
    tokenSecret: muxTokenSecret,
    signingKey: env.MUX_SIGNING_KEY,
    privateKey: env.MUX_PRIVATE_KEY,
  });
}

/** Supported AI/ML provider identifiers for API key resolution. */
export type ApiKeyProvider = "openai" | "anthropic" | "google" | "hive" | "elevenlabs";
export type ProviderClientProvider = "openai" | "anthropic" | "google" | "hive" | "elevenlabs";

export type WorkflowProviderClient =
  WorkflowOpenAIClient |
  WorkflowAnthropicClient |
  WorkflowGoogleClient |
  WorkflowHiveClient |
  WorkflowElevenLabsClient;

interface ProviderClientByProvider {
  openai: WorkflowOpenAIClient;
  anthropic: WorkflowAnthropicClient;
  google: WorkflowGoogleClient;
  hive: WorkflowHiveClient;
  elevenlabs: WorkflowElevenLabsClient;
}

type ProviderWithClientAndApiKey = ApiKeyProvider & ProviderClientProvider;

export type ProviderClientOrApiKeyResolution<P extends ProviderWithClientAndApiKey> =
  | { client: ProviderClientByProvider[P]; apiKey?: undefined } |
  { client?: undefined; apiKey: string };

function resolveProviderClientFromCredentials<P extends ProviderClientProvider>(
  provider: P,
  resolved: WorkflowCredentials,
): ProviderClientByProvider[P] | undefined {
  const record = resolved as Record<string, unknown>;

  switch (provider) {
    case "openai":
      return normalizeWorkflowOpenAIClient(record.openaiClient) as ProviderClientByProvider[P] | undefined;
    case "anthropic":
      return normalizeWorkflowAnthropicClient(record.anthropicClient) as ProviderClientByProvider[P] | undefined;
    case "google":
      return normalizeWorkflowGoogleClient(record.googleClient) as ProviderClientByProvider[P] | undefined;
    case "hive":
      return normalizeWorkflowHiveClient(record.hiveClient) as ProviderClientByProvider[P] | undefined;
    case "elevenlabs":
      return normalizeWorkflowElevenLabsClient(record.elevenLabsClient) as ProviderClientByProvider[P] | undefined;
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported provider client: ${exhaustiveCheck}`);
    }
  }
}

function resolveProviderApiKeyFromCredentials(
  provider: ApiKeyProvider,
  resolved: WorkflowCredentials,
): string {
  const record = resolved as Record<string, unknown>;
  const hiveClient = normalizeWorkflowHiveClient(record.hiveClient);
  const elevenLabsClient = normalizeWorkflowElevenLabsClient(record.elevenLabsClient);

  // Map each provider to its credential source and env var fallback
  const apiKeyMap: Record<ApiKeyProvider, string | undefined> = {
    openai: env.OPENAI_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    google: env.GOOGLE_GENERATIVE_AI_API_KEY,
    hive: hiveClient?.getApiKey() ?? env.HIVE_API_KEY,
    elevenlabs: elevenLabsClient?.getApiKey() ?? env.ELEVENLABS_API_KEY,
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
    } as const satisfies Record<ApiKeyProvider, keyof Env>;

    throw new Error(
      `${provider} API key is required. Provide a ${provider} client via workflow credentials or set ${envVarNames[provider]} environment variable.`,
    );
  }

  return apiKey;
}
/**
 * Resolves a provider client wrapper from workflow credentials.
 *
 * Supports both live class instances and serialized plain-object shapes for
 * compatibility with JSON-serialized workflow payloads.
 */
export async function resolveProviderClient(
  provider: "openai",
  credentials?: WorkflowCredentialsInput,
): Promise<WorkflowOpenAIClient | undefined>;
export async function resolveProviderClient(
  provider: "anthropic",
  credentials?: WorkflowCredentialsInput,
): Promise<WorkflowAnthropicClient | undefined>;
export async function resolveProviderClient(
  provider: "google",
  credentials?: WorkflowCredentialsInput,
): Promise<WorkflowGoogleClient | undefined>;
export async function resolveProviderClient(
  provider: "hive",
  credentials?: WorkflowCredentialsInput,
): Promise<WorkflowHiveClient | undefined>;
export async function resolveProviderClient(
  provider: "elevenlabs",
  credentials?: WorkflowCredentialsInput,
): Promise<WorkflowElevenLabsClient | undefined>;
export async function resolveProviderClient<P extends ProviderClientProvider>(
  provider: P,
  credentials?: WorkflowCredentialsInput,
): Promise<ProviderClientByProvider[P] | undefined> {
  const resolved = await resolveWorkflowCredentials(credentials);
  return resolveProviderClientFromCredentials(provider, resolved);
}

/**
 * Resolves either a provider client (preferred) or API key in a single pass.
 *
 * This avoids resolving workflow credentials twice in code paths that first try
 * a provider client and then fall back to an API key.
 */
export async function resolveProviderClientOrApiKey<P extends ProviderWithClientAndApiKey>(
  provider: P,
  credentials?: WorkflowCredentialsInput,
): Promise<ProviderClientOrApiKeyResolution<P>> {
  const resolved = await resolveWorkflowCredentials(credentials);
  const client = resolveProviderClientFromCredentials(provider, resolved);

  if (client) {
    return { client };
  }

  return { apiKey: resolveProviderApiKeyFromCredentials(provider, resolved) };
}

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
  provider: ApiKeyProvider,
  credentials?: WorkflowCredentialsInput,
): Promise<string> {
  const resolved = await resolveWorkflowCredentials(credentials);
  return resolveProviderApiKeyFromCredentials(provider, resolved);
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

  // Try muxClient first, then fall back to environment variables
  const keyId = resolved.muxClient?.getSigningKey() ?? env.MUX_SIGNING_KEY;
  const keySecret = resolved.muxClient?.getPrivateKey() ?? env.MUX_PRIVATE_KEY;

  if (!keyId || !keySecret) {
    return undefined;
  }

  return { keyId, keySecret };
}
