import { getMuxThumbnailBaseUrl } from "../lib/mux-url.ts";
import { signUrl } from "../lib/url-signing.ts";
import { hasWorkflowScopeBoundaries, resolveWorkflowScope } from "../lib/workflow-scope.ts";
import type { WorkflowCredentialsInput, WorkflowScope } from "../types.ts";

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
  /** Optional asset-relative range from which thumbnails should be sampled. */
  scope?: WorkflowScope;
}

/**
 * Generates thumbnail URLs at regular intervals based on video duration.
 * If shouldSign is true, the URLs will be signed with tokens using credentials from environment variables.
 *
 * @param playbackId - The Mux playback ID
 * @param duration - Video duration in seconds
 * @param options - Thumbnail generation options
 * @returns Array of objects containing the thumbnail URL and its time in seconds
 */
export async function getThumbnailUrls(
  playbackId: string,
  duration: number,
  options: ThumbnailOptions = {},
): Promise<Array<{ url: string; time: number }>> {
  "use step";
  const { interval = 10, width = 640, shouldSign = false, maxSamples, credentials, scope } = options;
  const effectiveScope = hasWorkflowScopeBoundaries(scope) ? scope : undefined;
  const resolvedScope = effectiveScope ?
      resolveWorkflowScope(effectiveScope, duration) :
      { startTime: 0, endTime: duration };
  const rangeDuration = resolvedScope.endTime - resolvedScope.startTime;
  let timestamps: number[] = [];

  if (rangeDuration <= 50) {
    const spacing = rangeDuration / 6;
    for (let i = 1; i <= 5; i++) {
      const time = resolvedScope.startTime + i * spacing;
      timestamps.push(Number(time.toFixed(3)));
    }
  } else {
    for (
      let time = resolvedScope.startTime;
      time < resolvedScope.endTime;
      time += interval
    ) {
      timestamps.push(time);
    }
  }

  timestamps = [...new Set(timestamps)];

  // Apply maxSamples cap if specified and we have more timestamps than the limit
  if (maxSamples !== undefined && timestamps.length > maxSamples) {
    const newTimestamps: number[] = [];

    // Always include first frame
    newTimestamps.push(resolvedScope.startTime);

    // If maxSamples >= 2, add evenly distributed middle frames and last frame
    if (maxSamples >= 2) {
      const lastTime = effectiveScope ?
          Math.max(resolvedScope.startTime, resolvedScope.endTime - 0.001) :
        resolvedScope.endTime;
      const spacing = (lastTime - resolvedScope.startTime) / (maxSamples - 1);
      for (let i = 1; i < maxSamples - 1; i++) {
        newTimestamps.push(resolvedScope.startTime + spacing * i);
      }
      // Always include last frame
      newTimestamps.push(lastTime);
    }

    timestamps = newTimestamps;
  }

  const baseUrl = getMuxThumbnailBaseUrl(playbackId);

  const urlPromises = timestamps.map(async (time) => {
    const url = shouldSign ?
        await signUrl(baseUrl, playbackId, "thumbnail", { time, width }, credentials) :
      `${baseUrl}?time=${time}&width=${width}`;

    return { url, time };
  });

  return Promise.all(urlPromises);
}
