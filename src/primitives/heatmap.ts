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
  /** Engagement values across the video timeline, one per equal slice (currently 100) */
  heatmap: number[];
  /** Number of views aggregated into the heatmap, when the API reports it */
  totalViews?: number;
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

/** The live API returns `heatmap` + identifier fields; the SDK types describe `value` + `total_views`. */
interface HeatmapApiData {
  asset_id?: string;
  video_id?: string;
  playback_id?: string;
  heatmap?: number[];
  value?: number[];
  total_views?: number;
}

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
  const data = response.data as HeatmapApiData;
  const heatmap = data.heatmap ?? data.value;
  if (!Array.isArray(heatmap)) {
    throw new TypeError("Invalid heatmap response: missing heatmap values");
  }

  return {
    assetId: data.asset_id ?? (identifierType === "assets" ? id : undefined),
    videoId: data.video_id ?? (identifierType === "videos" ? id : undefined),
    playbackId: data.playback_id ?? (identifierType === "playback-ids" ? id : undefined),
    heatmap,
    totalViews: data.total_views,
    timeframe: response.timeframe as [number, number],
  };
}
