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
  timeframe: [1770831101, 1770917501] as [number, number],
  data: {
    asset_id: "test-asset-123",
    hotspots: [
      {
        start_ms: 86922,
        score: 0.875,
        end_ms: 90331,
      },
      {
        start_ms: 131235,
        score: 0.76,
        end_ms: 141461,
      },
      {
        start_ms: 109079,
        score: 0.691,
        end_ms: 110783,
      },
      {
        start_ms: 28974,
        score: 0.603,
        end_ms: 30678,
      },
      {
        start_ms: 161914,
        score: 0.603,
        end_ms: 163618,
      },
    ],
  },
};

const MOCK_EMPTY_RESPONSE = {
  total_row_count: null,
  timeframe: [1770831101, 1770917501] as [number, number],
  data: {
    video_id: "test-video-123",
    hotspots: [],
  },
};

const MOCK_SINGLE_HOTSPOT_RESPONSE = {
  total_row_count: null,
  timeframe: [1770831101, 1770917501] as [number, number],
  data: {
    playback_id: "test-playback-123",
    hotspots: [
      {
        start_ms: 5000,
        score: 0.95,
        end_ms: 10000,
      },
    ],
  },
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
// getHotspotsForAsset
// ─────────────────────────────────────────────────────────────────────────────

describe("getHotspotsForAsset", () => {
  it("returns transformed hotspots array", async () => {
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    const result = await getHotspotsForAsset("test-asset-123");

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({
      startMs: 86922,
      endMs: 90331,
      score: 0.875,
    });
  });

  it("transforms snake_case to camelCase", async () => {
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    const result = await getHotspotsForAsset("test-asset-123");

    // Verify all properties are camelCase
    result.forEach((hotspot) => {
      expect(hotspot).toHaveProperty("startMs");
      expect(hotspot).toHaveProperty("endMs");
      expect(hotspot).toHaveProperty("score");
      expect(hotspot).not.toHaveProperty("start_ms");
      expect(hotspot).not.toHaveProperty("end_ms");
    });
  });

  it("handles empty hotspots array", async () => {
    mockMuxGet.mockResolvedValue(MOCK_EMPTY_RESPONSE);

    const result = await getHotspotsForAsset("test-asset-123");

    expect(result).toEqual([]);
  });

  it("uses default options when none provided", async () => {
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    await getHotspotsForAsset("test-asset-123");

    expect(mockMuxGet).toHaveBeenCalledWith(
      expect.stringContaining("limit=5"),
    );
    expect(mockMuxGet).toHaveBeenCalledWith(
      expect.stringContaining("order_direction=desc"),
    );
    expect(mockMuxGet).toHaveBeenCalledWith(
      expect.stringContaining("order_by=score"),
    );
    expect(mockMuxGet).toHaveBeenCalledWith(
      expect.stringContaining("timeframe%5B%5D=%5B24%3Ahours%5D"),
    );
  });

  it("passes custom limit option", async () => {
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    await getHotspotsForAsset("test-asset-123", { limit: 3 });

    expect(mockMuxGet).toHaveBeenCalledWith(
      expect.stringContaining("limit=3"),
    );
  });

  it("passes custom orderDirection option", async () => {
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    await getHotspotsForAsset("test-asset-123", { orderDirection: "asc" });

    expect(mockMuxGet).toHaveBeenCalledWith(
      expect.stringContaining("order_direction=asc"),
    );
  });

  it("passes custom timeframe option", async () => {
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    await getHotspotsForAsset("test-asset-123", { timeframe: "[7:days]" });

    expect(mockMuxGet).toHaveBeenCalledWith(
      expect.stringContaining("timeframe%5B%5D=%5B7%3Adays%5D"),
    );
  });

  it("constructs correct API path for assets", async () => {
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    await getHotspotsForAsset("test-asset-123");

    expect(mockMuxGet).toHaveBeenCalledWith(
      expect.stringContaining("/data/v1/engagement/assets/test-asset-123/hotspots"),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getHotspotsForVideo
// ─────────────────────────────────────────────────────────────────────────────

describe("getHotspotsForVideo", () => {
  it("constructs correct API path for videos", async () => {
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    await getHotspotsForVideo("test-video-123");

    expect(mockMuxGet).toHaveBeenCalledWith(
      expect.stringContaining("/data/v1/engagement/videos/test-video-123/hotspots"),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getHotspotsForPlaybackId
// ─────────────────────────────────────────────────────────────────────────────

describe("getHotspotsForPlaybackId", () => {
  it("constructs correct API path for playback-ids", async () => {
    mockMuxGet.mockResolvedValue(MOCK_SINGLE_HOTSPOT_RESPONSE);

    await getHotspotsForPlaybackId("test-playback-123");

    expect(mockMuxGet).toHaveBeenCalledWith(
      expect.stringContaining("/data/v1/engagement/playback-ids/test-playback-123/hotspots"),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Type Safety Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("type Safety", () => {
  it("accepts all valid option types", async () => {
    mockMuxGet.mockResolvedValue(MOCK_API_RESPONSE);

    // This should compile without errors
    await getHotspotsForAsset("test-asset", {
      limit: 10,
      orderDirection: "asc",
      orderBy: "score",
      timeframe: "[7:days]",
    });

    expect(mockMuxGet).toHaveBeenCalled();
  });
});
