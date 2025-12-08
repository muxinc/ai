import Mux from "@mux/mux-node";

import type { MuxAsset, PlaybackAsset, PlaybackPolicy } from "../types";
import type { ValidatedCredentials } from "./client-factory";

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

export async function getPlaybackIdForAsset(
  credentials: ValidatedCredentials,
  assetId: string,
): Promise<PlaybackAsset> {
  "use step";
  const mux = new Mux({
    tokenId: credentials.muxTokenId,
    tokenSecret: credentials.muxTokenSecret,
  });

  const asset = await mux.video.assets.retrieve(assetId);
  const { id: playbackId, policy } = getPlaybackId(asset);

  return { asset, playbackId, policy };
}
