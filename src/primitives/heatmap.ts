import { getMuxClientFromEnv } from "@mux/ai/lib/client-factory";
import { secondsToTimestamp } from "@mux/ai/primitives/transcripts";
import type { WorkflowCredentialsInput } from "@mux/ai/types";

export interface HeatmapOptions {
  /** Time window for results, e.g., '7:days' (default: '24:hours') */
  timeframe?: string;
  /** Optional workflow credentials */
  credentials?: WorkflowCredentialsInput;
}

/** Raw API response structure from Mux Data API */
// To be removed when the Mux Node SDK is updated
interface HeatmapApiResponse {
  timeframe: [number, number];
  data: {
    asset_id?: string;
    video_id?: string;
    playback_id?: string;
    heatmap: number[];
  };
}

export interface HeatmapResponse {
  assetId?: string;
  videoId?: string;
  playbackId?: string;
  /** Array of 100 values representing engagement for each 1/100th of the video */
  heatmap: number[];
  timeframe: [number, number];
}

/**
 * Fetches engagement heatmap for a Mux asset.
 * Returns a length 100 array where each value represents how many times
 * that 1/100th of the video was watched.
 *
 * @param assetId - The Mux asset ID
 * @param options - Heatmap query options
 * @returns Heatmap data with 100 engagement values
 */
export async function getHeatmapForAsset(
  assetId: string,
  options: HeatmapOptions = {},
): Promise<HeatmapResponse> {
  "use step";
  return fetchHeatmap("assets", assetId, options);
}

/**
 * Fetches engagement heatmap for a Mux video ID.
 * Returns a length 100 array where each value represents how many times
 * that 1/100th of the video was watched.
 *
 * @param videoId - The Mux video ID
 * @param options - Heatmap query options
 * @returns Heatmap data with 100 engagement values
 */
export async function getHeatmapForVideo(
  videoId: string,
  options: HeatmapOptions = {},
): Promise<HeatmapResponse> {
  "use step";
  return fetchHeatmap("videos", videoId, options);
}

/**
 * Fetches engagement heatmap for a Mux playback ID.
 * Returns a length 100 array where each value represents how many times
 * that 1/100th of the video was watched.
 *
 * @param playbackId - The Mux playback ID
 * @param options - Heatmap query options
 * @returns Heatmap data with 100 engagement values
 */
export async function getHeatmapForPlaybackId(
  playbackId: string,
  options: HeatmapOptions = {},
): Promise<HeatmapResponse> {
  "use step";
  return fetchHeatmap("playback-ids", playbackId, options);
}

/**
 * Transforms the snake_case API response to camelCase for the public interface.
 * TODO: Remove when the Mux Node SDK is updated
 */
function transformHeatmapResponse(
  response: HeatmapApiResponse,
): HeatmapResponse {
  return {
    assetId: response.data.asset_id,
    videoId: response.data.video_id,
    playbackId: response.data.playback_id,
    heatmap: response.data.heatmap,
    timeframe: response.timeframe,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Heatmap Statistics
// ─────────────────────────────────────────────────────────────────────────────

/** Statistics computed from heatmap data. */
export interface HeatmapStatistics {
  average: number;
  peak: { index: number; value: number; timestamp: string };
  lowest: { index: number; value: number; timestamp: string };
  /** Segments where engagement drops >25% from local average, merged into ranges. */
  significantDrops: Array<{
    startIndex: number;
    endIndex: number;
    dropPercentage: number;
    timestamp: string;
  }>;
}

/**
 * Computes statistics from heatmap data including average, peak, lowest,
 * and significant engagement drops (>25% from rolling average).
 *
 * @param heatmap - Array of 100 engagement values
 * @param durationSeconds - Total asset duration in seconds (for timestamp formatting)
 * @returns Computed statistics with human-readable timestamps
 */
export function computeHeatmapStatistics(heatmap: number[], durationSeconds: number): HeatmapStatistics {
  if (heatmap.length === 0) {
    throw new Error("Heatmap data is empty — cannot compute statistics");
  }

  const average = heatmap.reduce((sum, val) => sum + val, 0) / heatmap.length;

  let peakIndex = 0;
  let lowestIndex = 0;
  for (let i = 1; i < heatmap.length; i++) {
    if (heatmap[i] > heatmap[peakIndex]) {
      peakIndex = i;
    }
    if (heatmap[i] < heatmap[lowestIndex]) {
      lowestIndex = i;
    }
  }

  const indexToTimestamp = (index: number) => {
    const seconds = (index / heatmap.length) * durationSeconds;
    return secondsToTimestamp(seconds);
  };

  // Detect significant drops (>25% from rolling 5-point average)
  // and merge consecutive drops into ranges
  const rawDrops: Array<{ index: number; dropPercentage: number }> = [];
  const windowSize = 5;

  for (let i = windowSize; i < heatmap.length - windowSize; i++) {
    const before = heatmap.slice(i - windowSize, i);
    const avgBefore = before.reduce((a, b) => a + b, 0) / before.length;
    const current = heatmap[i];

    if (avgBefore > 0 && current / avgBefore < 0.75) {
      rawDrops.push({
        index: i,
        dropPercentage: ((avgBefore - current) / avgBefore) * 100,
      });
    }
  }

  // Merge consecutive drops (within 3 indices) into ranges
  const significantDrops: HeatmapStatistics["significantDrops"] = [];
  for (const drop of rawDrops) {
    const last = significantDrops[significantDrops.length - 1];
    if (last && drop.index - last.endIndex <= 3) {
      last.endIndex = drop.index;
      last.dropPercentage = Math.max(last.dropPercentage, drop.dropPercentage);
    } else {
      significantDrops.push({
        startIndex: drop.index,
        endIndex: drop.index,
        dropPercentage: drop.dropPercentage,
        timestamp: indexToTimestamp(drop.index),
      });
    }
  }

  return {
    average,
    peak: {
      index: peakIndex,
      value: heatmap[peakIndex],
      timestamp: indexToTimestamp(peakIndex),
    },
    lowest: {
      index: lowestIndex,
      value: heatmap[lowestIndex],
      timestamp: indexToTimestamp(lowestIndex),
    },
    significantDrops,
  };
}

/**
 * Computes the percentile rank of a value within the heatmap distribution.
 *
 * @param value - The value to rank
 * @param heatmap - The full heatmap array to compare against
 * @returns Percentile rank (0-100)
 */
export function computeHeatmapPercentile(value: number, heatmap: number[]): number {
  if (heatmap.length === 0) {
    return 0;
  }
  const belowCount = heatmap.filter(v => v < value).length;
  return Math.round((belowCount / heatmap.length) * 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Internal helper to fetch heatmap from the Mux Data API.
 * Uses the raw HTTP methods on the Mux client since the SDK doesn't have
 * typed methods for the engagement endpoints yet.
 */
async function fetchHeatmap(
  identifierType: "assets" | "videos" | "playback-ids",
  id: string,
  options: HeatmapOptions,
): Promise<HeatmapResponse> {
  "use step";
  const { timeframe = "24:hours", credentials } = options;

  const muxClient = await getMuxClientFromEnv(credentials);
  const mux = await muxClient.createClient();

  // Build query parameters
  const queryParams = new URLSearchParams();
  queryParams.append("timeframe[]", timeframe);

  // Use the raw HTTP method since the SDK doesn't have typed engagement methods yet
  const path = `/data/v1/engagement/${identifierType}/${id}/heatmap?${queryParams.toString()}`;
  const response = await mux.get<unknown, HeatmapApiResponse>(path);

  return transformHeatmapResponse(response);
}
