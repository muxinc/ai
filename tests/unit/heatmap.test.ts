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
  asset_id: "test-asset-123",
  heatmap: MOCK_HEATMAP_DATA,
  timeframe: [1770831101, 1770917501] as [number, number],
};

const MOCK_VIDEO_RESPONSE = {
  video_id: "test-video-123",
  heatmap: MOCK_HEATMAP_DATA,
  timeframe: [1770831101, 1770917501] as [number, number],
};

const MOCK_PLAYBACK_RESPONSE = {
  playback_id: "test-playback-123",
  heatmap: MOCK_HEATMAP_DATA,
  timeframe: [1770831101, 1770917501] as [number, number],
};

const MOCK_EMPTY_HEATMAP_RESPONSE = {
  asset_id: "test-asset-empty",
  heatmap: Array.from({ length: 100 }).fill(0),
  timeframe: [1770831101, 1770917501] as [number, number],
};

// ─────────────────────────────────────────────────────────────────────────────
// Mock Setup
// ─────────────────────────────────────────────────────────────────────────────

// Mock the getMuxClientFromEnv function
vi.mock("../../src/lib/client-factory", () => ({
  getMuxClientFromEnv: vi.fn(),
}));

const mockMuxGet = vi.fn();
const mockCreateClient = vi.fn(() => ({
  get: mockMuxGet,
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
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    const result = await getHeatmapForAsset("test-asset-123");

    expect(result.heatmap).toHaveLength(100);
    expect(result.assetId).toBe("test-asset-123");
    expect(result.timeframe).toEqual([1770831101, 1770917501]);
  });

  it("transforms snake_case to camelCase", async () => {
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    const result = await getHeatmapForAsset("test-asset-123");

    expect(result).toHaveProperty("assetId");
    expect(result).toHaveProperty("heatmap");
    expect(result).toHaveProperty("timeframe");
    expect(result).not.toHaveProperty("asset_id");
  });

  it("handles empty heatmap array (all zeros)", async () => {
    mockMuxGet.mockResolvedValue(MOCK_EMPTY_HEATMAP_RESPONSE);

    const result = await getHeatmapForAsset("test-asset-empty");

    expect(result.heatmap).toHaveLength(100);
    expect(result.heatmap.every(v => v === 0)).toBe(true);
  });

  it("uses default timeframe when none provided", async () => {
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    await getHeatmapForAsset("test-asset-123");

    expect(mockMuxGet).toHaveBeenCalledWith(
      expect.stringContaining("timeframe%5B%5D=%5B24%3Ahours%5D"),
    );
  });

  it("passes custom timeframe option", async () => {
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    await getHeatmapForAsset("test-asset-123", { timeframe: "[7:days]" });

    expect(mockMuxGet).toHaveBeenCalledWith(
      expect.stringContaining("timeframe%5B%5D=%5B7%3Adays%5D"),
    );
  });

  it("constructs correct API path for assets", async () => {
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    await getHeatmapForAsset("test-asset-123");

    expect(mockMuxGet).toHaveBeenCalledWith(
      expect.stringContaining("/data/v1/engagement/assets/test-asset-123/heatmap"),
    );
  });

  it("returns heatmap with numeric values", async () => {
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    const result = await getHeatmapForAsset("test-asset-123");

    expect(result.heatmap.every(v => typeof v === "number")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getHeatmapForVideo
// ─────────────────────────────────────────────────────────────────────────────

describe("getHeatmapForVideo", () => {
  it("constructs correct API path for videos", async () => {
    mockMuxGet.mockResolvedValue(MOCK_VIDEO_RESPONSE);

    await getHeatmapForVideo("test-video-123");

    expect(mockMuxGet).toHaveBeenCalledWith(
      expect.stringContaining("/data/v1/engagement/videos/test-video-123/heatmap"),
    );
  });

  it("returns video_id in response", async () => {
    mockMuxGet.mockResolvedValue(MOCK_VIDEO_RESPONSE);

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
  it("constructs correct API path for playback-ids", async () => {
    mockMuxGet.mockResolvedValue(MOCK_PLAYBACK_RESPONSE);

    await getHeatmapForPlaybackId("test-playback-123");

    expect(mockMuxGet).toHaveBeenCalledWith(
      expect.stringContaining("/data/v1/engagement/playback-ids/test-playback-123/heatmap"),
    );
  });

  it("returns playback_id in response", async () => {
    mockMuxGet.mockResolvedValue(MOCK_PLAYBACK_RESPONSE);

    const result = await getHeatmapForPlaybackId("test-playback-123");

    expect(result.playbackId).toBe("test-playback-123");
    expect(result.assetId).toBeUndefined();
    expect(result.videoId).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Type Safety Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("type Safety", () => {
  it("accepts all valid option types", async () => {
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    // This should compile without errors
    await getHeatmapForAsset("test-asset", {
      timeframe: "[30:days]",
    });

    expect(mockMuxGet).toHaveBeenCalled();
  });

  it("heatmap response has correct structure", async () => {
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    const result = await getHeatmapForAsset("test-asset-123");

    expect(result).toHaveProperty("heatmap");
    expect(result).toHaveProperty("timeframe");
    expect(Array.isArray(result.heatmap)).toBe(true);
    expect(Array.isArray(result.timeframe)).toBe(true);
    expect(result.timeframe).toHaveLength(2);
  });
});
