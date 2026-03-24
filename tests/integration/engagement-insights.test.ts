import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupportedProvider } from "../../src/lib/providers";
import { generateEngagementInsights } from "../../src/workflows";
import {
  createMockHeatmapResponse,
  createMockHotspotsResponse,
  createMockShotsResult,
} from "../helpers/mock-engagement-data";
import { muxTestAssets } from "../helpers/mux-test-assets";

// ─────────────────────────────────────────────────────────────────────────────
// Mock Setup
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

vi.mock("../../src/primitives/shots", async () => {
  const actual = await vi.importActual<typeof import("../../src/primitives/shots")>(
    "../../src/primitives/shots",
  );
  return {
    ...actual,
    waitForShotsForAsset: vi.fn(),
  };
});

vi.mock("../../src/primitives/storyboards", async () => {
  const actual = await vi.importActual<typeof import("../../src/primitives/storyboards")>(
    "../../src/primitives/storyboards",
  );
  return {
    ...actual,
    getStoryboardUrl: vi.fn(),
  };
});

const { getHotspotsForAsset } = await import("../../src/primitives/hotspots");
const { getHeatmapForAsset } = await import("../../src/primitives/heatmap");
const { waitForShotsForAsset } = await import("../../src/primitives/shots");
const { getStoryboardUrl } = await import("../../src/primitives/storyboards");

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

  vi.mocked(waitForShotsForAsset).mockImplementation(async () => {
    return createMockShotsResult();
  });

  vi.mocked(getStoryboardUrl).mockImplementation(async () => {
    return "https://image.mux.com/test/storyboard.png?width=640";
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
      insightType: "informational",
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
      expect(insight).toHaveProperty("type");
      expect(["high", "low"]).toContain(insight.type);
      expect(insight).toHaveProperty("percentile");
      expect(typeof insight.percentile).toBe("number");
      expect(insight.percentile).toBeGreaterThanOrEqual(0);
      expect(insight.percentile).toBeLessThanOrEqual(100);
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

  it("should generate actionable insights with recommendations", async () => {
    const result = await generateEngagementInsights(testAssetId, {
      insightType: "actionable",
      hotspotLimit: 3,
    });

    expect(result).toBeDefined();

    result.momentInsights.forEach((insight) => {
      expect(insight).toHaveProperty("recommendation");
      if (insight.recommendation) {
        expect(typeof insight.recommendation).toBe("string");
        expect(insight.recommendation.length).toBeGreaterThan(0);
      }
    });

    expect(result.overallInsight).toHaveProperty("recommendations");
    expect(Array.isArray(result.overallInsight.recommendations)).toBe(true);
  });

  it("should generate both informational and actionable insights", async () => {
    const result = await generateEngagementInsights(testAssetId, {
      insightType: "both",
      hotspotLimit: 3,
    });

    expect(result).toBeDefined();

    result.momentInsights.forEach((insight) => {
      expect(insight).toHaveProperty("insight");
      expect(insight).toHaveProperty("recommendation");
      expect(typeof insight.insight).toBe("string");
      expect(insight.insight.length).toBeGreaterThan(0);
    });

    expect(result.overallInsight).toHaveProperty("summary");
    expect(result.overallInsight).toHaveProperty("trends");
    expect(result.overallInsight).toHaveProperty("recommendations");
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

  it("should throw error when no engagement data is available", async () => {
    vi.mocked(getHotspotsForAsset).mockResolvedValue([]);

    await expect(
      generateEngagementInsights(testAssetId, { timeframe: "1:hour" }),
    ).rejects.toThrow("No engagement data available");
  });

  it("should handle audio-only assets gracefully", async () => {
    const audioAssetId = muxTestAssets.audioOnlyAssetId;
    const result = await generateEngagementInsights(audioAssetId, {
      hotspotLimit: 3,
    });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("momentInsights");
    expect(result).toHaveProperty("overallInsight");

    // Shots and storyboard should not be called for audio-only
    expect(waitForShotsForAsset).not.toHaveBeenCalled();
  });

  it("should skip shots when skipShots is true", async () => {
    const result = await generateEngagementInsights(testAssetId, {
      hotspotLimit: 3,
      skipShots: true,
    });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("momentInsights");
    expect(waitForShotsForAsset).not.toHaveBeenCalled();
  });

  it("should fall back to thumbnails when shots timeout", async () => {
    vi.mocked(waitForShotsForAsset).mockRejectedValue(
      new Error("Timed out waiting for shots"),
    );

    const result = await generateEngagementInsights(testAssetId, {
      hotspotLimit: 3,
    });

    // Should still succeed with thumbnail fallback
    expect(result).toBeDefined();
    expect(result).toHaveProperty("momentInsights");
  });

  it("should fall back to thumbnails when shots errored", async () => {
    vi.mocked(waitForShotsForAsset).mockResolvedValue({
      status: "errored",
      createdAt: new Date().toISOString(),
      error: { type: "processing_error", messages: ["Shot generation failed"] },
    } as any);

    const result = await generateEngagementInsights(testAssetId, {
      hotspotLimit: 3,
    });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("momentInsights");
  });

  it("should re-throw upstream errors from Promise.allSettled", async () => {
    vi.mocked(getHeatmapForAsset).mockRejectedValue(
      new Error("500 Internal Server Error"),
    );

    await expect(
      generateEngagementInsights(testAssetId),
    ).rejects.toThrow("Failed to fetch engagement data");
  });
});
