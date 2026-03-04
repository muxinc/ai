import type { HeatmapResponse } from "../../src/primitives/heatmap";
import type { Hotspot } from "../../src/primitives/hotspots";

/**
 * Mock engagement data for testing the engagement insights workflow.
 *
 * This data simulates a realistic engagement pattern for a video with:
 * - High engagement moments (peaks) where viewers re-watch
 * - Low engagement moments (valleys) where viewers skip or drop off
 * - A heatmap showing overall engagement distribution
 */

/**
 * Mocked hotspots with both high and low engagement moments.
 * Simulates a ~3 minute video (180 seconds / 180,000ms).
 */
export const MOCK_HOTSPOTS_PEAKS: Hotspot[] = [
  {
    startMs: 86922,
    endMs: 90331,
    score: 0.875, // High engagement - demonstration scene
  },
  {
    startMs: 131235,
    endMs: 141461,
    score: 0.76, // High engagement - key reveal
  },
  {
    startMs: 28974,
    endMs: 30678,
    score: 0.691, // Moderate-high engagement
  },
];

export const MOCK_HOTSPOTS_VALLEYS: Hotspot[] = [
  {
    startMs: 15000,
    endMs: 20000,
    score: 0.23, // Low engagement - slow intro
  },
  {
    startMs: 65000,
    endMs: 70000,
    score: 0.31, // Low engagement - transition/filler
  },
];

/**
 * Combined hotspots (peaks + valleys) sorted by timestamp.
 */
export const MOCK_HOTSPOTS_COMBINED: Hotspot[] = [
  MOCK_HOTSPOTS_VALLEYS[0], // 15s
  MOCK_HOTSPOTS_PEAKS[2], // 28s
  MOCK_HOTSPOTS_VALLEYS[1], // 65s
  MOCK_HOTSPOTS_PEAKS[0], // 86s
  MOCK_HOTSPOTS_PEAKS[1], // 131s
];

/**
 * Mocked heatmap data (100 elements representing engagement over time).
 * Simulates a realistic engagement curve with:
 * - Initial drop during intro (0-15%)
 * - Peak engagement around 25-50% (demonstration)
 * - Mid-video dip around 35-40% (transition)
 * - Another peak around 75% (key reveal)
 * - Gradual decline toward end (viewer dropoff)
 */
export const MOCK_HEATMAP_DATA = [
  // 0-10%: Intro with initial drop
  0.65,
  0.58,
  0.52,
  0.45,
  0.38,
  0.32,
  0.28,
  0.30,
  0.35,
  0.42,
  // 10-20%: Building engagement
  0.48,
  0.55,
  0.62,
  0.68,
  0.72,
  0.75,
  0.78,
  0.82,
  0.85,
  0.88,
  // 20-30%: Peak engagement (demonstration)
  0.90,
  0.92,
  0.94,
  0.95,
  0.93,
  0.91,
  0.89,
  0.87,
  0.85,
  0.83,
  // 30-40%: Transition dip
  0.78,
  0.72,
  0.65,
  0.58,
  0.52,
  0.48,
  0.45,
  0.50,
  0.55,
  0.60,
  // 40-50%: Recovery
  0.65,
  0.70,
  0.73,
  0.76,
  0.78,
  0.80,
  0.82,
  0.83,
  0.84,
  0.85,
  // 50-60%: Stable engagement
  0.85,
  0.84,
  0.83,
  0.82,
  0.81,
  0.80,
  0.79,
  0.78,
  0.77,
  0.76,
  // 60-70%: Building to second peak
  0.76,
  0.77,
  0.78,
  0.79,
  0.81,
  0.83,
  0.85,
  0.87,
  0.89,
  0.91,
  // 70-80%: Second peak (key reveal)
  0.93,
  0.95,
  0.94,
  0.92,
  0.90,
  0.88,
  0.86,
  0.84,
  0.82,
  0.80,
  // 80-90%: Gradual decline
  0.78,
  0.75,
  0.72,
  0.69,
  0.66,
  0.63,
  0.60,
  0.57,
  0.54,
  0.51,
  // 90-100%: End dropoff
  0.48,
  0.45,
  0.42,
  0.39,
  0.36,
  0.33,
  0.30,
  0.27,
  0.24,
  0.21,
];

/**
 * Mock heatmap response for a test asset.
 */
export function createMockHeatmapResponse(assetId: string): HeatmapResponse {
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 24 * 60 * 60;

  return {
    assetId,
    heatmap: MOCK_HEATMAP_DATA,
    timeframe: [sevenDaysAgo, now],
  };
}

/**
 * Creates a mock hotspots response based on the order direction and limit.
 * @param orderDirection - 'desc' for peaks (high engagement), 'asc' for valleys (low engagement)
 * @param limit - Maximum number of hotspots to return (default: 5)
 */
export function createMockHotspotsResponse(
  orderDirection: "desc" | "asc" = "desc",
  limit: number = 5,
): Hotspot[] {
  const hotspots = orderDirection === "desc" ? MOCK_HOTSPOTS_PEAKS : MOCK_HOTSPOTS_VALLEYS;
  return hotspots.slice(0, limit);
}
