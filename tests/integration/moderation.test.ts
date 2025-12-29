import { describe, expect, it } from "vitest";

import { getModerationScores } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("moderation Integration Tests", () => {
  const safeAsset = muxTestAssets.assetId;
  const violentAsset = muxTestAssets.violentAssetId;
  const safeAudioOnlyAssetId = muxTestAssets.audioOnlyAssetId;

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
  });
});
