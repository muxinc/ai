import type { MuxAsset, PlaybackAsset, PlaybackPolicy, WorkflowCredentialsInput, WorkflowMuxClient } from "../types.ts";

import { getMuxClientFromEnv } from "./client-factory.ts";
import { dependencyErrorFrom } from "./dependency-error.ts";
import { MUX_AI_ERROR_CODES, MUX_AI_ERROR_DEPENDENCY_VALUES, MUX_AI_ERROR_SOURCE_VALUES, MUX_AI_ERROR_TYPE_VALUES, MuxAiError } from "./mux-ai-error.ts";

/**
 * Finds a usable playback ID for the given asset.
 * Prefers public playback IDs, falls back to signed if no public is available.
 * Throws an error if no public or signed playback ID is found.
 */
// Use the asset payload we already fetched to avoid extra Mux Video API calls.
function getPlaybackId(asset: MuxAsset): { id: string; policy: PlaybackPolicy } {
  const playbackIds = asset.playback_ids || [];

  // First, try to find a public playback ID
  const publicPlaybackId = playbackIds.find(pid => pid.policy === "public");
  if (publicPlaybackId?.id) {
    return { id: publicPlaybackId.id, policy: "public" };
  }

  // Fall back to signed playback ID
  const signedPlaybackId = playbackIds.find(pid => pid.policy === "signed");
  if (signedPlaybackId?.id) {
    return { id: signedPlaybackId.id, policy: "signed" };
  }

  throw new MuxAiError(
    "No public or signed playback ID found for this asset. DRM playback IDs are not currently supported.",
    {
      code: MUX_AI_ERROR_CODES.playback_id_not_found,
      facts: { playbackPolicies: [...new Set(playbackIds.map(pid => pid.policy).filter(Boolean))] as string[] },
    },
  );
}

/**
 * Determines if an asset is audio-only by checking if it has any video tracks.
 * Returns true if the asset has at least one audio track and no video tracks.
 */
export function isAudioOnlyAsset(asset: MuxAsset): boolean {
  const hasAudioTrack = asset.tracks?.some(track => track.type === "audio") ?? false;
  const hasVideoTrack = asset.tracks?.some(track => track.type === "video") ?? false;
  return hasAudioTrack && !hasVideoTrack;
}

function toPlaybackAsset(asset: MuxAsset): PlaybackAsset {
  const { id: playbackId, policy } = getPlaybackId(asset);
  return { asset, playbackId, policy };
}

export async function getPlaybackIdForAsset(
  assetId: string,
  credentials?: WorkflowCredentialsInput,
  assetSnapshot?: MuxAsset,
): Promise<PlaybackAsset> {
  "use step";
  // Centralize the Mux Video API fetch so callers can reuse the same asset payload
  // for playback IDs, duration, and other derived fields without double-hitting.
  // Note: getMuxAsset still resolves Mux token ID/secret from env or provided
  // credentials to preserve multi-tenant behavior.
  const asset = assetSnapshot ?? await getMuxAsset(assetId, credentials);
  if (asset.id !== assetId) {
    throw new MuxAiError("Asset snapshot does not match the requested asset ID.", {
      type: MUX_AI_ERROR_TYPE_VALUES.validation_error,
      source: MUX_AI_ERROR_SOURCE_VALUES.request,
      facts: { assetId, snapshotAssetId: asset.id },
    });
  }
  return toPlaybackAsset(asset);
}

export async function getPlaybackIdForAssetWithClient(
  assetId: string,
  muxClient: WorkflowMuxClient,
): Promise<PlaybackAsset> {
  // Do not mark this as a workflow step: muxClient contains function properties
  // (e.g. createClient) that are not serializable across step boundaries.
  const asset = await getMuxAssetWithClient(assetId, muxClient);
  return toPlaybackAsset(asset);
}

/**
 * Fetches the Mux asset once so callers can derive playback IDs, duration, tracks,
 * and other metadata from a single Video API call.
 */
export async function getMuxAsset(
  assetId: string,
  credentials?: WorkflowCredentialsInput,
): Promise<MuxAsset> {
  "use step";
  const muxClient = await getMuxClientFromEnv(credentials);
  return getMuxAssetWithClient(assetId, muxClient);
}

export async function getMuxAssetWithClient(
  assetId: string,
  muxClient: WorkflowMuxClient,
): Promise<MuxAsset> {
  // Do not mark this as a workflow step for the same serialization reason as above.
  const client = await muxClient.createClient();
  try {
    return await client.video.assets.retrieve(assetId);
  } catch (error) {
    // A 404 means the caller's asset ID doesn't exist in this environment.
    throw dependencyErrorFrom(error, "Failed to retrieve Mux asset", {
      dependency: MUX_AI_ERROR_DEPENDENCY_VALUES.mux_video,
      call: "get_asset",
      facts: { assetId },
      notFoundSource: MUX_AI_ERROR_SOURCE_VALUES.request,
      authSource: MUX_AI_ERROR_SOURCE_VALUES.account,
    });
  }
}

export async function getAssetDurationSeconds(
  assetId: string,
  credentials?: WorkflowCredentialsInput,
): Promise<number | undefined> {
  "use step";
  // Keep this helper, but route through getMuxAsset so a caller that already
  // fetched the asset can prefer getAssetDurationSecondsFromAsset instead.
  const asset = await getMuxAsset(assetId, credentials);
  return getAssetDurationSecondsFromAsset(asset);
}

// Use this when you already have the asset to avoid another Video API round trip.
export function getAssetDurationSecondsFromAsset(asset: MuxAsset): number | undefined {
  const duration = asset.duration;
  return typeof duration === "number" && Number.isFinite(duration) ? duration : undefined;
}

export function getVideoTrackDurationSecondsFromAsset(asset: MuxAsset): number | undefined {
  const videoTrack = asset.tracks?.find(track => track.type === "video");
  const duration = (videoTrack as { duration?: unknown } | undefined)?.duration;
  return typeof duration === "number" && Number.isFinite(duration) ? duration : undefined;
}

export function getVideoTrackMaxFrameRateFromAsset(asset: MuxAsset): number | undefined {
  const videoTrack = asset.tracks?.find(track => track.type === "video");
  const maxFrameRate = (videoTrack as { max_frame_rate?: unknown } | undefined)?.max_frame_rate;
  return typeof maxFrameRate === "number" && Number.isFinite(maxFrameRate) && maxFrameRate > 0 ?
    maxFrameRate :
    undefined;
}
