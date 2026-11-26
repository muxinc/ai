import { afterEach, describe, expect, it, vi } from "vitest";

import { getMuxImageOrigin, getMuxStoryboardBaseUrl } from "../../src/lib/mux-url";
import { getStoryboardFrames, getStoryboardUrl } from "../../src/primitives/storyboards";

describe("getStoryboardUrl", () => {
  const playbackId = "test-playback-id";

  it("keeps the existing URL when scope is omitted", async () => {
    await expect(getStoryboardUrl(playbackId)).resolves.toBe(
      `${await getMuxStoryboardBaseUrl(playbackId)}?width=640`,
    );
  });

  it("adds both asset-relative scope boundaries", async () => {
    const url = await getStoryboardUrl(
      playbackId,
      800,
      false,
      undefined,
      { startTime: 10.5, endTime: 42 },
    );

    expect(url).toBe(
      `${await getMuxStoryboardBaseUrl(playbackId)}?width=800&asset_start_time=10.5&asset_end_time=42`,
    );
  });

  it("supports a one-sided scope", async () => {
    const url = await getStoryboardUrl(
      playbackId,
      640,
      false,
      undefined,
      { startTime: 15 },
    );

    expect(url).toContain("asset_start_time=15");
    expect(url).not.toContain("asset_end_time");
  });

  it("uses muxCustomDomain from credentials", async () => {
    const url = await getStoryboardUrl(
      playbackId,
      640,
      false,
      { muxCustomDomain: "media.example.com" },
    );

    expect(url).toBe(`https://image.media.example.com/${playbackId}/storyboard.png?width=640`);
  });
});

describe("getStoryboardFrames", () => {
  const playbackId = "test-playback-id";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubStoryboardJson(body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("returns frames in reading order with their grid positions", async () => {
    stubStoryboardJson({
      tile_width: 100,
      tile_height: 50,
      tiles: [
        { start: 15, x: 0, y: 50 },
        { start: 0, x: 0, y: 0 },
        { start: 5, x: 100, y: 0 },
      ],
    });

    await expect(getStoryboardFrames(playbackId)).resolves.toEqual([
      { startTime: 0, row: 0, column: 0, width: 100, height: 50 },
      { startTime: 5, row: 0, column: 1, width: 100, height: 50 },
      { startTime: 15, row: 1, column: 0, width: 100, height: 50 },
    ]);
  });

  it("requests the scope and reports times from the start of the asset", async () => {
    const fetchMock = stubStoryboardJson({
      tile_width: 100,
      tile_height: 50,
      tiles: [{ start: 0, x: 0, y: 0 }, { start: 2.5, x: 100, y: 0 }],
    });

    const frames = await getStoryboardFrames(playbackId, undefined, false, undefined, { startTime: 60, endTime: 120 });

    expect(fetchMock).toHaveBeenCalledWith(
      `${await getMuxImageOrigin()}/${playbackId}/storyboard.json?width=640&asset_start_time=60&asset_end_time=120`,
    );
    expect(frames.map(frame => frame.startTime)).toEqual([60, 62.5]);
  });

  it("requests the image's custom width for frame positions", async () => {
    const fetchMock = stubStoryboardJson({ tile_width: 100, tile_height: 50, tiles: [] });

    await getStoryboardFrames(playbackId, 800);

    expect(fetchMock).toHaveBeenCalledWith(`${await getMuxImageOrigin()}/${playbackId}/storyboard.json?width=800`);
  });

  it("returns no frames when the response can't be read", async () => {
    stubStoryboardJson({ tiles: "nope" });

    await expect(getStoryboardFrames(playbackId)).resolves.toEqual([]);
  });

  it("throws a classified error when Mux rejects the request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, headers: new Headers() }));

    await expect(getStoryboardFrames(playbackId)).rejects.toMatchObject({ code: "playback_access_denied" });
  });
});
