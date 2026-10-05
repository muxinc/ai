import type { MuxAsset } from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which file to read from an asset whose static renditions come from the
 * deprecated `mp4_support` option.
 *
 * - `ready`: serve `name`. `filesizeBytes` is set when Mux reports it.
 * - `preparing`: Mux is still generating the files; check again later.
 * - `unusable`: the files will never be usable as-is. `reason` is customer-safe.
 */
export type LegacyMp4SupportRendition =
  { kind: "ready"; name: string; filesizeBytes?: number } |
  { kind: "preparing" } |
  { kind: "unusable"; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Guide for the Static Renditions API that replaces `mp4_support`. */
export const STATIC_RENDITIONS_GUIDE_URL = "https://www.mux.com/docs/guides/enable-static-mp4-renditions";

// The trailing `audio.m4a` / `capped-1080p.mp4` entries cover audio-only and
// video-only assets, where Mux produces a different file for the same option.
const LEGACY_MP4_SUPPORT_FILE_PREFERENCE: Readonly<Record<string, readonly string[]>> = {
  "capped-1080p": ["capped-1080p.mp4", "audio.m4a"],
  "audio-only": ["audio.m4a"],
  "audio-only,capped-1080p": ["audio.m4a", "capped-1080p.mp4"],
  "standard": ["low.mp4", "audio.m4a"],
};

const BYTES_PER_GB = 1_000_000_000;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether the asset uses the deprecated `mp4_support` option rather than the
 * Static Renditions API.
 */
export function usesLegacyMp4Support(asset: MuxAsset): boolean {
  return asset.mp4_support !== undefined && asset.mp4_support !== "none";
}

function parseFilesizeBytes(filesize: unknown): number | undefined {
  const bytes = typeof filesize === "string" ? Number(filesize) : filesize;
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
}

/**
 * Picks the static rendition file to read from an asset that uses the
 * deprecated `mp4_support` option. Returns `undefined` for every other asset.
 *
 * Renditions created by `mp4_support` cannot be managed through the Static
 * Renditions API, and their `files` carry no per-file `status`, so readiness
 * comes from the aggregate `static_renditions.status`. Callers must read the
 * returned file as-is and never create, delete, or update static renditions
 * on these assets.
 */
export function resolveLegacyMp4SupportRendition(asset: MuxAsset): LegacyMp4SupportRendition | undefined {
  if (!usesLegacyMp4Support(asset)) {
    return undefined;
  }

  const status = asset.static_renditions?.status;
  if (status === undefined || status === "preparing") {
    return { kind: "preparing" };
  }
  if (status !== "ready") {
    return {
      kind: "unusable",
      reason: `This asset uses the deprecated mp4_support setting, and its static renditions are ${status}. Move the asset to the Static Renditions API (${STATIC_RENDITIONS_GUIDE_URL}) and add an audio-only static rendition, then retry.`,
    };
  }

  const files = asset.static_renditions?.files ?? [];
  for (const name of LEGACY_MP4_SUPPORT_FILE_PREFERENCE[asset.mp4_support!] ?? []) {
    const file = files.find(candidate => candidate.name === name);
    if (file) {
      return { kind: "ready", name, filesizeBytes: parseFilesizeBytes(file.filesize) };
    }
  }

  return {
    kind: "unusable",
    reason: `This asset uses the deprecated mp4_support setting ("${asset.mp4_support}"), and none of its static renditions can be used by this workflow. Move the asset to the Static Renditions API (${STATIC_RENDITIONS_GUIDE_URL}) and add an audio-only static rendition, then retry.`,
  };
}

function formatGigabytes(bytes: number): string {
  return `${Math.round((bytes / BYTES_PER_GB) * 100) / 100} GB`;
}

/**
 * Returns a customer-safe error when a ready `mp4_support` file is larger than
 * `maxBytes`, or `undefined` when it fits or its size is unknown.
 */
export function getLegacyMp4SupportRenditionSizeError(
  rendition: Extract<LegacyMp4SupportRendition, { kind: "ready" }>,
  maxBytes: number,
): string | undefined {
  if (rendition.filesizeBytes === undefined || rendition.filesizeBytes <= maxBytes) {
    return undefined;
  }
  return `This asset uses the deprecated mp4_support setting, and its ${rendition.name} static rendition (${formatGigabytes(rendition.filesizeBytes)}) is larger than the ${formatGigabytes(maxBytes)} this workflow can process. Move the asset to the Static Renditions API (${STATIC_RENDITIONS_GUIDE_URL}) and add an audio-only static rendition, then retry.`;
}
