import Mux from '@mux/mux-node';
import { MuxAsset, PlaybackAsset } from '../types';

type PlaybackPolicy = NonNullable<MuxAsset['playback_ids']>[number]['policy'];

interface EnsurePlaybackIdOptions {
  /**
   * Preferred playback policy (e.g. 'public' or 'signed'). When provided, we
   * will first try to find a playback ID with this policy.
   */
  policy?: PlaybackPolicy;
  /**
   * When true (default), if no playback IDs match the preferred policy we will
   * fall back to the first available playback ID (of any policy).
   */
  fallbackToAny?: boolean;
  /**
   * Optional custom error message when no suitable playback ID is found.
   */
  errorMessage?: string;
}

function ensurePlaybackId(asset: MuxAsset, options: EnsurePlaybackIdOptions = {}): string {
  const { policy, fallbackToAny = true, errorMessage } = options;

  const playbackIds = asset.playback_ids || [];
  let candidate = playbackIds[0];

  if (policy) {
    const preferred = playbackIds.filter((pid) => pid.policy === policy);
    if (preferred.length > 0) {
      candidate = preferred[0];
    } else if (!fallbackToAny) {
      throw new Error(
        errorMessage ||
          `No playback IDs found for this asset matching required policy '${policy}'.`
      );
    }
  }

  if (!candidate?.id) {
    throw new Error(errorMessage || 'No playback ID found for this asset.');
  }

  return candidate.id;
}

type FetchPlaybackAssetOptions = {
  /**
   * When true, require that the returned playback ID uses the 'public' policy.
   * If no public IDs exist, an error is thrown instead of falling back.
   */
  requirePublic?: boolean;
};

export async function fetchPlaybackAsset(
  mux: Mux,
  assetId: string,
  options: FetchPlaybackAssetOptions = {}
): Promise<PlaybackAsset> {
  const asset = await mux.video.assets.retrieve(assetId);

  const playbackId = ensurePlaybackId(asset, {
    policy: options.requirePublic ? 'public' : undefined,
    fallbackToAny: !options.requirePublic,
    errorMessage: options.requirePublic
      ? 'No public playback IDs found for this asset. Public playback access is required.'
      : undefined,
  });

  return { asset, playbackId };
}
