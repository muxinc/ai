import { beforeEach, describe, expect, it, vi } from "vitest";
import { start } from "workflow/api";

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

  it.each(providers)("should return a run with a runId for each provider", async (provider) => {
    const run = await start(generateEngagementInsights, [testAssetId, { provider }]);
    expect(run.runId).toMatch(/^wrun_/);

    const result = await run.returnValue;
    expect(result).toHaveProperty("assetId", testAssetId);
    expect(result).toHaveProperty("momentInsights");
    expect(result).toHaveProperty("overallInsight");
    expect(Array.isArray(result.momentInsights)).toBe(true);
  });
});
