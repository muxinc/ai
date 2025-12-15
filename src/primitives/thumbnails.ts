import { getMuxSigningContextFromEnv, signUrl } from "../lib/url-signing";

export interface ThumbnailOptions {
  /** Interval between thumbnails in seconds (default: 10) */
  interval?: number;
  /** Width of the thumbnail in pixels (default: 640) */
  width?: number;
  /** Flag for whether or not to use signed playback IDs (default: false) */
  shouldSign?: boolean;
}

/**
 * Generates thumbnail URLs at regular intervals based on video duration.
 * If shouldSign is true, the URLs will be signed with tokens using credentials from environment variables.
 *
 * @param playbackId - The Mux playback ID
 * @param duration - Video duration in seconds
 * @param options - Thumbnail generation options
 * @returns Array of thumbnail URLs (signed if shouldSign is true)
 */
export async function getThumbnailUrls(
  playbackId: string,
  duration: number,
  options: ThumbnailOptions = {},
): Promise<string[]> {
  "use step";
  const { interval = 10, width = 640, shouldSign = false } = options;
  const timestamps: number[] = [];

  if (duration <= 50) {
    const spacing = duration / 6;
    for (let i = 1; i <= 5; i++) {
      timestamps.push(Math.round(i * spacing));
    }
  } else {
    for (let time = 0; time < duration; time += interval) {
      timestamps.push(time);
    }
  }

  const baseUrl = `https://image.mux.com/${playbackId}/thumbnail.png`;

  const urlPromises = timestamps.map(async (time) => {
    if (shouldSign) {
      // NOTE: this assumes you have already validated the signing context elsewhere
      const signingContext = getMuxSigningContextFromEnv();
      return signUrl(baseUrl, playbackId, signingContext!, "thumbnail", { time, width });
    }

    return `${baseUrl}?time=${time}&width=${width}`;
  });

  return Promise.all(urlPromises);
}
