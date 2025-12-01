import type { SigningContext } from "../lib/url-signing";

import { signUrl } from "../lib/url-signing";

export interface ThumbnailOptions {
  /** Interval between thumbnails in seconds (default: 10) */
  interval?: number;
  /** Width of the thumbnail in pixels (default: 640) */
  width?: number;
  /** Optional signing context for signed playback IDs */
  signingContext?: SigningContext;
}

/**
 * Generates thumbnail URLs at regular intervals based on video duration.
 * If a signing context is provided, the URLs will be signed with tokens.
 *
 * @param playbackId - The Mux playback ID
 * @param duration - Video duration in seconds
 * @param options - Thumbnail generation options
 * @returns Array of thumbnail URLs (signed if context provided)
 */
export async function getThumbnailUrls(
  playbackId: string,
  duration: number,
  options: ThumbnailOptions = {},
): Promise<string[]> {
  const { interval = 10, width = 640, signingContext } = options;
  const timestamps: number[] = [];

  if (duration <= 50) {
    const spacing = duration / 6;
    for (let i = 1; i <= 5; i++) {
      timestamps.push(Math.round(i * spacing));
    }
  }
  else {
    for (let time = 0; time < duration; time += interval) {
      timestamps.push(time);
    }
  }

  const baseUrl = `https://image.mux.com/${playbackId}/thumbnail.png`;

  const urlPromises = timestamps.map(async (time) => {
    if (signingContext) {
      return signUrl(baseUrl, playbackId, signingContext, "thumbnail", { time, width });
    }

    return `${baseUrl}?time=${time}&width=${width}`;
  });

  return Promise.all(urlPromises);
}
