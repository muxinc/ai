import { getMuxThumbnailBaseUrl } from "@mux/ai/lib/mux-image-url";
import { signUrl } from "@mux/ai/lib/url-signing";
import type { WorkflowCredentialsInput } from "@mux/ai/types";

export interface ThumbnailOptions {
  /** Interval between thumbnails in seconds (default: 10) */
  interval?: number;
  /** Width of the thumbnail in pixels (default: 640) */
  width?: number;
  /** Flag for whether or not to use signed playback IDs (default: false) */
  shouldSign?: boolean;
  /** Maximum number of thumbnails to generate. When set, samples are evenly distributed with first and last frames pinned. */
  maxSamples?: number;
  /** Workflow credentials for signing (optional). */
  credentials?: WorkflowCredentialsInput;
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
  const { interval = 10, width = 640, shouldSign = false, maxSamples, credentials } = options;
  let timestamps: number[] = [];

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

  // Apply maxSamples cap if specified and we have more timestamps than the limit
  if (maxSamples !== undefined && timestamps.length > maxSamples) {
    const newTimestamps: number[] = [];

    // Always include first frame
    newTimestamps.push(0);

    // If maxSamples >= 2, add evenly distributed middle frames and last frame
    if (maxSamples >= 2) {
      const spacing = duration / (maxSamples - 1);
      for (let i = 1; i < maxSamples - 1; i++) {
        newTimestamps.push(spacing * i);
      }
      // Always include last frame
      newTimestamps.push(duration);
    }

    timestamps = newTimestamps;
  }

  const baseUrl = getMuxThumbnailBaseUrl(playbackId);

  const urlPromises = timestamps.map(async (time) => {
    if (shouldSign) {
      return signUrl(baseUrl, playbackId, "thumbnail", { time, width }, credentials);
    }

    return `${baseUrl}?time=${time}&width=${width}`;
  });

  return Promise.all(urlPromises);
}
