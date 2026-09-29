import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getHotspotsForAsset,
  getHotspotsForPlaybackId,
  getHotspotsForVideo,
} from "../../src/primitives/hotspots";

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MOCK_API_RESPONSE = {
  total_row_count: null,
  timeframe: [1770831101, 1770917501],
  data: {
    asset_id: "test-asset-123",
    hotspots: [
      { start_ms: 86922, score: 0.875, end_ms: 90331 },
      { start_ms: 131235, score: 0.76, end_ms: 141461 },
      { start_ms: 109079, score: 0.691, end_ms: 110783 },
      { start_ms: 28974, score: 0.603, end_ms: 30678 },
      { start_ms: 161914, score: 0.603, end_ms: 163618 },
    ],
  },
};

const MOCK_EMPTY_RESPONSE = {
  total_row_count: null,
  timeframe: [1770831101, 1770917501],
  data: {
    video_id: "test-video-123",
    hotspots: [],
  },
};

const MOCK_SINGLE_HOTSPOT_RESPONSE = {
  total_row_count: null,
  timeframe: [1770831101, 1770917501],
  data: {
    playback_id: "test-playback-123",
    hotspots: [
      { start_ms: 5000, score: 0.95, end_ms: 10000 },
    ],
  },
};

const DEFAULT_QUERY = {
  limit: 5,
  order_direction: "desc",
  timeframe: ["7:days"],
};

// ─────────────────────────────────────────────────────────────────────────────
// Mock Setup
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../../src/lib/client-factory", () => ({
  getMuxClientFromEnv: vi.fn(),
}));

const mockAssetHotspots = vi.fn();
const mockVideoHotspots = vi.fn();
const mockPlaybackIdHotspots = vi.fn();
const mockCreateClient = vi.fn(() => ({
  data: {
    engagement: {
      assets: { hotspots: mockAssetHotspots },
      videos: { hotspots: mockVideoHotspots },
      playbackIds: { hotspots: mockPlaybackIdHotspots },
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
// getHotspotsForAsset
// ─────────────────────────────────────────────────────────────────────────────

describe("getHotspotsForAsset", () => {
  it("returns transformed hotspots array", async () => {
    mockAssetHotspots.mockResolvedValue(MOCK_API_RESPONSE);

    const result = await getHotspotsForAsset("test-asset-123");

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({
      startMs: 86922,
      endMs: 90331,
      score: 0.875,
    });
  });

  it("transforms snake_case to camelCase", async () => {
    mockAssetHotspots.mockResolvedValue(MOCK_API_RESPONSE);

    const result = await getHotspotsForAsset("test-asset-123");

    result.forEach((hotspot) => {
      expect(hotspot).toHaveProperty("startMs");
      expect(hotspot).toHaveProperty("endMs");
      expect(hotspot).toHaveProperty("score");
      expect(hotspot).not.toHaveProperty("start_ms");
      expect(hotspot).not.toHaveProperty("end_ms");
    });
  });

  it("handles empty hotspots array", async () => {
    mockAssetHotspots.mockResolvedValue(MOCK_EMPTY_RESPONSE);

    const result = await getHotspotsForAsset("test-asset-123");

    expect(result).toEqual([]);
  });

  it("uses default options when none provided", async () => {
    mockAssetHotspots.mockResolvedValue(MOCK_API_RESPONSE);

    await getHotspotsForAsset("test-asset-123");

    expect(mockAssetHotspots).toHaveBeenCalledWith("test-asset-123", DEFAULT_QUERY);
  });

  it("passes custom limit option", async () => {
    mockAssetHotspots.mockResolvedValue(MOCK_API_RESPONSE);

    await getHotspotsForAsset("test-asset-123", { limit: 3 });

    expect(mockAssetHotspots).toHaveBeenCalledWith("test-asset-123", { ...DEFAULT_QUERY, limit: 3 });
  });

  it("passes custom orderDirection option", async () => {
    mockAssetHotspots.mockResolvedValue(MOCK_API_RESPONSE);

    await getHotspotsForAsset("test-asset-123", { orderDirection: "asc" });

    expect(mockAssetHotspots).toHaveBeenCalledWith("test-asset-123", { ...DEFAULT_QUERY, order_direction: "asc" });
  });

  it("passes custom timeframe option", async () => {
    mockAssetHotspots.mockResolvedValue(MOCK_API_RESPONSE);

    await getHotspotsForAsset("test-asset-123", { timeframe: "30:days" });

    expect(mockAssetHotspots).toHaveBeenCalledWith("test-asset-123", { ...DEFAULT_QUERY, timeframe: ["30:days"] });
  });

  it("does not send the deprecated orderBy option", async () => {
    mockAssetHotspots.mockResolvedValue(MOCK_API_RESPONSE);

    await getHotspotsForAsset("test-asset-123", { orderBy: "score" });

    expect(mockAssetHotspots).toHaveBeenCalledWith("test-asset-123", DEFAULT_QUERY);
  });

  it("passes credentials through to the mux client factory", async () => {
    mockAssetHotspots.mockResolvedValue(MOCK_API_RESPONSE);
    const credentials = { muxTokenId: "token-id", muxTokenSecret: "token-secret" };

    await getHotspotsForAsset("test-asset-123", { credentials });

    expect(getMuxClientFromEnv).toHaveBeenCalledWith(credentials);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getHotspotsForVideo
// ─────────────────────────────────────────────────────────────────────────────

describe("getHotspotsForVideo", () => {
  it("calls the videos engagement endpoint", async () => {
    mockVideoHotspots.mockResolvedValue(MOCK_API_RESPONSE);

    const result = await getHotspotsForVideo("test-video-123");

    expect(mockVideoHotspots).toHaveBeenCalledWith("test-video-123", DEFAULT_QUERY);
    expect(mockAssetHotspots).not.toHaveBeenCalled();
    expect(mockPlaybackIdHotspots).not.toHaveBeenCalled();
    expect(result).toHaveLength(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getHotspotsForPlaybackId
// ─────────────────────────────────────────────────────────────────────────────

describe("getHotspotsForPlaybackId", () => {
  it("calls the playback-ids engagement endpoint", async () => {
    mockPlaybackIdHotspots.mockResolvedValue(MOCK_SINGLE_HOTSPOT_RESPONSE);

    const result = await getHotspotsForPlaybackId("test-playback-123");

    expect(mockPlaybackIdHotspots).toHaveBeenCalledWith("test-playback-123", DEFAULT_QUERY);
    expect(mockAssetHotspots).not.toHaveBeenCalled();
    expect(mockVideoHotspots).not.toHaveBeenCalled();
    expect(result).toEqual([{ startMs: 5000, endMs: 10000, score: 0.95 }]);
  });
});
