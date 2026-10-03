import { describe, expect, it } from "vitest";

import {
  getLegacyMp4Support,
  getLegacyMp4SupportRenditionSizeError,
  resolveLegacyMp4SupportRendition,
} from "../../src/lib/mux-static-renditions";

function legacyAsset(mp4Support: string | undefined, staticRenditions?: object) {
  return { id: "asset-1", mp4_support: mp4Support, static_renditions: staticRenditions } as any;
}

function legacyFile(name: string, filesize?: string | number) {
  return { name, ext: name.endsWith(".m4a") ? "m4a" : "mp4", filesize };
}

describe("getLegacyMp4Support", () => {
  it("returns the mp4_support value when the deprecated option is in use", () => {
    expect(getLegacyMp4Support(legacyAsset("capped-1080p"))).toBe("capped-1080p");
  });

  it.each([undefined, "none"])("returns undefined for mp4_support=%s", (mp4Support) => {
    expect(getLegacyMp4Support(legacyAsset(mp4Support))).toBeUndefined();
  });
});

describe("resolveLegacyMp4SupportRendition", () => {
  it("returns undefined for assets on the Static Renditions API", () => {
    expect(resolveLegacyMp4SupportRendition(legacyAsset(undefined, {
      files: [{ id: "r1", name: "audio.m4a", status: "ready", resolution: "audio-only" }],
    }))).toBeUndefined();
    expect(resolveLegacyMp4SupportRendition(legacyAsset("none"))).toBeUndefined();
  });

  it.each([
    ["capped-1080p", ["capped-1080p.mp4"], "capped-1080p.mp4"],
    ["audio-only", ["audio.m4a"], "audio.m4a"],
    ["audio-only,capped-1080p", ["audio.m4a", "capped-1080p.mp4"], "audio.m4a"],
    ["standard", ["low.mp4", "medium.mp4", "high.mp4"], "low.mp4"],
  ])("picks the preferred file for mp4_support=%s", (mp4Support, fileNames, expected) => {
    const asset = legacyAsset(mp4Support, { status: "ready", files: fileNames.map(name => legacyFile(name)) });

    expect(resolveLegacyMp4SupportRendition(asset)).toEqual({ kind: "ready", mp4Support, name: expected });
  });

  it.each([
    ["capped-1080p", "audio.m4a"],
    ["standard", "audio.m4a"],
  ])("falls back to audio.m4a for an audio-only asset with mp4_support=%s", (mp4Support, fileName) => {
    const asset = legacyAsset(mp4Support, { status: "ready", files: [legacyFile(fileName)] });

    expect(resolveLegacyMp4SupportRendition(asset)).toMatchObject({ kind: "ready", name: "audio.m4a" });
  });

  it("falls back to capped-1080p.mp4 for a video-only asset with mp4_support=audio-only,capped-1080p", () => {
    const asset = legacyAsset("audio-only,capped-1080p", { status: "ready", files: [legacyFile("capped-1080p.mp4")] });

    expect(resolveLegacyMp4SupportRendition(asset)).toMatchObject({ kind: "ready", name: "capped-1080p.mp4" });
  });

  it.each([
    ["a string", "2500000000", 2_500_000_000],
    ["a number", 2_500_000_000, 2_500_000_000],
    ["missing", undefined, undefined],
  ])("parses filesize when it is %s", (_label, filesize, expected) => {
    const asset = legacyAsset("capped-1080p", { status: "ready", files: [legacyFile("capped-1080p.mp4", filesize)] });

    expect(resolveLegacyMp4SupportRendition(asset)).toMatchObject({ kind: "ready", filesizeBytes: expected });
  });

  it.each([
    ["preparing", { status: "preparing", files: [] }],
    ["not yet reported", undefined],
  ])("reports preparing while the aggregate status is %s", (_label, staticRenditions) => {
    expect(resolveLegacyMp4SupportRendition(legacyAsset("capped-1080p", staticRenditions))).toEqual({
      kind: "preparing",
      mp4Support: "capped-1080p",
    });
  });

  it.each(["errored", "disabled"])("reports %s renditions as unusable and points at the Static Renditions API", (status) => {
    const rendition = resolveLegacyMp4SupportRendition(legacyAsset("audio-only", { status, files: [] }));

    expect(rendition).toMatchObject({ kind: "unusable", mp4Support: "audio-only" });
    expect(rendition?.kind === "unusable" && rendition.reason).toContain(`static renditions are ${status}`);
    expect(rendition?.kind === "unusable" && rendition.reason).toContain("https://www.mux.com/docs/guides/enable-static-mp4-renditions");
  });

  it("reports a ready asset with none of the preferred files as unusable", () => {
    const rendition = resolveLegacyMp4SupportRendition(legacyAsset("audio-only", { status: "ready", files: [legacyFile("capped-1080p.mp4")] }));

    expect(rendition).toMatchObject({ kind: "unusable", mp4Support: "audio-only" });
  });
});

describe("getLegacyMp4SupportRenditionSizeError", () => {
  const ready = { kind: "ready", mp4Support: "capped-1080p", name: "capped-1080p.mp4" } as const;

  it("returns undefined when the file fits or its size is unknown", () => {
    expect(getLegacyMp4SupportRenditionSizeError({ ...ready, filesizeBytes: 1_000_000_000 }, 1_000_000_000)).toBeUndefined();
    expect(getLegacyMp4SupportRenditionSizeError(ready, 1_000_000_000)).toBeUndefined();
  });

  it("explains how to move off mp4_support when the file is too large", () => {
    const message = getLegacyMp4SupportRenditionSizeError({ ...ready, filesizeBytes: 2_345_678_901 }, 1_000_000_000);

    expect(message).toBe(
      "This asset uses the deprecated mp4_support setting, and its capped-1080p.mp4 static rendition (2.35 GB) is larger than the 1 GB this workflow can process. Move the asset to the Static Renditions API (https://www.mux.com/docs/guides/enable-static-mp4-renditions) and add an audio-only static rendition, then retry.",
    );
  });
});
