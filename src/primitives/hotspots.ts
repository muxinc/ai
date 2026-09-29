import { getMuxClientFromEnv } from "../lib/client-factory.ts";
import type { WorkflowCredentialsInput } from "../types.ts";

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
  /** @deprecated The API always orders by score; this option is ignored. */
  orderBy?: "score";
  /** Time window for results, e.g., '7:days' (default: '7:days') */
  timeframe?: string;
  /** Optional workflow credentials */
  credentials?: WorkflowCredentialsInput;
}

export interface HotspotResponse {
  assetId?: string;
  videoId?: string;
  playbackId?: string;
  hotspots: Hotspot[];
  /** Number of views aggregated into the hotspots during the timeframe */
  totalViews: number;
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

// ─────────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────────────────────────────────────

type HotspotIdentifierType = "assets" | "videos" | "playback-ids";

/**
 * Internal helper to fetch hotspots from the Mux Data engagement API.
 */
async function fetchHotspots(
  identifierType: HotspotIdentifierType,
  id: string,
  options: HotspotOptions,
): Promise<HotspotResponse> {
  "use step";
  const {
    limit = 5,
    orderDirection = "desc",
    timeframe = "7:days",
    credentials,
  } = options;

  const muxClient = await getMuxClientFromEnv(credentials);
  const mux = await muxClient.createClient();
  const query = {
    limit,
    order_direction: orderDirection,
    timeframe: [timeframe],
  };

  const resource = identifierType === "playback-ids" ?
    mux.data.engagement.playbackIds :
    mux.data.engagement[identifierType];
  const response = await resource.hotspots(id, query);

  return {
    assetId: identifierType === "assets" ? id : undefined,
    videoId: identifierType === "videos" ? id : undefined,
    playbackId: identifierType === "playback-ids" ? id : undefined,
    hotspots: response.data.hotspots.map(h => ({
      startMs: h.start_ms,
      endMs: h.end_ms,
      score: h.score,
    })),
    totalViews: response.data.total_views,
  };
}
