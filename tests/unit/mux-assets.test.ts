import { describe, expect, it } from "vitest";

import { getPlaybackIdForAsset, isAudioOnlyAsset } from "../../src/lib/mux-assets";
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
    const promise = getPlaybackIdForAsset("asset-other", undefined, asset);
    await expect(promise).rejects.toThrow(
      "Asset snapshot does not match the requested asset ID",
    );
  });
});
