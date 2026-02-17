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
// ─────────────────────────────────────────────────────────────────────────────

// Mock the primitives to return mock engagement data
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

// Import mocked functions
const { getHotspotsForAsset } = await import("../../src/primitives/hotspots");
const { getHeatmapForAsset } = await import("../../src/primitives/heatmap");

beforeEach(() => {
  vi.clearAllMocks();

  // Setup mock responses
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
  // Note: These tests use mocked engagement data to verify workflow functionality
  // without requiring real viewer activity on test assets.
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

    // Check moment insights structure
    expect(Array.isArray(result.momentInsights)).toBe(true);
    result.momentInsights.forEach((insight) => {
      expect(insight).toHaveProperty("startMs");
      expect(insight).toHaveProperty("endMs");
      expect(insight).toHaveProperty("timestamp");
      expect(insight).toHaveProperty("engagementScore");
      expect(insight).toHaveProperty("type");
      expect(["high", "low"]).toContain(insight.type);
      expect(insight).toHaveProperty("insight");
      expect(typeof insight.insight).toBe("string");
      expect(insight.insight.length).toBeGreaterThan(0);
      expect(insight).toHaveProperty("confidence");
      expect(insight.confidence).toBeGreaterThanOrEqual(0);
      expect(insight.confidence).toBeLessThanOrEqual(1);
    });

    // Check overall insight structure
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

    // Check that moment insights have recommendations
    result.momentInsights.forEach((insight) => {
      expect(insight).toHaveProperty("recommendation");
      if (insight.recommendation) {
        expect(typeof insight.recommendation).toBe("string");
        expect(insight.recommendation.length).toBeGreaterThan(0);
      }
    });

    // Check that overall insight has recommendations
    expect(result.overallInsight).toHaveProperty("recommendations");
    expect(Array.isArray(result.overallInsight.recommendations)).toBe(true);
  });

  it("should generate both informational and actionable insights", async () => {
    const result = await generateEngagementInsights(testAssetId, {
      insightType: "both",
      hotspotLimit: 3,
    });

    expect(result).toBeDefined();

    // Check that moment insights have both insight and recommendation
    result.momentInsights.forEach((insight) => {
      expect(insight).toHaveProperty("insight");
      expect(insight).toHaveProperty("recommendation");
      expect(typeof insight.insight).toBe("string");
      expect(insight.insight.length).toBeGreaterThan(0);
    });

    // Check that overall insight has both
    expect(result.overallInsight).toHaveProperty("summary");
    expect(result.overallInsight).toHaveProperty("trends");
    expect(result.overallInsight).toHaveProperty("recommendations");
  });

  it("should respect hotspotLimit parameter", async () => {
    const limit = 2;
    const result = await generateEngagementInsights(testAssetId, {
      hotspotLimit: limit,
    });

    expect(result.momentInsights.length).toBeLessThanOrEqual(limit * 2);
    // Note: We fetch limit peaks + limit valleys, so max is limit * 2
  });

  it("should include complete result structure with usage stats", async () => {
    const result = await generateEngagementInsights(testAssetId, {
      hotspotLimit: 3,
    });

    // Check result structure
    expect(result).toHaveProperty("assetId");
    expect(result).toHaveProperty("momentInsights");
    expect(result).toHaveProperty("overallInsight");
    expect(result).toHaveProperty("usage");

    // Check token usage statistics
    expect(result.usage).toBeDefined();
    expect(result.usage).toHaveProperty("inputTokens");
    expect(result.usage).toHaveProperty("outputTokens");
    expect(result.usage).toHaveProperty("totalTokens");
    expect(typeof result.usage?.inputTokens).toBe("number");
    expect(typeof result.usage?.outputTokens).toBe("number");
    expect(typeof result.usage?.totalTokens).toBe("number");
  });

  it("should throw error when no engagement data is available", async () => {
    // Mock empty hotspots response for this test
    vi.mocked(getHotspotsForAsset).mockResolvedValue([]);

    await expect(
      generateEngagementInsights(testAssetId, { timeframe: "[1:hour]" }),
    ).rejects.toThrow("No engagement data available");

    // Reset mocks for subsequent tests
    vi.mocked(getHotspotsForAsset).mockImplementation(async (_assetId, options) => {
      const orderDirection = options?.orderDirection ?? "desc";
      const limit = options?.limit ?? 5;
      return createMockHotspotsResponse(orderDirection, limit);
    });
  });

  it("should handle audio-only assets gracefully", async () => {
    const audioAssetId = muxTestAssets.audioOnlyAssetId;
    const result = await generateEngagementInsights(audioAssetId, {
      hotspotLimit: 3,
    });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("momentInsights");
    expect(result).toHaveProperty("overallInsight");
    // Audio-only should still work, just without visual analysis
  });
});
