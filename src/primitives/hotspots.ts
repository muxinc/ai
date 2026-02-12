import { getMuxClientFromEnv } from "@mux/ai/lib/client-factory";
import type { WorkflowCredentialsInput } from "@mux/ai/types";

export interface Hotspot {
  /** Inclusive start time in milliseconds */
  startMs: number;
  /** Exclusive end time in milliseconds */
  endMs: number;
  /** Hotspot score using distribution-based normalization (0-1) */
  score: number;
}

export interface HotspotOptions {
  /** Maximum number of hotspots to return (default: 5) */
  limit?: number;
  /** Sort order: 'asc' or 'desc' (default: 'desc') */
  orderDirection?: "asc" | "desc";
  /** Order by field (default: 'score') */
  orderBy?: "score";
  /** Time window for results, e.g., ['7:days'] (default: ['7:days']) */
  timeframe?: string;
  /** Optional workflow credentials */
  credentials?: WorkflowCredentialsInput;
}

/** Raw API response structure from Mux Data API */
// To be removed when the Mux Node SDK is updated
interface HotspotApiResponse {
  total_row_count: number | null;
  timeframe: [number, number];
  data: {
    asset_id?: string;
    video_id?: string;
    playback_id?: string;
    hotspots: Array<{
      start_ms: number;
      end_ms: number;
      score: number;
    }>;
  };
}

export interface HotspotResponse {
  assetId?: string;
  videoId?: string;
  playbackId?: string;
  hotspots: Hotspot[];
}

/**
 * Fetches engagement hotspots for a Mux asset.
 * Returns the top N "hot" time ranges based on engagement data.
 *
 * @param assetId - The Mux asset ID
 * @param options - Hotspot query options
 * @returns Array of hotspots with time ranges and scores
 */
export async function getHotspotsForAsset(
  assetId: string,
  options: HotspotOptions = {},
): Promise<Hotspot[]> {
  "use step";
  const response = await fetchHotspots("assets", assetId, options);
  return response.hotspots;
}

/**
 * Fetches engagement hotspots for a Mux video ID.
 * Returns the top N "hot" time ranges based on engagement data.
 *
 * @param videoId - The Mux video ID
 * @param options - Hotspot query options
 * @returns Array of hotspots with time ranges and scores
 */
export async function getHotspotsForVideo(
  videoId: string,
  options: HotspotOptions = {},
): Promise<Hotspot[]> {
  "use step";
  const response = await fetchHotspots("videos", videoId, options);
  return response.hotspots;
}

/**
 * Fetches engagement hotspots for a Mux playback ID.
 * Returns the top N "hot" time ranges based on engagement data.
 *
 * @param playbackId - The Mux playback ID
 * @param options - Hotspot query options
 * @returns Array of hotspots with time ranges and scores
 */
export async function getHotspotsForPlaybackId(
  playbackId: string,
  options: HotspotOptions = {},
): Promise<Hotspot[]> {
  "use step";
  const response = await fetchHotspots("playback-ids", playbackId, options);
  return response.hotspots;
}

/**
 * Transforms the snake_case API response to camelCase for the public interface.
 * TODO: Remove when the Mux Node SDK is updated
 */
function transformHotspotResponse(response: HotspotApiResponse): HotspotResponse {
  return {
    assetId: response.data.asset_id,
    videoId: response.data.video_id,
    playbackId: response.data.playback_id,
    hotspots: response.data.hotspots.map(h => ({
      startMs: h.start_ms,
      endMs: h.end_ms,
      score: h.score,
    })),
  };
}

/**
 * Internal helper to fetch hotspots from the Mux Data API.
 * Uses the raw HTTP methods on the Mux client since the SDK doesn't have
 * typed methods for the engagement endpoints yet.
 */
async function fetchHotspots(
  identifierType: "assets" | "videos" | "playback-ids",
  id: string,
  options: HotspotOptions,
): Promise<HotspotResponse> {
  "use step";
  const {
    limit = 5,
    orderDirection = "desc",
    orderBy = "score",
    timeframe = "[24:hours]",
    credentials,
  } = options;

  const muxClient = await getMuxClientFromEnv(credentials);
  const mux = await muxClient.createClient();

  // Build query parameters
  const queryParams = new URLSearchParams();
  queryParams.append("limit", String(limit));
  queryParams.append("order_direction", orderDirection);
  queryParams.append("order_by", orderBy);
  queryParams.append("timeframe[]", timeframe);

  // Use the raw HTTP method since the SDK doesn't have typed engagement methods yet
  const path = `/data/v1/engagement/${identifierType}/${id}/hotspots?${queryParams.toString()}`;
  const response = await mux.get<unknown, HotspotApiResponse>(path);

  return transformHotspotResponse(response);
}
