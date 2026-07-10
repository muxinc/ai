import { describe, expect, it } from "vitest";

import { getMuxStoryboardBaseUrl } from "../../src/lib/mux-url";
import { getStoryboardUrl } from "../../src/primitives/storyboards";

describe("getStoryboardUrl", () => {
  const playbackId = "test-playback-id";

  it("keeps the existing URL when scope is omitted", async () => {
    await expect(getStoryboardUrl(playbackId)).resolves.toBe(
      `${getMuxStoryboardBaseUrl(playbackId)}?width=640`,
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
      `${getMuxStoryboardBaseUrl(playbackId)}?width=800&asset_start_time=10.5&asset_end_time=42`,
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
});
