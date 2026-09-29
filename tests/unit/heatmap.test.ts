import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getHeatmapForAsset,
  getHeatmapForPlaybackId,
  getHeatmapForVideo,
} from "../../src/primitives/heatmap";

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MOCK_HEATMAP_DATA = Array.from({ length: 100 }, (_, i) =>
  Math.round((1.0 + Math.sin(i / 10) * 0.5) * 100) / 100);

const MOCK_API_RESPONSE = {
  total_row_count: null,
  timeframe: [1770831101, 1770917501],
  data: {
    total_views: 1024,
    value: MOCK_HEATMAP_DATA,
  },
};

const MOCK_EMPTY_HEATMAP_RESPONSE = {
  total_row_count: null,
  timeframe: [1770831101, 1770917501],
  data: {
    total_views: 0,
    value: Array.from({ length: 100 }).fill(0),
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Mock Setup
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../../src/lib/client-factory", () => ({
  getMuxClientFromEnv: vi.fn(),
}));

const mockAssetHeatmap = vi.fn();
const mockVideoHeatmap = vi.fn();
const mockPlaybackIdHeatmap = vi.fn();
const mockCreateClient = vi.fn(() => ({
  data: {
    engagement: {
      assets: { heatmap: mockAssetHeatmap },
      videos: { heatmap: mockVideoHeatmap },
      playbackIds: { heatmap: mockPlaybackIdHeatmap },
    },
  },
}));

// Import after mocking
const { getMuxClientFromEnv } = await import("../../src/lib/client-factory");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMuxClientFromEnv).mockResolvedValue({
    createClient: mockCreateClient,
  } as any);
});

// ─────────────────────────────────────────────────────────────────────────────
// getHeatmapForAsset
// ─────────────────────────────────────────────────────────────────────────────

describe("getHeatmapForAsset", () => {
  it("returns transformed heatmap response", async () => {
    mockAssetHeatmap.mockResolvedValue(MOCK_API_RESPONSE);

    const result = await getHeatmapForAsset("test-asset-123");

    expect(result.heatmap).toHaveLength(100);
    expect(result.assetId).toBe("test-asset-123");
    expect(result.totalViews).toBe(1024);
    expect(result.timeframe).toEqual([1770831101, 1770917501]);
  });

  it("transforms snake_case to camelCase", async () => {
    mockAssetHeatmap.mockResolvedValue(MOCK_API_RESPONSE);

    const result = await getHeatmapForAsset("test-asset-123");

    expect(result).toHaveProperty("assetId");
    expect(result).toHaveProperty("heatmap");
    expect(result).toHaveProperty("totalViews");
    expect(result).toHaveProperty("timeframe");
    expect(result).not.toHaveProperty("total_views");
    expect(result).not.toHaveProperty("value");
  });

  it("handles empty heatmap array (all zeros)", async () => {
    mockAssetHeatmap.mockResolvedValue(MOCK_EMPTY_HEATMAP_RESPONSE);

    const result = await getHeatmapForAsset("test-asset-empty");

    expect(result.heatmap).toHaveLength(100);
    expect(result.heatmap.every(v => v === 0)).toBe(true);
  });

  it("uses default timeframe when none provided", async () => {
    mockAssetHeatmap.mockResolvedValue(MOCK_API_RESPONSE);

    await getHeatmapForAsset("test-asset-123");

    expect(mockAssetHeatmap).toHaveBeenCalledWith("test-asset-123", { timeframe: ["7:days"] });
  });

  it("passes custom timeframe option", async () => {
    mockAssetHeatmap.mockResolvedValue(MOCK_API_RESPONSE);

    await getHeatmapForAsset("test-asset-123", { timeframe: "30:days" });

    expect(mockAssetHeatmap).toHaveBeenCalledWith("test-asset-123", { timeframe: ["30:days"] });
  });

  it("passes credentials through to the mux client factory", async () => {
    mockAssetHeatmap.mockResolvedValue(MOCK_API_RESPONSE);
    const credentials = { muxTokenId: "token-id", muxTokenSecret: "token-secret" };

    await getHeatmapForAsset("test-asset-123", { credentials });

    expect(getMuxClientFromEnv).toHaveBeenCalledWith(credentials);
  });

  it("returns heatmap with numeric values", async () => {
    mockAssetHeatmap.mockResolvedValue(MOCK_API_RESPONSE);

    const result = await getHeatmapForAsset("test-asset-123");

    expect(result.heatmap.every(v => typeof v === "number")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getHeatmapForVideo
// ─────────────────────────────────────────────────────────────────────────────

describe("getHeatmapForVideo", () => {
  it("calls the videos engagement endpoint", async () => {
    mockVideoHeatmap.mockResolvedValue(MOCK_API_RESPONSE);

    await getHeatmapForVideo("test-video-123");

    expect(mockVideoHeatmap).toHaveBeenCalledWith("test-video-123", { timeframe: ["7:days"] });
    expect(mockAssetHeatmap).not.toHaveBeenCalled();
    expect(mockPlaybackIdHeatmap).not.toHaveBeenCalled();
  });

  it("returns videoId in response", async () => {
    mockVideoHeatmap.mockResolvedValue(MOCK_API_RESPONSE);

    const result = await getHeatmapForVideo("test-video-123");

    expect(result.videoId).toBe("test-video-123");
    expect(result.assetId).toBeUndefined();
    expect(result.playbackId).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getHeatmapForPlaybackId
// ─────────────────────────────────────────────────────────────────────────────

describe("getHeatmapForPlaybackId", () => {
  it("calls the playback-ids engagement endpoint", async () => {
    mockPlaybackIdHeatmap.mockResolvedValue(MOCK_API_RESPONSE);

    await getHeatmapForPlaybackId("test-playback-123");

    expect(mockPlaybackIdHeatmap).toHaveBeenCalledWith("test-playback-123", { timeframe: ["7:days"] });
    expect(mockAssetHeatmap).not.toHaveBeenCalled();
    expect(mockVideoHeatmap).not.toHaveBeenCalled();
  });

  it("returns playbackId in response", async () => {
    mockPlaybackIdHeatmap.mockResolvedValue(MOCK_API_RESPONSE);

    const result = await getHeatmapForPlaybackId("test-playback-123");

    expect(result.playbackId).toBe("test-playback-123");
    expect(result.assetId).toBeUndefined();
    expect(result.videoId).toBeUndefined();
  });
});
