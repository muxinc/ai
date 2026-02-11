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
  const timestamps: number[] = [];

  // Calculate expected number of timestamps before generating
  let expectedCount: number;
  if (duration <= 50) {
    expectedCount = 5;
  } else {
    expectedCount = Math.floor(duration / interval) + 1;
  }

  // If maxSamples is set and would be exceeded, generate evenly-spaced samples directly
  if (maxSamples !== undefined && expectedCount > maxSamples) {
    timestamps.push(0); // Always include first frame

    if (maxSamples >= 2) {
      const spacing = duration / (maxSamples - 1);
      for (let i = 1; i < maxSamples - 1; i++) {
        timestamps.push(spacing * i);
      }
      timestamps.push(duration); // Always include last frame
    }
  } else {
    // Generate timestamps based on duration and interval
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
  }

  const baseUrl = `https://image.mux.com/${playbackId}/thumbnail.png`;

  const urlPromises = timestamps.map(async (time) => {
    if (shouldSign) {
      return signUrl(baseUrl, playbackId, undefined, "thumbnail", { time, width }, credentials);
    }

    return `${baseUrl}?time=${time}&width=${width}`;
  });

  return Promise.all(urlPromises);
}
