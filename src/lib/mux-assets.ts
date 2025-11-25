import Mux from '@mux/mux-node';
import { MuxAsset, PlaybackAsset } from '../types';

/**
 * Returns a public playback ID for the given asset.
 * Throws an error if no public playback ID is found.
 */
function ensurePublicPlaybackId(asset: MuxAsset): string {
  const playbackIds = asset.playback_ids || [];
  const publicPlaybackId = playbackIds.find((pid) => pid.policy === 'public');

  if (!publicPlaybackId?.id) {
    throw new Error('No public playback ID found for this asset. Public playback access is required.');
  }

  return publicPlaybackId.id;
}

export async function fetchPlaybackAsset(
  mux: Mux,
  assetId: string
): Promise<PlaybackAsset> {
  const asset = await mux.video.assets.retrieve(assetId);
  const playbackId = ensurePublicPlaybackId(asset);

  return { asset, playbackId };
}
