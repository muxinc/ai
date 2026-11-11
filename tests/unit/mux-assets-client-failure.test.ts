import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPlaybackIdForAsset } from "../../src/lib/mux-assets.ts";

const { getMuxClientFromEnv } = vi.hoisted(() => ({ getMuxClientFromEnv: vi.fn() }));

vi.mock("../../src/lib/client-factory.ts", () => ({ getMuxClientFromEnv }));

describe("getPlaybackIdForAsset with classified errors", () => {
  beforeEach(() => {
    getMuxClientFromEnv.mockReset();
  });

  it("reports a Mux client that can't be built (e.g. no credentials) as the service's configuration, not a Mux outage", async () => {
    getMuxClientFromEnv.mockRejectedValue(new Error("Mux credentials are required. Provide credentials or set MUX_TOKEN_ID and MUX_TOKEN_SECRET."));

    await expect(getPlaybackIdForAsset("asset-1", undefined, undefined, { classifiedErrors: true })).rejects.toMatchObject({
      type: "server_error",
      source: "internal",
      transient: false,
      retryable: false,
      facts: { assetId: "asset-1" },
    });
  });

  it("still classifies Mux's own answer by status", async () => {
    const retrieve = vi.fn().mockRejectedValue(Object.assign(new Error("503 Service Unavailable"), { status: 503 }));
    getMuxClientFromEnv.mockResolvedValue({ createClient: async () => ({ video: { assets: { retrieve } } }) });

    await expect(getPlaybackIdForAsset("asset-1", undefined, undefined, { classifiedErrors: true })).rejects.toMatchObject({
      source: "upstream",
      dependency: "mux_video",
      transient: true,
      facts: { call: "get_asset", status: 503, assetId: "asset-1" },
    });
  });
});
