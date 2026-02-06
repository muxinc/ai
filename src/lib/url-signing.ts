import env from "@mux/ai/env";
import { resolveMuxSigningContext } from "@mux/ai/lib/workflow-credentials";
import type { WorkflowCredentialsInput } from "@mux/ai/types";

import type Mux from "@mux/mux-node";

/**
 * Context required to sign URLs for signed playback IDs.
 */
export interface SigningContext {
  /** The signing key ID from Mux dashboard. */
  keyId: string;
  /** The base64-encoded private key from Mux dashboard. */
  keySecret: string;
  /** Token expiration time (e.g. '1h', '1d'). Defaults to '1h'. */
  expiration?: string;
}

/**
 * Token type determines which Mux service the token is valid for.
 */
export type TokenType = "video" | "thumbnail" | "storyboard" | "gif";

/**
 * Resolves signing context from config or environment variables.
 * Returns undefined if signing keys are not configured.
 */
export function getMuxSigningContextFromEnv(): SigningContext | undefined {
  const keyId = env.MUX_SIGNING_KEY;
  const keySecret = env.MUX_PRIVATE_KEY;

  if (!keyId || !keySecret) {
    return undefined;
  }

  return { keyId, keySecret };
}

/**
 * Creates a Mux client configured for JWT signing.
 * This client is used internally for signing operations.
 */
async function createSigningClient(context: SigningContext): Promise<Mux> {
  // Dynamic import to prevent @mux/mux-node (and its transitive dep jose)
  // from being bundled into workflow VM code where `require` is unavailable.
  const { default: MuxClient } = await import("@mux/mux-node");
  return new MuxClient({
    // These are not needed for signing, but the SDK requires them
    // Using empty strings as we only need the jwt functionality
    tokenId: env.MUX_TOKEN_ID || "",
    tokenSecret: env.MUX_TOKEN_SECRET || "",
    jwtSigningKey: context.keyId,
    jwtPrivateKey: context.keySecret,
  });
}

/**
 * Generates a signed token for a playback ID using the Mux SDK.
 *
 * @param playbackId - The Mux playback ID to sign
 * @param context - Signing context with key credentials
 * @param type - Token type (video, thumbnail, storyboard, gif)
 * @param params - Additional parameters for thumbnail/storyboard tokens (values will be stringified)
 * @returns Signed JWT token
 */
export async function signPlaybackId(
  playbackId: string,
  context: SigningContext,
  type: TokenType = "video",
  params?: Record<string, string | number>,
): Promise<string> {
  "use step";
  const client = await createSigningClient(context);

  // Convert params to Record<string, string> as required by the SDK
  const stringParams = params ?
      Object.fromEntries(
        Object.entries(params).map(([key, value]) => [key, String(value)]),
      ) :
    undefined;

  return client.jwt.signPlaybackId(playbackId, {
    type,
    expiration: context.expiration || "1h",
    params: stringParams,
  });
}

/**
 * Appends a signed token to a Mux URL.
 *
 * @param url - The base Mux URL (e.g. https://image.mux.com/{playbackId}/thumbnail.png)
 * @param playbackId - The Mux playback ID
 * @param context - Signing context with key credentials
 * @param type - Token type for the URL
 * @param params - Additional parameters for the token
 * @returns URL with token query parameter appended
 */
export async function signUrl(
  url: string,
  playbackId: string,
  context?: SigningContext,
  type: TokenType = "video",
  params?: Record<string, string | number>,
  credentials?: WorkflowCredentialsInput,
): Promise<string> {
  "use step";
  const resolvedContext = context ?? await resolveMuxSigningContext(credentials);
  if (!resolvedContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. " +
      "Provide a muxClient with signing keys or set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }
  const token = await signPlaybackId(playbackId, resolvedContext, type, params);
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${token}`;
}
