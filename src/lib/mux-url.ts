import env from "../env.ts";
import type { WorkflowCredentialsInput } from "../types.ts";

import { MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "./mux-ai-error.ts";
import { resolveWorkflowCredentials } from "./workflow-credentials.ts";

export type MuxPlaybackService = "image" | "stream";

const DEFAULT_MUX_DOMAIN = "mux.com";

type LegacyOverrideEnvVarName = "MUX_IMAGE_URL_OVERRIDE" | "MUX_STREAM_URL_OVERRIDE";

/** A misconfigured playback domain: the caller's argument, or the service's configuration. */
function invalidPlaybackDomainError(message: string, setting: string, source: typeof MUX_AI_ERROR_SOURCES.REQUEST | typeof MUX_AI_ERROR_SOURCES.INTERNAL): MuxAiError {
  return new MuxAiError(message, {
    type: source === MUX_AI_ERROR_SOURCES.INTERNAL ?
      MUX_AI_ERROR_TYPES.SERVER_ERROR :
      MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
    source,
    facts: { setting },
  });
}

function normalizeOrigin(value: string, envVarName: LegacyOverrideEnvVarName): string {
  const trimmed = value.trim();
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;

  const exampleHostname = envVarName === "MUX_IMAGE_URL_OVERRIDE" ?
    "image.example.mux.com" :
    "stream.example.mux.com";

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw invalidPlaybackDomainError(
      `Invalid ${envVarName}. Provide a hostname (e.g. "${exampleHostname}") ` +
      `or a URL origin (e.g. "https://${exampleHostname}").`,
      envVarName,
      MUX_AI_ERROR_SOURCES.INTERNAL,
    );
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    throw invalidPlaybackDomainError(
      `Invalid ${envVarName}. Only a hostname/origin is allowed ` +
      `(no credentials, query params, hash fragments, or path).`,
      envVarName,
      MUX_AI_ERROR_SOURCES.INTERNAL,
    );
  }

  return parsed.origin;
}

function buildPlaybackOrigin(service: MuxPlaybackService, customDomain: string, source: string): string {
  // A domain passed straight to `getMuxPlaybackOrigin` is the caller's input; one
  // from credentials or the environment is the configuration of the service.
  const invalidDomainError = invalidPlaybackDomainError(
    `Invalid ${source}. Provide a bare hostname (e.g. "media.example.com") ` +
    `with no scheme, port, credentials, query params, hash fragments, or path.`,
    source,
    source === "custom domain" ? MUX_AI_ERROR_SOURCES.REQUEST : MUX_AI_ERROR_SOURCES.INTERNAL,
  );

  const trimmed = customDomain.trim();
  if (!trimmed) {
    throw invalidDomainError;
  }

  let parsed: URL;
  try {
    parsed = new URL(`https://${service}.${trimmed}`);
  } catch {
    throw invalidDomainError;
  }

  if (
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw invalidDomainError;
  }

  return parsed.origin;
}

/**
 * Builds the playback origin for a Mux domain, matching Mux Player's `customDomain`
 * expansion (e.g. "media.example.com" becomes "https://image.media.example.com").
 */
export function getMuxPlaybackOrigin(
  service: MuxPlaybackService,
  customDomain: string = DEFAULT_MUX_DOMAIN,
): string {
  return buildPlaybackOrigin(service, customDomain, "custom domain");
}

async function resolveMuxPlaybackOrigin(
  service: MuxPlaybackService,
  credentials?: WorkflowCredentialsInput,
): Promise<string> {
  "use step";
  const { muxCustomDomain } = await resolveWorkflowCredentials(credentials);
  if (muxCustomDomain) {
    return buildPlaybackOrigin(service, muxCustomDomain, "muxCustomDomain");
  }

  const legacyOverrideEnvVarName: LegacyOverrideEnvVarName = service === "image" ?
    "MUX_IMAGE_URL_OVERRIDE" :
    "MUX_STREAM_URL_OVERRIDE";
  const legacyOverride = env[legacyOverrideEnvVarName];
  if (legacyOverride) {
    return normalizeOrigin(legacyOverride, legacyOverrideEnvVarName);
  }

  if (env.MUX_CUSTOM_DOMAIN) {
    return buildPlaybackOrigin(service, env.MUX_CUSTOM_DOMAIN, "MUX_CUSTOM_DOMAIN");
  }

  return buildPlaybackOrigin(service, DEFAULT_MUX_DOMAIN, "custom domain");
}

export async function getMuxImageOrigin(credentials?: WorkflowCredentialsInput): Promise<string> {
  return resolveMuxPlaybackOrigin("image", credentials);
}

export async function getMuxStreamOrigin(credentials?: WorkflowCredentialsInput): Promise<string> {
  return resolveMuxPlaybackOrigin("stream", credentials);
}

export async function getMuxImageBaseUrl(
  playbackId: string,
  assetType: "storyboard" | "thumbnail",
  credentials?: WorkflowCredentialsInput,
): Promise<string> {
  const origin = await getMuxImageOrigin(credentials);
  return `${origin}/${playbackId}/${assetType}.png`;
}

export async function getMuxStoryboardBaseUrl(
  playbackId: string,
  credentials?: WorkflowCredentialsInput,
): Promise<string> {
  return getMuxImageBaseUrl(playbackId, "storyboard", credentials);
}

export async function getMuxThumbnailBaseUrl(
  playbackId: string,
  credentials?: WorkflowCredentialsInput,
): Promise<string> {
  return getMuxImageBaseUrl(playbackId, "thumbnail", credentials);
}
