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
import type {
  WorkflowCredentials,
  WorkflowCredentialsInput,
  WorkflowMuxClient,
} from "@mux/ai/types";

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
 * Detects whether code is running inside a Workflow Dev Kit runtime.
 * getWorkflowMetadata throws when invoked outside a workflow.
 */
async function isWorkflowRuntime(): Promise<boolean> {
  try {
    const workflowModule = await import("workflow");
    if (typeof workflowModule.getWorkflowMetadata !== "function") {
      return false;
    }
    workflowModule.getWorkflowMetadata();
    return true;
  } catch {
    return false;
  }
}

/**
 * Determines if we should enforce encrypted credentials.
 * This triggers in workflow runtimes or when the workflow secret key is set.
 */
async function shouldEnforceEncryptedCredentials(): Promise<boolean> {
  return Boolean(env.MUX_AI_WORKFLOW_SECRET_KEY) || await isWorkflowRuntime();
}

/**
 * Retrieves the workflow secret key from environment variables.
 * This key is used to decrypt encrypted credential payloads.
 */
function getWorkflowSecretKeyFromEnv(): string {
  const key = env.MUX_AI_WORKFLOW_SECRET_KEY;
  if (!key) {
    throw new Error(
      "Workflow secret key is required. Set MUX_AI_WORKFLOW_SECRET_KEY environment variable.",
    );
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

  // Handle encrypted payloads by decrypting them first.
  if (isEncryptedPayload(credentials)) {
    try {
      const decrypted = await decryptFromWorkflow<WorkflowCredentials>(
        credentials,
        getWorkflowSecretKeyFromEnv(),
      );
      return { ...resolved, ...decrypted };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error.";
      throw new Error(`Failed to decrypt workflow credentials. ${detail}`);
    }
  }

  if (await shouldEnforceEncryptedCredentials()) {
    throw new Error(
      "Plaintext workflow credentials are not allowed when using Workflow Dev Kit." +
      " Pass encrypted credentials (encryptForWorkflow) or resolve secrets via environment variables.",
    );
  }

  // Plain credentials object - merge directly.
  return { ...resolved, ...credentials };
}

interface DirectMuxCredentials {
  tokenId: string;
  tokenSecret: string;
  signingKey?: string;
  privateKey?: string;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveDirectMuxCredentials(record: Record<string, unknown> | undefined): DirectMuxCredentials | undefined {
  const tokenId = readString(record, "muxTokenId");
  const tokenSecret = readString(record, "muxTokenSecret");
  const signingKey = readString(record, "muxSigningKey");
  const privateKey = readString(record, "muxPrivateKey");

  if (!tokenId && !tokenSecret && !signingKey && !privateKey) {
    return undefined;
  }

  if (!tokenId || !tokenSecret) {
    throw new Error(
      "Both muxTokenId and muxTokenSecret are required when passing direct Mux workflow credentials.",
    );
  }

  return {
    tokenId,
    tokenSecret,
    signingKey,
    privateKey,
  };
}

function createWorkflowMuxClient(options: DirectMuxCredentials): WorkflowMuxClient {
  return {
    async createClient() {
      // Dynamic import to avoid pulling mux-node into workflow VM bundles.
      const { default: MuxClient } = await import("@mux/mux-node");
      return new MuxClient({
        tokenId: options.tokenId,
        tokenSecret: options.tokenSecret,
      });
    },
    getSigningKey() {
      return options.signingKey;
    },
    getPrivateKey() {
      return options.privateKey;
    },
  };
}

/**
 * Resolves a WorkflowMuxClient from workflow credentials or environment variables.
 *
 * Checks direct workflow credentials first (muxTokenId/muxTokenSecret),
 * then provider credentials, then falls back to MUX_TOKEN_ID / MUX_TOKEN_SECRET
 * (and optional MUX_SIGNING_KEY / MUX_PRIVATE_KEY) environment variables.
 *
 * @param credentials - Optional workflow credentials input
 * @returns A WorkflowMuxClient instance
 * @throws Error if Mux credentials are not available
 */
export async function resolveMuxClient(
  credentials?: WorkflowCredentialsInput,
): Promise<WorkflowMuxClient> {
  const resolved = await resolveWorkflowCredentials(credentials);
  const resolvedRecord = resolved as Record<string, unknown>;
  const resolvedMuxCredentials = resolveDirectMuxCredentials(resolvedRecord);
  if (resolvedMuxCredentials) {
    return createWorkflowMuxClient(resolvedMuxCredentials);
  }

  // Fall back to environment variables
  const muxTokenId = env.MUX_TOKEN_ID;
  const muxTokenSecret = env.MUX_TOKEN_SECRET;

  if (!muxTokenId || !muxTokenSecret) {
    throw new Error(
      "Mux credentials are required. Provide muxTokenId/muxTokenSecret via workflow credentials, or set MUX_TOKEN_ID and MUX_TOKEN_SECRET environment variables.",
    );
  }

  return createWorkflowMuxClient({
    tokenId: muxTokenId,
    tokenSecret: muxTokenSecret,
    signingKey: env.MUX_SIGNING_KEY,
    privateKey: env.MUX_PRIVATE_KEY,
  });
}

/** Supported AI/ML provider identifiers for API key resolution. */
export type ApiKeyProvider = "openai" | "anthropic" | "google" | "hive" | "elevenlabs";

function resolveProviderApiKeyFromCredentials(
  provider: ApiKeyProvider,
  resolved: WorkflowCredentials,
): string {
  const record = resolved as Record<string, unknown>;
  const openaiApiKey = readString(record, "openaiApiKey");
  const anthropicApiKey = readString(record, "anthropicApiKey");
  const googleApiKey = readString(record, "googleApiKey");
  const hiveApiKey = readString(record, "hiveApiKey");
  const elevenLabsApiKey = readString(record, "elevenLabsApiKey");

  // Map each provider to its credential source and env var fallback
  const apiKeyMap: Record<ApiKeyProvider, string | undefined> = {
    openai: openaiApiKey ?? env.OPENAI_API_KEY,
    anthropic: anthropicApiKey ?? env.ANTHROPIC_API_KEY,
    google: googleApiKey ?? env.GOOGLE_GENERATIVE_AI_API_KEY,
    hive: hiveApiKey ?? env.HIVE_API_KEY,
    elevenlabs: elevenLabsApiKey ?? env.ELEVENLABS_API_KEY,
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
      `${provider} API key is required. Provide ${provider} credentials via workflow credentials or set ${envVarNames[provider]} environment variable.`,
    );
  }

  return apiKey;
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
  const resolvedRecord = resolved as Record<string, unknown>;

  // Try direct credentials first, then fall back to environment variables.
  const keyId = readString(resolvedRecord, "muxSigningKey") ?? env.MUX_SIGNING_KEY;
  const keySecret =
    readString(resolvedRecord, "muxPrivateKey") ?? env.MUX_PRIVATE_KEY;

  if (!keyId || !keySecret) {
    return undefined;
  }

  return { keyId, keySecret };
}
