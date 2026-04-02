import { describe, expect, it } from "vitest";

import { generateScenes } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("scenes Integration Tests", () => {
  const assetId = muxTestAssets.chaptersAssetId;
  const languageCode = "en";

  it("should return valid scene boundaries for the test asset", async () => {
    const result = await generateScenes(assetId, languageCode, {
      provider: "openai",
    });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("assetId", assetId);
    expect(result).toHaveProperty("languageCode", languageCode);
    expect(Array.isArray(result.scenes)).toBe(true);
    expect(result.scenes.length).toBeGreaterThan(0);

    result.scenes.forEach((scene, index) => {
      expect(typeof scene.startTime).toBe("number");
      expect(typeof scene.endTime).toBe("number");
      expect(scene.endTime).toBeGreaterThan(scene.startTime);
      expect(typeof scene.title).toBe("string");
      expect(scene.title.length).toBeGreaterThan(0);

      if (index === 0) {
        expect(scene.startTime).toBe(0);
      }

      if (index > 0) {
        const previousScene = result.scenes[index - 1];
        expect(scene.startTime).toBeGreaterThanOrEqual(previousScene.startTime);
        expect(scene.startTime).toBe(previousScene.endTime);
      }
    });
  });
});
