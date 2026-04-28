import { describe, expect, it } from "vitest";

import { getModerationScores } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("moderation Integration Tests", () => {
  const safeAsset = muxTestAssets.assetId;
  const violentAsset = muxTestAssets.violentAssetId;
  const safeAudioOnlyAssetId = muxTestAssets.audioOnlyAssetId;
  const violentAudioOnlyAssetId = muxTestAssets.violentAudioOnlyAssetId;

  // Define reasonable thresholds for classification
  const VIOLENCE_THRESHOLD = 0.5;
  const SEXUAL_THRESHOLD = 0.5;

  describe("openAI provider", () => {
    it("should detect safe content (not violent, not sexual)", async () => {
      const result = await getModerationScores(safeAsset, {
        provider: "openai",
        model: "omni-moderation-latest",
      });

      // Assert that the result exists
      expect(result).toBeDefined();
      expect(result.assetId).toBe(safeAsset);

      // Check that at least 1 thumbnailScore did not error
      expect(result.thumbnailScores.filter(s => !s.error).length).toBeGreaterThan(0);

      // Verify structure
      expect(result).toHaveProperty("maxScores");
      expect(result).toHaveProperty("thumbnailScores");
      expect(result).toHaveProperty("exceedsThreshold");
      expect(result).toHaveProperty("thresholds");

      // Assert not violent and not sexual
      expect(result.maxScores.violence).toBeLessThan(VIOLENCE_THRESHOLD);
      expect(result.maxScores.sexual).toBeLessThan(SEXUAL_THRESHOLD);

      // Verify thumbnail scores exist
      expect(Array.isArray(result.thumbnailScores)).toBe(true);
      expect(result.thumbnailScores.length).toBeGreaterThan(0);
    });

    it("should detect violent content (violent but not sexual)", async () => {
      const result = await getModerationScores(violentAsset, {
        provider: "openai",
        model: "omni-moderation-latest",
      });

      // Assert that the result exists
      expect(result).toBeDefined();
      expect(result.assetId).toBe(violentAsset);

      // Verify structure
      expect(result).toHaveProperty("maxScores");
      expect(result).toHaveProperty("thumbnailScores");

      // Assert violent but not sexual
      expect(result.maxScores.violence).toBeGreaterThan(VIOLENCE_THRESHOLD);
      expect(result.maxScores.sexual).toBeLessThan(SEXUAL_THRESHOLD);

      // Verify thumbnail scores exist
      expect(Array.isArray(result.thumbnailScores)).toBe(true);
      expect(result.thumbnailScores.length).toBeGreaterThan(0);
    });
  });

  describe("hive provider", () => {
    it("should detect safe content (not violent, not sexual)", async () => {
      const result = await getModerationScores(safeAsset, {
        provider: "hive",
      });

      // Assert that the result exists
      expect(result).toBeDefined();
      expect(result.assetId).toBe(safeAsset);

      // Verify structure
      expect(result).toHaveProperty("maxScores");
      expect(result).toHaveProperty("thumbnailScores");
      expect(result).toHaveProperty("exceedsThreshold");
      expect(result).toHaveProperty("thresholds");

      // Assert not violent and not sexual
      expect(result.maxScores.violence).toBeLessThan(VIOLENCE_THRESHOLD);
      expect(result.maxScores.sexual).toBeLessThan(SEXUAL_THRESHOLD);

      // Verify thumbnail scores exist
      expect(Array.isArray(result.thumbnailScores)).toBe(true);
      expect(result.thumbnailScores.length).toBeGreaterThan(0);
    });

    it("should detect violent content (violent but not sexual)", async () => {
      const result = await getModerationScores(violentAsset, {
        provider: "hive",
      });

      // Assert that the result exists
      expect(result).toBeDefined();
      expect(result.assetId).toBe(violentAsset);

      // Verify structure
      expect(result).toHaveProperty("maxScores");
      expect(result).toHaveProperty("thumbnailScores");

      // Assert violent but not sexual
      expect(result.maxScores.violence).toBeGreaterThan(VIOLENCE_THRESHOLD);
      expect(result.maxScores.sexual).toBeLessThan(SEXUAL_THRESHOLD);

      // Verify thumbnail scores exist
      expect(Array.isArray(result.thumbnailScores)).toBe(true);
      expect(result.thumbnailScores.length).toBeGreaterThan(0);
    });
  });

  describe("google-vision-api provider", () => {
    it("should detect safe content (not violent, not sexual)", async () => {
      const result = await getModerationScores(safeAsset, {
        provider: "google-vision-api",
      });

      expect(result).toBeDefined();
      expect(result.assetId).toBe(safeAsset);

      expect(result).toHaveProperty("maxScores");
      expect(result).toHaveProperty("thumbnailScores");
      expect(result).toHaveProperty("exceedsThreshold");
      expect(result).toHaveProperty("thresholds");

      expect(result.maxScores.violence).toBeLessThan(VIOLENCE_THRESHOLD);
      expect(result.maxScores.sexual).toBeLessThan(SEXUAL_THRESHOLD);

      expect(Array.isArray(result.thumbnailScores)).toBe(true);
      expect(result.thumbnailScores.length).toBeGreaterThan(0);
    });

    it("should detect violent content (violent but not sexual)", async () => {
      const result = await getModerationScores(violentAsset, {
        provider: "google-vision-api",
      });

      expect(result).toBeDefined();
      expect(result.assetId).toBe(violentAsset);

      expect(result).toHaveProperty("maxScores");
      expect(result).toHaveProperty("thumbnailScores");

      expect(result.maxScores.violence).toBeGreaterThan(VIOLENCE_THRESHOLD);
      expect(result.maxScores.sexual).toBeLessThan(SEXUAL_THRESHOLD);

      expect(Array.isArray(result.thumbnailScores)).toBe(true);
      expect(result.thumbnailScores.length).toBeGreaterThan(0);
    });

    it("rejects audio-only assets with a clear message", async () => {
      await expect(
        getModerationScores(safeAudioOnlyAssetId, {
          provider: "google-vision-api",
        }),
      ).rejects.toThrow(/google-vision-api is image-only/);
    });
  });

  describe("audio-only assets (transcript moderation)", () => {
    it("should return a transcript-based moderation result for OpenAI", async () => {
      const result = await getModerationScores(safeAudioOnlyAssetId, {
        provider: "openai",
        model: "omni-moderation-latest",
      });

      expect(result).toBeDefined();
      expect(result.assetId).toBe(safeAudioOnlyAssetId);
      expect(result.mode).toBe("transcript");
      expect(result.isAudioOnly).toBe(true);

      expect(Array.isArray(result.thumbnailScores)).toBe(true);
      expect(result.thumbnailScores.length).toBeGreaterThan(0);
      expect(result.thumbnailScores.filter(s => !s.error).length).toBeGreaterThan(0);
      expect(result.thumbnailScores[0].url.startsWith("transcript:")).toBe(true);
      expect(typeof result.thumbnailScores[0].sexual).toBe("number");
      expect(typeof result.thumbnailScores[0].violence).toBe("number");
    });

    it("should detect violent audio-only content for OpenAI", async () => {
      const result = await getModerationScores(violentAudioOnlyAssetId, {
        provider: "openai",
        model: "omni-moderation-latest",
      });

      expect(result).toBeDefined();
      expect(result.assetId).toBe(violentAudioOnlyAssetId);
      expect(result.mode).toBe("transcript");
      expect(result.isAudioOnly).toBe(true);

      expect(Array.isArray(result.thumbnailScores)).toBe(true);
      expect(result.thumbnailScores.length).toBeGreaterThan(0);
      expect(result.thumbnailScores.filter(s => !s.error).length).toBeGreaterThan(0);
      expect(result.thumbnailScores[0].url.startsWith("transcript:")).toBe(true);

      // Assert violent content is detected
      expect(result.maxScores.violence).toBeGreaterThan(VIOLENCE_THRESHOLD);
    });
  });

  describe("maxSamples option", () => {
    it("should limit thumbnail count when maxSamples is set", async () => {
      const result = await getModerationScores(safeAsset, {
        provider: "openai",
        model: "omni-moderation-latest",
        maxSamples: 5,
      });

      expect(result).toBeDefined();
      expect(result.assetId).toBe(safeAsset);
      expect(result.thumbnailScores.length).toBe(5);

      // Verify structure is still correct
      expect(result).toHaveProperty("maxScores");
      expect(result).toHaveProperty("exceedsThreshold");
      expect(typeof result.maxScores.violence).toBe("number");
      expect(typeof result.maxScores.sexual).toBe("number");
    });

    it("should still detect violent content with reduced samples", async () => {
      const result = await getModerationScores(violentAsset, {
        provider: "openai",
        model: "omni-moderation-latest",
        maxSamples: 5,
      });

      expect(result).toBeDefined();
      expect(result.assetId).toBe(violentAsset);
      expect(result.thumbnailScores.length).toBe(5);

      // Should still detect violent content even with fewer samples
      expect(result.maxScores.violence).toBeGreaterThan(VIOLENCE_THRESHOLD);
      expect(result.maxScores.sexual).toBeLessThan(SEXUAL_THRESHOLD);
    });

    it("should work with very small maxSamples", async () => {
      const result = await getModerationScores(safeAsset, {
        provider: "openai",
        model: "omni-moderation-latest",
        maxSamples: 2,
      });

      expect(result).toBeDefined();
      expect(result.thumbnailScores.length).toBe(2);
      expect(result.thumbnailScores.filter(s => !s.error).length).toBeGreaterThan(0);

      // Verify scores are valid
      expect(result.maxScores.violence).toBeGreaterThanOrEqual(0);
      expect(result.maxScores.sexual).toBeGreaterThanOrEqual(0);
    });

    it("should work with maxSamples and hive provider", async () => {
      const result = await getModerationScores(safeAsset, {
        provider: "hive",
        maxSamples: 5,
      });

      expect(result).toBeDefined();
      expect(result.assetId).toBe(safeAsset);
      expect(result.thumbnailScores.length).toBe(5);

      // Verify moderation still works correctly
      expect(result.maxScores.violence).toBeLessThan(VIOLENCE_THRESHOLD);
      expect(result.maxScores.sexual).toBeLessThan(SEXUAL_THRESHOLD);
    });

    it("should not affect behavior when maxSamples is very large", async () => {
      const resultWithLargeMax = await getModerationScores(safeAsset, {
        provider: "openai",
        model: "omni-moderation-latest",
        maxSamples: 1000,
      });

      expect(resultWithLargeMax).toBeDefined();
      // A very large maxSamples should not cause the thumbnail count to explode
      // to the maxSamples value — the sampling plan's natural cadence should govern.
      expect(resultWithLargeMax.thumbnailScores.length).toBeLessThanOrEqual(1000);
      expect(resultWithLargeMax.thumbnailScores.length).toBeGreaterThan(0);
    });

    it("should cap thumbnails when interval produces more than maxSamples", async () => {
      const result = await getModerationScores(safeAsset, {
        provider: "openai",
        model: "omni-moderation-latest",
        thumbnailInterval: 5,
        maxSamples: 3,
      });

      expect(result).toBeDefined();
      // interval at 5s produces more than 3 thumbnails, so maxSamples caps the count
      expect(result.thumbnailScores.length).toBe(3);
    });

    it("should respect interval when it fits within maxSamples", async () => {
      const result = await getModerationScores(safeAsset, {
        provider: "openai",
        model: "omni-moderation-latest",
        thumbnailInterval: 10,
        maxSamples: 1000,
      });

      expect(result).toBeDefined();
      // interval at 10s produces far fewer than 1000 thumbnails, so interval is respected
      expect(result.thumbnailScores.length).toBeGreaterThan(0);
      expect(result.thumbnailScores.length).toBeLessThan(1000);
    });
  });
});
