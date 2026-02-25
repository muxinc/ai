import { describe, expect, it } from "vitest";

import type { SupportedProvider } from "../../src/lib/providers";
import { generateHighlightClips } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("highlightClips Integration Tests", () => {
  const assetId = muxTestAssets.assetId;
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)(
    "should return valid result for %s provider in dry-run mode",
    { timeout: 60000 },
    async (provider) => {
      const result = await generateHighlightClips(assetId, {
        provider,
        dryRun: true, // Don't create actual assets in tests
        maxClips: 3,
      });

      expect(result).toBeDefined();
      expect(result).toHaveProperty("assetId", assetId);
      expect(result).toHaveProperty("clips");
      expect(result).toHaveProperty("totalClipsGenerated");
      expect(result).toHaveProperty("totalEngagementScore");
      expect(Array.isArray(result.clips)).toBe(true);

      // Verify clip structure if clips were generated
      if (result.clips.length > 0) {
        const clip = result.clips[0];
        expect(clip).toHaveProperty("startTime");
        expect(clip).toHaveProperty("endTime");
        expect(clip).toHaveProperty("duration");
        expect(clip).toHaveProperty("title");
        expect(clip).toHaveProperty("description");
        expect(clip).toHaveProperty("keywords");
        expect(clip).toHaveProperty("engagementScore");
        expect(clip).toHaveProperty("suggestedPlatforms");

        // Verify timing constraints
        expect(clip.endTime).toBeGreaterThan(clip.startTime);
        expect(clip.duration).toBe(clip.endTime - clip.startTime);
        expect(clip.duration).toBeGreaterThanOrEqual(15); // Default minClipDuration
        expect(clip.duration).toBeLessThanOrEqual(90); // Default maxClipDuration

        // Verify metadata
        expect(clip.title.length).toBeGreaterThan(0);
        expect(clip.title.length).toBeLessThanOrEqual(60);
        expect(clip.description.length).toBeGreaterThan(0);
        expect(Array.isArray(clip.keywords)).toBe(true);
        expect(clip.keywords.length).toBeGreaterThanOrEqual(3);
        expect(clip.keywords.length).toBeLessThanOrEqual(5);
        expect(Array.isArray(clip.suggestedPlatforms)).toBe(true);
        expect(clip.suggestedPlatforms.length).toBeGreaterThan(0);

        // In dry-run mode, these should not be present
        expect(clip.clipAssetId).toBeUndefined();
        expect(clip.clipPlaybackId).toBeUndefined();
      }
    },
  );

  it("should respect custom duration constraints", { timeout: 60000 }, async () => {
    const result = await generateHighlightClips(assetId, {
      provider: "openai",
      dryRun: true,
      maxClips: 2,
      minClipDuration: 20,
      maxClipDuration: 45,
    });

    if (result.clips.length > 0) {
      result.clips.forEach((clip) => {
        expect(clip.duration).toBeGreaterThanOrEqual(20);
        expect(clip.duration).toBeLessThanOrEqual(45);
      });
    }
  });

  it("should handle assets with no engagement hotspots", { timeout: 60000 }, async () => {
    // This might not have hotspots or might return empty
    const result = await generateHighlightClips(assetId, {
      provider: "openai",
      dryRun: true,
      maxClips: 1,
      timeframe: "[1:hour]", // Very short timeframe might have no data
    });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("assetId", assetId);
    expect(result).toHaveProperty("clips");
    expect(Array.isArray(result.clips)).toBe(true);
  });
});
