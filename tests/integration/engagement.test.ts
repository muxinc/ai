import { describe, expect, it } from "vitest";

import { getPlaybackIdForAsset } from "../../src/lib/mux-assets";
import { getHeatmapForAsset, getHeatmapForPlaybackId } from "../../src/primitives/heatmap";
import { getHotspotsForAsset } from "../../src/primitives/hotspots";
import { muxTestAssets } from "../helpers/mux-test-assets";

/**
 * Live contract check for the engagement endpoints. The workflow integration
 * tests mock these primitives, so this is the only place the wire shape is
 * verified against the real API. Test assets may have no views; the shape is
 * what matters here, not the values.
 */
describe("engagement Integration Tests", () => {
  const assetId = muxTestAssets.assetId;

  it("returns a numeric heatmap for an asset", async () => {
    const result = await getHeatmapForAsset(assetId, { timeframe: "30:days" });

    expect(result.assetId).toBe(assetId);
    expect(result.videoId).toBeUndefined();
    expect(result.playbackId).toBeUndefined();
    expect(Array.isArray(result.heatmap)).toBe(true);
    expect(result.heatmap.length).toBeGreaterThan(0);
    expect(result.heatmap.every(v => typeof v === "number" && Number.isFinite(v))).toBe(true);
    expect(result.timeframe).toHaveLength(2);
    expect(result.timeframe[0]).toBeLessThan(result.timeframe[1]);
  });

  it("returns a heatmap keyed by playback ID", async () => {
    const { playbackId } = await getPlaybackIdForAsset(assetId);

    const result = await getHeatmapForPlaybackId(playbackId, { timeframe: "30:days" });

    expect(result.playbackId).toBe(playbackId);
    expect(result.assetId).toBeUndefined();
    expect(result.heatmap.length).toBeGreaterThan(0);
  });

  it("returns well-formed hotspots for an asset", async () => {
    const hotspots = await getHotspotsForAsset(assetId, { limit: 3, timeframe: "30:days" });

    expect(Array.isArray(hotspots)).toBe(true);
    expect(hotspots.length).toBeLessThanOrEqual(3);
    for (const hotspot of hotspots) {
      expect(hotspot.startMs).toBeGreaterThanOrEqual(0);
      expect(hotspot.endMs).toBeGreaterThan(hotspot.startMs);
      expect(hotspot.score).toBeGreaterThanOrEqual(0);
      expect(hotspot.score).toBeLessThanOrEqual(1);
    }
  });
});
