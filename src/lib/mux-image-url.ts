import env from "@mux/ai/env";

const DEFAULT_MUX_IMAGE_ORIGIN = "https://image.mux.com";

function normalizeMuxImageOrigin(value: string): string {
  const trimmed = value.trim();
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      "Invalid MUX_IMAGE_URL_OVERRIDE. Provide a hostname like " +
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
      "Invalid MUX_IMAGE_URL_OVERRIDE. Only a hostname/origin is allowed " +
      "(no credentials, query params, hash fragments, or path).",
    );
  }

  return parsed.origin;
}

export function getMuxImageOrigin(): string {
  const override = env.MUX_IMAGE_URL_OVERRIDE;
  if (!override) {
    return DEFAULT_MUX_IMAGE_ORIGIN;
  }

  return normalizeMuxImageOrigin(override);
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
