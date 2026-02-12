import { getMuxClientFromEnv } from "@mux/ai/lib/client-factory";
import type { WorkflowCredentialsInput } from "@mux/ai/types";

export interface HeatmapOptions {
  /** Time window for results, e.g., ['7:days'] (default: ['7:days']) */
  timeframe?: string;
  /** Optional workflow credentials */
  credentials?: WorkflowCredentialsInput;
}

/** Raw API response structure from Mux Data API */
// To be removed when the Mux Node SDK is updated
interface HeatmapApiResponse {
  asset_id?: string;
  video_id?: string;
  playback_id?: string;
  heatmap: number[];
  timeframe: [number, number];
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
    assetId: response.asset_id,
    videoId: response.video_id,
    playbackId: response.playback_id,
    heatmap: response.heatmap,
    timeframe: response.timeframe,
  };
}

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
  const { timeframe = "[24:hours]", credentials } = options;

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
