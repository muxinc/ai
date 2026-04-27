import { describe, expect, it } from "vitest";

import { isAudioOnlyAsset, toPlaybackAsset } from "../../src/lib/mux-assets";
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

describe("toPlaybackAsset", () => {
  it("returns playbackId and policy from a public playback ID", () => {
    const asset: Partial<MuxAsset> = {
      id: "asset-abc",
      playback_ids: [{ id: "pub-123", policy: "public" }],
    };

    const result = toPlaybackAsset(asset as MuxAsset);

    expect(result.asset).toBe(asset);
    expect(result.playbackId).toBe("pub-123");
    expect(result.policy).toBe("public");
  });

  it("falls back to signed playback ID when no public ID exists", () => {
    const asset: Partial<MuxAsset> = {
      id: "asset-abc",
      playback_ids: [{ id: "sig-456", policy: "signed" }],
    };

    const result = toPlaybackAsset(asset as MuxAsset);

    expect(result.playbackId).toBe("sig-456");
    expect(result.policy).toBe("signed");
  });

  it("prefers public playback ID over signed when both exist", () => {
    const asset: Partial<MuxAsset> = {
      id: "asset-abc",
      playback_ids: [
        { id: "sig-456", policy: "signed" },
        { id: "pub-123", policy: "public" },
      ],
    };

    const result = toPlaybackAsset(asset as MuxAsset);

    expect(result.playbackId).toBe("pub-123");
    expect(result.policy).toBe("public");
  });

  it("throws when no public or signed playback ID exists", () => {
    const asset: Partial<MuxAsset> = {
      id: "asset-abc",
      playback_ids: [],
    };

    expect(() => toPlaybackAsset(asset as MuxAsset)).toThrow(
      "No public or signed playback ID found",
    );
  });

  it("throws when playback_ids is undefined", () => {
    const asset: Partial<MuxAsset> = {
      id: "asset-abc",
    };

    expect(() => toPlaybackAsset(asset as MuxAsset)).toThrow(
      "No public or signed playback ID found",
    );
  });
});
