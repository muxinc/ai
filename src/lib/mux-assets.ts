import { getMuxClientFromEnv } from "@mux/ai/lib/client-factory";
import type { MuxAsset, PlaybackAsset, PlaybackPolicy, WorkflowCredentialsInput, WorkflowMuxClient } from "@mux/ai/types";

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

  throw new Error(
    "No public or signed playback ID found for this asset. " +
    "A public or signed playback ID is required. DRM playback IDs are not currently supported.",
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
): Promise<PlaybackAsset> {
  "use step";
  // Centralize the Mux Video API fetch so callers can reuse the same asset payload
  // for playback IDs, duration, and other derived fields without double-hitting.
  // Note: getMuxAsset still resolves Mux token ID/secret from env or provided
  // credentials to preserve multi-tenant behavior.
  const asset = await getMuxAsset(assetId, credentials);
  return toPlaybackAsset(asset);
}

export async function getPlaybackIdForAssetWithClient(
  assetId: string,
  muxClient: WorkflowMuxClient,
): Promise<PlaybackAsset> {
  "use step";
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
  const mux = await muxClient.createClient();
  return mux.video.assets.retrieve(assetId);
}

export async function getMuxAssetWithClient(
  assetId: string,
  muxClient: WorkflowMuxClient,
): Promise<MuxAsset> {
  "use step";
  const client = await muxClient.createClient();
  return client.video.assets.retrieve(assetId);
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
