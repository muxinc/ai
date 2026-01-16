import Mux from "@mux/mux-node";

import { getMuxCredentialsFromEnv } from "@mux/ai/lib/client-factory";
import type { MuxAsset, PlaybackAsset, PlaybackPolicy, WorkflowCredentialsInput } from "@mux/ai/types";

/**
 * Finds a usable playback ID for the given asset.
 * Prefers public playback IDs, falls back to signed if no public is available.
 * Throws an error if no public or signed playback ID is found.
 */
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

export async function getPlaybackIdForAsset(
  assetId: string,
  credentials?: WorkflowCredentialsInput,
): Promise<PlaybackAsset> {
  "use step";
  const { muxTokenId, muxTokenSecret } = await getMuxCredentialsFromEnv(credentials);
  const mux = new Mux({
    tokenId: muxTokenId,
    tokenSecret: muxTokenSecret,
  });

  const asset = await mux.video.assets.retrieve(assetId);
  const { id: playbackId, policy } = getPlaybackId(asset);

  return { asset, playbackId, policy };
}
