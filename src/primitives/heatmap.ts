import { getMuxClientFromEnv } from "../lib/client-factory.ts";
import type { WorkflowCredentialsInput } from "../types.ts";

export interface HeatmapOptions {
  /** Time window for results, e.g., '7:days' (default: '7:days') */
  timeframe?: string;
  /** Optional workflow credentials */
  credentials?: WorkflowCredentialsInput;
}

export interface HeatmapResponse {
  assetId?: string;
  videoId?: string;
  playbackId?: string;
  /** Per-bucket engagement values across the video timeline (bucket count scales with duration) */
  heatmap: number[];
  /** Number of views aggregated into the heatmap during the timeframe */
  totalViews: number;
  timeframe: [number, number];
}

/**
 * Fetches engagement heatmap for a Mux asset.
 * Returns an array where each value represents how many times
 * that slice of the video was watched.
 *
 * @param assetId - The Mux asset ID
 * @param options - Heatmap query options
 * @returns Heatmap data with per-bucket engagement values
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
 * Returns an array where each value represents how many times
 * that slice of the video was watched.
 *
 * @param videoId - The Mux video ID
 * @param options - Heatmap query options
 * @returns Heatmap data with per-bucket engagement values
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
 * Returns an array where each value represents how many times
 * that slice of the video was watched.
 *
 * @param playbackId - The Mux playback ID
 * @param options - Heatmap query options
 * @returns Heatmap data with per-bucket engagement values
 */
export async function getHeatmapForPlaybackId(
  playbackId: string,
  options: HeatmapOptions = {},
): Promise<HeatmapResponse> {
  "use step";
  return fetchHeatmap("playback-ids", playbackId, options);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────────────────────────────────────

type HeatmapIdentifierType = "assets" | "videos" | "playback-ids";

/**
 * Internal helper to fetch a heatmap from the Mux Data engagement API.
 */
async function fetchHeatmap(
  identifierType: HeatmapIdentifierType,
  id: string,
  options: HeatmapOptions,
): Promise<HeatmapResponse> {
  "use step";
  const { timeframe = "7:days", credentials } = options;

  const muxClient = await getMuxClientFromEnv(credentials);
  const mux = await muxClient.createClient();
  const query = { timeframe: [timeframe] };

  const resource = identifierType === "playback-ids" ?
    mux.data.engagement.playbackIds :
    mux.data.engagement[identifierType];
  const response = await resource.heatmap(id, query);

  return {
    assetId: identifierType === "assets" ? id : undefined,
    videoId: identifierType === "videos" ? id : undefined,
    playbackId: identifierType === "playback-ids" ? id : undefined,
    heatmap: response.data.value,
    totalViews: response.data.total_views,
    timeframe: response.timeframe as [number, number],
  };
}
