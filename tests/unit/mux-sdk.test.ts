import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";

import Mux from "@mux/ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signPlaybackId } from "../../src/lib/url-signing";
import { resolveMuxClient } from "../../src/lib/workflow-credentials";
import { getHeatmapForAsset } from "../../src/primitives/heatmap";
import { getHotspotsForAsset, getHotspotsForPlaybackId } from "../../src/primitives/hotspots";
import { getShotsForAsset, requestShotsForAsset, waitForShotsForAsset } from "../../src/primitives/shots";
import type { WorkflowMuxClient } from "../../src/types";

/**
 * Exercises the real @mux/ts package (no network) so SDK upgrades that drop or
 * rename the surfaces this library depends on fail here rather than at runtime.
 */

vi.mock("../../src/lib/client-factory", () => ({
  getMuxClientFromEnv: vi.fn(),
}));

const { getMuxClientFromEnv } = await import("../../src/lib/client-factory");

const sdkFetch = vi.fn();
const manifestFetch = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(call: number): URL {
  const [input] = sdkFetch.mock.calls[call];
  return new URL(typeof input === "string" ? input : (input as Request).url);
}

function requestInit(call: number): RequestInit {
  return sdkFetch.mock.calls[call][1] as RequestInit;
}

/** A WorkflowMuxClient backed by a real Mux client whose fetch is captured. */
const capturedMuxClient: WorkflowMuxClient = {
  createClient: async () => new Mux({
    tokenId: "token-id",
    tokenSecret: "token-secret",
    fetch: sdkFetch,
    maxRetries: 0,
  }),
  getSigningKey: () => undefined,
  getPrivateKey: () => undefined,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getMuxClientFromEnv).mockResolvedValue(capturedMuxClient);
  vi.stubGlobal("fetch", manifestFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("sDK surface used by this library", () => {
  it("resolveMuxClient creates a client exposing every method we call", async () => {
    const workflowClient = await resolveMuxClient({
      muxTokenId: "token-id",
      muxTokenSecret: "token-secret",
    });
    const mux = await workflowClient.createClient();

    expect(mux).toBeInstanceOf(Mux);
    expect(mux.tokenId).toBe("token-id");
    expect(mux.tokenSecret).toBe("token-secret");

    const assets = mux.video.assets;
    for (const method of ["retrieve", "createTrack", "deleteTrack", "createStaticRendition", "deleteStaticRendition", "retrieveShots", "generateShots"] as const) {
      expect(typeof assets[method], `video.assets.${method}`).toBe("function");
    }
    for (const resource of ["assets", "videos", "playbackIds"] as const) {
      expect(typeof mux.data.engagement[resource].heatmap, `engagement.${resource}.heatmap`).toBe("function");
      expect(typeof mux.data.engagement[resource].hotspots, `engagement.${resource}.hotspots`).toBe("function");
    }
    // Custom (non-generated) SDK code; a regenerated build can silently drop it.
    expect(typeof mux.jwt?.signPlaybackId).toBe("function");
  });

  it("sends Basic auth built from the token pair", async () => {
    sdkFetch.mockResolvedValue(jsonResponse({ data: { id: "asset-1" } }));
    const mux = await capturedMuxClient.createClient();

    await mux.video.assets.retrieve("asset-1");

    const headers = new Headers(requestInit(0).headers);
    const expected = `Basic ${Buffer.from("token-id:token-secret").toString("base64")}`;
    expect(headers.get("authorization")).toBe(expected);
  });
});

describe("jWT signing through the SDK", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keySecret = Buffer.from(privateKey.export({ type: "pkcs1", format: "pem" }) as string).toString("base64");

  function decode(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
    const [header, payload] = token.split(".");
    return {
      header: JSON.parse(Buffer.from(header, "base64url").toString()),
      payload: JSON.parse(Buffer.from(payload, "base64url").toString()),
    };
  }

  it("signs without API tokens in the environment", async () => {
    vi.stubEnv("MUX_TOKEN_ID", undefined);
    vi.stubEnv("MUX_TOKEN_SECRET", undefined);

    const token = await signPlaybackId("playback-123", { keyId: "key-abc", keySecret }, "thumbnail", { time: 5, width: 640 });
    const { header, payload } = decode(token);

    expect(header.alg).toBe("RS256");
    expect(header.kid ?? payload.kid).toBe("key-abc");
    expect(payload).toMatchObject({ sub: "playback-123", aud: "t", time: "5", width: "640" });
    expect(typeof payload.exp).toBe("number");
  });

  it("maps token types to the Mux audience claims", async () => {
    const context = { keyId: "key-abc", keySecret };
    const audiences: Record<string, string> = {};
    for (const type of ["video", "thumbnail", "storyboard", "gif"] as const) {
      audiences[type] = decode(await signPlaybackId("pid", context, type)).payload.aud as string;
    }
    expect(audiences).toEqual({ video: "v", thumbnail: "t", storyboard: "s", gif: "g" });
  });
});

