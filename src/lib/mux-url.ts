import env from "../env";

const DEFAULT_MUX_IMAGE_ORIGIN = "https://image.mux.com";
const DEFAULT_MUX_STREAM_ORIGIN = "https://stream.mux.com";

function normalizeOrigin(value: string, envVarName: "MUX_IMAGE_URL_OVERRIDE" | "MUX_STREAM_URL_OVERRIDE"): string {
  const trimmed = value.trim();
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;

  const exampleHostname = envVarName === "MUX_IMAGE_URL_OVERRIDE" ?
    "image.example.mux.com" :
    "stream.example.mux.com";

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      `Invalid ${envVarName}. Provide a hostname (e.g. "${exampleHostname}") ` +
      `or a URL origin (e.g. "https://${exampleHostname}").`,
    );
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    throw new Error(
      `Invalid ${envVarName}. Only a hostname/origin is allowed ` +
      `(no credentials, query params, hash fragments, or path).`,
    );
  }

  return parsed.origin;
}

export function getMuxImageOrigin(): string {
  const override = env.MUX_IMAGE_URL_OVERRIDE;
  if (!override) {
    return DEFAULT_MUX_IMAGE_ORIGIN;
  }

  return normalizeOrigin(override, "MUX_IMAGE_URL_OVERRIDE");
}

export function getMuxStreamOrigin(): string {
  const override = env.MUX_STREAM_URL_OVERRIDE;
  if (!override) {
    return DEFAULT_MUX_STREAM_ORIGIN;
  }

  return normalizeOrigin(override, "MUX_STREAM_URL_OVERRIDE");
}

export function getMuxImageBaseUrl(playbackId: string, assetType: "storyboard" | "thumbnail"): string {
  const origin = getMuxImageOrigin();
  return `${origin}/${playbackId}/${assetType}.png`;
}

export function getMuxStoryboardBaseUrl(playbackId: string): string {
  return getMuxImageBaseUrl(playbackId, "storyboard");
}

export function getMuxThumbnailBaseUrl(playbackId: string): string {
  return getMuxImageBaseUrl(playbackId, "thumbnail");
}
