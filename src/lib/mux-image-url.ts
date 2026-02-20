import env from "@mux/ai/env";

const DEFAULT_MUX_IMAGE_HOST = "image.mux.com";

function normalizeMuxImageHost(value: string): string {
  const trimmed = value.trim();
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      "Invalid MUX_IMAGE_HOST_OVERRIDE. Provide a hostname like " +
      `"image.example.mux.com" (or a URL origin such as "https://image.example.mux.com").`,
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
      "Invalid MUX_IMAGE_HOST_OVERRIDE. Only a hostname/origin is allowed " +
      "(no credentials, query params, hash fragments, or path).",
    );
  }

  return parsed.host;
}

export function getMuxImageHost(): string {
  const override = env.MUX_IMAGE_HOST_OVERRIDE;
  if (!override) {
    return DEFAULT_MUX_IMAGE_HOST;
  }

  return normalizeMuxImageHost(override);
}

export function getMuxImageBaseUrl(playbackId: string, assetType: "storyboard" | "thumbnail"): string {
  const host = getMuxImageHost();
  return `https://${host}/${playbackId}/${assetType}.png`;
}

export function getMuxStoryboardBaseUrl(playbackId: string): string {
  return getMuxImageBaseUrl(playbackId, "storyboard");
}

export function getMuxThumbnailBaseUrl(playbackId: string): string {
  return getMuxImageBaseUrl(playbackId, "thumbnail");
}
