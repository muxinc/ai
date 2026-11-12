import { describe, expect, it } from "vitest";

import { getPlaybackIdForAsset, isAudioOnlyAsset, isVideoOnlyAsset } from "../../src/lib/mux-assets";
import type { MuxAsset } from "../../src/types";

describe("isAudioOnlyAsset", () => {
  it("should return true for asset with only audio track", () => {
    const audioOnlyAsset: Partial<MuxAsset> = {
      id: "test-audio-only",
      tracks: [
        { type: "audio", id: "audio-1" },
      ],
    };

    expect(isAudioOnlyAsset(audioOnlyAsset as MuxAsset)).toBe(true);
  });

  it("should return false for asset with video track", () => {
    const videoAsset: Partial<MuxAsset> = {
      id: "test-video",
      tracks: [
        { type: "video", id: "video-1" },
        { type: "audio", id: "audio-1" },
      ],
    };

    expect(isAudioOnlyAsset(videoAsset as MuxAsset)).toBe(false);
  });

  it("should return false for asset with only video track (no audio)", () => {
    const silentVideoAsset: Partial<MuxAsset> = {
      id: "test-silent-video",
      tracks: [
        { type: "video", id: "video-1" },
      ],
    };

    expect(isAudioOnlyAsset(silentVideoAsset as MuxAsset)).toBe(false);
  });

  it("should return true for asset with multiple audio tracks but no video", () => {
    const multiAudioAsset: Partial<MuxAsset> = {
      id: "test-multi-audio",
      tracks: [
        { type: "audio", id: "audio-1" },
        { type: "audio", id: "audio-2" },
      ],
    };

    expect(isAudioOnlyAsset(multiAudioAsset as MuxAsset)).toBe(true);
  });

  it("should return true for asset with no tracks", () => {
    const noTracksAsset: Partial<MuxAsset> = {
      id: "test-no-tracks",
      tracks: [],
    };

    expect(isAudioOnlyAsset(noTracksAsset as MuxAsset)).toBe(false);
  });

  it("should return true for asset with undefined tracks", () => {
    const undefinedTracksAsset: Partial<MuxAsset> = {
      id: "test-undefined-tracks",
      tracks: undefined,
    };

    expect(isAudioOnlyAsset(undefinedTracksAsset as MuxAsset)).toBe(false);
  });

  it("should return false for asset with text track and video track", () => {
    const textAndVideoAsset: Partial<MuxAsset> = {
      id: "test-text-video",
      tracks: [
        { type: "video", id: "video-1" },
        { type: "text", id: "text-1" },
        { type: "audio", id: "audio-1" },
      ],
    };

    expect(isAudioOnlyAsset(textAndVideoAsset as MuxAsset)).toBe(false);
  });

  it("should return true for asset with audio and text tracks (no video)", () => {
    const audioTextAsset: Partial<MuxAsset> = {
      id: "test-audio-text",
      tracks: [
        { type: "audio", id: "audio-1" },
        { type: "text", id: "text-1" },
      ],
    };

    expect(isAudioOnlyAsset(audioTextAsset as MuxAsset)).toBe(true);
  });
});

describe("getPlaybackIdForAsset", () => {
  const asset = {
    id: "asset-123",
    playback_ids: [{ id: "playback-123", policy: "public" }],
  } as MuxAsset;

  it("uses a supplied asset snapshot", async () => {
    await expect(getPlaybackIdForAsset("asset-123", undefined, asset)).resolves.toEqual({
      asset,
      playbackId: "playback-123",
      policy: "public",
    });
  });

  it("rejects a snapshot for a different asset", async () => {
    await expect(getPlaybackIdForAsset("asset-other", undefined, asset)).rejects.toThrow(
      "Asset snapshot does not match the requested asset ID",
    );
  });

  it("with classified errors, codes a snapshot for a different asset as asset_snapshot_mismatch", async () => {
    const promise = getPlaybackIdForAsset("asset-other", undefined, asset, { classifiedErrors: true });
    await expect(promise).rejects.toMatchObject({
      message: "Asset snapshot does not match the requested asset ID.",
      code: "asset_snapshot_mismatch",
      facts: { assetId: "asset-other", inputs: ["assetId", "assetSnapshot"] },
    });
  });
});

describe("isVideoOnlyAsset", () => {
  it("returns true for an asset with a video track and no audio track", () => {
    expect(isVideoOnlyAsset({ id: "v", tracks: [{ type: "video", id: "video-1" }] } as MuxAsset)).toBe(true);
  });

  it("returns false when the asset has an audio track", () => {
    expect(isVideoOnlyAsset({ id: "av", tracks: [{ type: "video", id: "video-1" }, { type: "audio", id: "audio-1" }] } as MuxAsset)).toBe(false);
    expect(isVideoOnlyAsset({ id: "a", tracks: [{ type: "audio", id: "audio-1" }] } as MuxAsset)).toBe(false);
  });

  it("returns false when tracks are not known yet", () => {
    expect(isVideoOnlyAsset({ id: "none" } as MuxAsset)).toBe(false);
    expect(isVideoOnlyAsset({ id: "empty", tracks: [] } as MuxAsset)).toBe(false);
  });
});
