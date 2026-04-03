import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupportedProvider } from "../../src/lib/providers";
import { generateEngagementInsights } from "../../src/workflows";
import {
  createMockHeatmapResponse,
  createMockHotspotsResponse,
} from "../helpers/mock-engagement-data";
import { muxTestAssets } from "../helpers/mux-test-assets";

// ─────────────────────────────────────────────────────────────────────────────
// Mock Setup
// Only mock engagement primitives (hotspots + heatmap) because test assets
// don't have real engagement data. Everything else (transcript, shots,
// storyboard, thumbnails) uses real Mux APIs so the AI SDK can download
// actual images.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../../src/primitives/hotspots", async () => {
  const actual = await vi.importActual<typeof import("../../src/primitives/hotspots")>(
    "../../src/primitives/hotspots",
  );
  return {
    ...actual,
    getHotspotsForAsset: vi.fn(),
  };
});

vi.mock("../../src/primitives/heatmap", async () => {
  const actual = await vi.importActual<typeof import("../../src/primitives/heatmap")>(
    "../../src/primitives/heatmap",
  );
  return {
    ...actual,
    getHeatmapForAsset: vi.fn(),
  };
});

const { getHotspotsForAsset } = await import("../../src/primitives/hotspots");
const { getHeatmapForAsset } = await import("../../src/primitives/heatmap");

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(getHotspotsForAsset).mockImplementation(async (_assetId, options) => {
    const orderDirection = options?.orderDirection ?? "desc";
    const limit = options?.limit ?? 5;
    return createMockHotspotsResponse(orderDirection, limit);
  });

  vi.mocked(getHeatmapForAsset).mockImplementation(async (assetId) => {
    return createMockHeatmapResponse(assetId);
  });
});

describe("engagement Insights Integration Tests", () => {
  const testAssetId = muxTestAssets.assetId;
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)(
    "should return valid result for %s provider",
    async (provider) => {
      const result = await generateEngagementInsights(testAssetId, { provider });

      expect(result).toBeDefined();
      expect(result).toHaveProperty("assetId", testAssetId);
      expect(result).toHaveProperty("momentInsights");
      expect(result).toHaveProperty("overallInsight");
      expect(Array.isArray(result.momentInsights)).toBe(true);
    },
  );

  it("should generate informational insights", async () => {
    const result = await generateEngagementInsights(testAssetId, {
      hotspotLimit: 3,
    });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("assetId", testAssetId);
    expect(result).toHaveProperty("momentInsights");
    expect(result).toHaveProperty("overallInsight");

    expect(Array.isArray(result.momentInsights)).toBe(true);
    result.momentInsights.forEach((insight) => {
      expect(insight).toHaveProperty("startMs");
      expect(insight).toHaveProperty("endMs");
      expect(insight).toHaveProperty("timestamp");
      expect(insight).toHaveProperty("engagementScore");
      expect(insight).toHaveProperty("insight");
      expect(typeof insight.insight).toBe("string");
      expect(insight.insight.length).toBeGreaterThan(0);
    });

    expect(result.overallInsight).toBeDefined();
    expect(result.overallInsight).toHaveProperty("summary");
    expect(typeof result.overallInsight.summary).toBe("string");
    expect(result.overallInsight.summary.length).toBeGreaterThan(0);
    expect(result.overallInsight).toHaveProperty("trends");
    expect(Array.isArray(result.overallInsight.trends)).toBe(true);
  });

  it("should respect hotspotLimit parameter", async () => {
    const limit = 2;
    const result = await generateEngagementInsights(testAssetId, {
      hotspotLimit: limit,
    });

    // Max is limit * 2 (peaks + valleys), minus any deduplication
    expect(result.momentInsights.length).toBeLessThanOrEqual(limit * 2);
  });

  it("should include complete result structure with usage stats", async () => {
    const result = await generateEngagementInsights(testAssetId, {
      hotspotLimit: 3,
    });

    expect(result).toHaveProperty("assetId");
    expect(result).toHaveProperty("momentInsights");
    expect(result).toHaveProperty("overallInsight");
    expect(result).toHaveProperty("usage");

    expect(result.usage).toBeDefined();
    expect(result.usage).toHaveProperty("inputTokens");
    expect(result.usage).toHaveProperty("outputTokens");
    expect(result.usage).toHaveProperty("totalTokens");
    expect(typeof result.usage?.inputTokens).toBe("number");
    expect(typeof result.usage?.outputTokens).toBe("number");
    expect(typeof result.usage?.totalTokens).toBe("number");
  });

  it("should return early with empty moments when no engagement data is available", async () => {
    vi.mocked(getHotspotsForAsset).mockResolvedValue([]);

    const result = await generateEngagementInsights(testAssetId, { timeframe: "1:hour" });

    expect(result.momentInsights).toEqual([]);
    expect(result.overallInsight.summary).toContain("No engagement data available");
    expect(result.overallInsight.trends).toEqual([]);
    expect(result.usage).toBeUndefined();
  });

  it("should handle audio-only assets gracefully", async () => {
    const audioAssetId = muxTestAssets.audioOnlyAssetId;
    const result = await generateEngagementInsights(audioAssetId, {
      hotspotLimit: 3,
    });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("momentInsights");
    expect(result).toHaveProperty("overallInsight");
  });

  it("should skip shots when skipShots is true", async () => {
    const result = await generateEngagementInsights(testAssetId, {
      hotspotLimit: 3,
      skipShots: true,
    });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("momentInsights");
  });

  it("should re-throw upstream errors from engagement data fetch", async () => {
    vi.mocked(getHeatmapForAsset).mockRejectedValue(
      new Error("500 Internal Server Error"),
    );

    await expect(
      generateEngagementInsights(testAssetId, { skipShots: true }),
    ).rejects.toThrow("Failed to fetch engagement data");
  });
});
