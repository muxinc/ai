import type { MuxAsset } from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A deprecated `mp4_support` value that produces static renditions. */
export type LegacyMp4Support = Exclude<NonNullable<MuxAsset["mp4_support"]>, "none">;

type StaticRenditionFile = NonNullable<NonNullable<MuxAsset["static_renditions"]>["files"]>[number];

/** Filename of a static rendition, as served at `https://stream.mux.com/{PLAYBACK_ID}/{name}`. */
export type StaticRenditionFileName = NonNullable<StaticRenditionFile["name"]>;

/**
 * Which file to read from an asset whose static renditions come from the
 * deprecated `mp4_support` option.
 *
 * - `ready`: serve `name`. `filesizeBytes` is set when Mux reports it.
 * - `preparing`: Mux is still generating the files; check again later.
 * - `unusable`: the files will never be usable as-is. `reason` is customer-safe.
 */
export type LegacyMp4SupportRendition =
  { kind: "ready"; mp4Support: LegacyMp4Support; name: StaticRenditionFileName; filesizeBytes?: number } |
  { kind: "preparing"; mp4Support: LegacyMp4Support } |
  { kind: "unusable"; mp4Support: LegacyMp4Support; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Guide for the Static Renditions API that replaces `mp4_support`. */
export const STATIC_RENDITIONS_GUIDE_URL = "https://www.mux.com/docs/guides/enable-static-mp4-renditions";

// The trailing `audio.m4a` / `capped-1080p.mp4` entries cover audio-only and
// video-only assets, where Mux produces a different file for the same option.
const LEGACY_MP4_SUPPORT_FILE_PREFERENCE: Readonly<Record<LegacyMp4Support, readonly StaticRenditionFileName[]>> = {
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
 * Returns the asset's `mp4_support` value when it uses the deprecated option,
 * or `undefined` when its static renditions (if any) come from the Static
 * Renditions API.
 */
export function getLegacyMp4Support(asset: MuxAsset): LegacyMp4Support | undefined {
  const mp4Support = asset.mp4_support;
  return mp4Support && mp4Support !== "none" ? mp4Support : undefined;
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
  const mp4Support = getLegacyMp4Support(asset);
  if (!mp4Support) {
    return undefined;
  }

  const status = asset.static_renditions?.status;
  if (status === undefined || status === "preparing") {
    return { kind: "preparing", mp4Support };
  }
  if (status !== "ready") {
    return {
      kind: "unusable",
      mp4Support,
      reason: `This asset uses the deprecated mp4_support setting, and its static renditions are ${status}. Move the asset to the Static Renditions API (${STATIC_RENDITIONS_GUIDE_URL}) and add an audio-only static rendition, then retry.`,
    };
  }

  const files = asset.static_renditions?.files ?? [];
  const preference: readonly StaticRenditionFileName[] = LEGACY_MP4_SUPPORT_FILE_PREFERENCE[mp4Support] ?? [];
  for (const name of preference) {
    const file = files.find(candidate => candidate.name === name);
    if (file) {
      return { kind: "ready", mp4Support, name, filesizeBytes: parseFilesizeBytes(file.filesize) };
    }
  }

  return {
    kind: "unusable",
    mp4Support,
    reason: `This asset uses the deprecated mp4_support setting ("${mp4Support}"), and none of its static renditions can be used by this workflow. Move the asset to the Static Renditions API (${STATIC_RENDITIONS_GUIDE_URL}) and add an audio-only static rendition, then retry.`,
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
