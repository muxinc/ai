import Mux from '@mux/mux-node';
import { MuxAsset, PlaybackAsset } from '../types';

function ensurePlaybackId(asset: MuxAsset): string {
  const playbackId = asset.playback_ids?.[0]?.id;
  if (!playbackId) {
    throw new Error('No playback ID found for this asset');
  }
  return playbackId;
}

export async function fetchPlaybackAsset(mux: Mux, assetId: string): Promise<PlaybackAsset> {
  const asset = await mux.video.assets.retrieve(assetId);
  const playbackId = ensurePlaybackId(asset);
  return { asset, playbackId };
}