describe("engagement requests through the SDK", () => {
  it("encodes heatmap query params the way the API expects", async () => {
    sdkFetch.mockResolvedValue(jsonResponse({
      total_row_count: null,
      timeframe: [1, 2],
      data: { asset_id: "asset-1", heatmap: [0, 1, 2] },
    }));

    const result = await getHeatmapForAsset("asset-1", { timeframe: "30:days" });

    const url = requestUrl(0);
    expect(url.pathname).toBe("/data/v1/engagement/assets/asset-1/heatmap");
    expect(url.search).toBe("?timeframe%5B%5D=30%3Adays");
    expect(requestInit(0).method).toBe("GET");
    expect(result).toEqual({ assetId: "asset-1", videoId: undefined, playbackId: undefined, heatmap: [0, 1, 2], timeframe: [1, 2] });
  });

  it("encodes hotspot query params and omits order_by", async () => {
    sdkFetch.mockResolvedValue(jsonResponse({
      total_row_count: null,
      timeframe: [1, 2],
      data: { asset_id: "asset-1", hotspots: [{ start_ms: 10, end_ms: 20, score: 0.5 }] },
    }));

    const result = await getHotspotsForAsset("asset-1", { limit: 2, orderDirection: "asc", orderBy: "score" });

    const params = requestUrl(0).searchParams;
    expect(requestUrl(0).pathname).toBe("/data/v1/engagement/assets/asset-1/hotspots");
    expect(params.get("limit")).toBe("2");
    expect(params.get("order_direction")).toBe("asc");
    expect(params.getAll("timeframe[]")).toEqual(["7:days"]);
    expect(params.has("order_by")).toBe(false);
    expect(result).toEqual([{ startMs: 10, endMs: 20, score: 0.5 }]);
  });

  it("routes playback-id lookups to the playback-ids resource", async () => {
    sdkFetch.mockResolvedValue(jsonResponse({ total_row_count: null, timeframe: [1, 2], data: { playback_id: "pid", hotspots: [] } }));

    await getHotspotsForPlaybackId("pid");

    expect(requestUrl(0).pathname).toBe("/data/v1/engagement/playback-ids/pid/hotspots");
  });
});

describe("shots requests through the SDK", () => {
  const pending = { data: { status: "pending", created_at: "1" } };
  const completed = { data: { status: "completed", created_at: "1", shots_manifest_url: "https://artifacts.mux.com/a/x/shots.json" } };
  const manifest = { shots: [{ start_time: 0, shot_preview_image_url: "https://artifacts.mux.com/a/x/shot_0.webp" }] };

  it("posts an empty JSON body and unwraps the data envelope", async () => {
    sdkFetch.mockResolvedValue(jsonResponse(pending));

    const result = await requestShotsForAsset("asset-1");

    expect(requestUrl(0).pathname).toBe("/video/v1/assets/asset-1/shots");
    expect(requestInit(0).method).toBe("POST");
    expect(requestInit(0).body).toBe("{}");
    expect(result).toEqual({ status: "pending", createdAt: "1" });
  });

  it("gets shots and follows the manifest URL", async () => {
    sdkFetch.mockResolvedValue(jsonResponse(completed));
    manifestFetch.mockResolvedValue(jsonResponse(manifest));

    const result = await getShotsForAsset("asset-1");

    expect(requestInit(0).method).toBe("GET");
    expect(manifestFetch).toHaveBeenCalledWith(completed.data.shots_manifest_url);
    expect(result).toMatchObject({ status: "completed", shots: [{ startTime: 0 }] });
  });

  it("treats the real APIError for an already-requested asset as non-fatal", async () => {
    sdkFetch
      .mockResolvedValueOnce(jsonResponse({ error: { type: "invalid_parameters", messages: ["Shots generation has already been requested"] } }, 400))
      .mockResolvedValueOnce(jsonResponse(completed));
    manifestFetch.mockResolvedValue(jsonResponse(manifest));

    const result = await waitForShotsForAsset("asset-1", { pollIntervalMs: 0, maxAttempts: 2 });

    expect(result.status).toBe("completed");
    expect(sdkFetch).toHaveBeenCalledTimes(2);
  });

  it("surfaces other 400s from the SDK as errors", async () => {
    sdkFetch.mockResolvedValue(jsonResponse({ error: { type: "invalid_parameters", messages: ["Asset is not ready"] } }, 400));

    await expect(waitForShotsForAsset("asset-1", { pollIntervalMs: 0, maxAttempts: 1 })).rejects.toBeInstanceOf(Mux.BadRequestError);
  });
});
