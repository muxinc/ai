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
 * - `unusable`: the files will never be usable as-is. `reason` is customer-safe;
 *   `status` is the renditions' status when they aren't `ready`.
 */
export type LegacyMp4SupportRendition =
  { kind: "ready"; name: string; filesizeBytes?: number } |
  { kind: "preparing" } |
  { kind: "unusable"; reason: string; mp4Support: string; status?: string };

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
    return { kind: "unusable", reason: legacyMp4SupportUnusableMessage({ status }), mp4Support: asset.mp4_support!, status };
  }

  const files = asset.static_renditions?.files ?? [];
  for (const name of LEGACY_MP4_SUPPORT_FILE_PREFERENCE[asset.mp4_support!] ?? []) {
    const file = files.find(candidate => candidate.name === name);
    if (file) {
      return { kind: "ready", name, filesizeBytes: parseFilesizeBytes(file.filesize) };
    }
  }

  return { kind: "unusable", reason: legacyMp4SupportUnusableMessage({ mp4Support: asset.mp4_support }), mp4Support: asset.mp4_support! };
}

const MOVE_TO_STATIC_RENDITIONS = `Move the asset to the Static Renditions API (${STATIC_RENDITIONS_GUIDE_URL}) and add an audio-only static rendition, then retry.`;

/** Why an `mp4_support` asset's renditions can't be used: they aren't `ready` (`status`), or none fits. */
export function legacyMp4SupportUnusableMessage({ status, mp4Support }: { status?: string; mp4Support?: string }): string {
  return status ?
    `This asset uses the deprecated mp4_support setting, and its static renditions are ${status}. ${MOVE_TO_STATIC_RENDITIONS}` :
    `This asset uses the deprecated mp4_support setting${mp4Support ? ` ("${mp4Support}")` : ""}, and none of its static renditions can be used by this workflow. ${MOVE_TO_STATIC_RENDITIONS}`;
}

/** An `mp4_support` rendition larger than a workflow can process. */
export function legacyMp4SupportTooLargeMessage({ name, filesizeBytes, maxBytes }: { name: string; filesizeBytes: number; maxBytes: number }): string {
  return `This asset uses the deprecated mp4_support setting, and its ${name} static rendition (${formatGigabytes(filesizeBytes)}) is larger than the ${formatGigabytes(maxBytes)} this workflow can process. ${MOVE_TO_STATIC_RENDITIONS}`;
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
  return legacyMp4SupportTooLargeMessage({ name: rendition.name, filesizeBytes: rendition.filesizeBytes, maxBytes });
}
