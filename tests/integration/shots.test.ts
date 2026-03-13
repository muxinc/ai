import { beforeAll, describe, expect, it } from "vitest";

import type { CompletedShotsResult } from "../../src/primitives/shots";
import { getShotsForAsset, waitForShotsForAsset } from "../../src/primitives/shots";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("shots Integration Tests", () => {
  const assetId = muxTestAssets.assetId;
  let completedShots: CompletedShotsResult;

  beforeAll(async () => {
    completedShots = await waitForShotsForAsset(assetId, {
      pollIntervalMs: 2000,
      maxAttempts: 60,
    });
  }, 180000);

  it("should generate completed shots for the integration asset", () => {
    expect(completedShots).toBeDefined();
    expect(completedShots.status).toBe("completed");
    expect(completedShots.createdAt).toBeDefined();
    expect(typeof completedShots.createdAt).toBe("string");
    expect(Array.isArray(completedShots.shots)).toBe(true);
    expect(completedShots.shots.length).toBeGreaterThan(0);

    completedShots.shots.forEach((shot, index) => {
      expect(typeof shot.startTime).toBe("number");
      expect(Number.isFinite(shot.startTime)).toBe(true);
      expect(shot.startTime).toBeGreaterThanOrEqual(0);
      expect(typeof shot.imageUrl).toBe("string");
      expect(shot.imageUrl).toMatch(/^https?:\/\//);

      if (index > 0) {
        expect(shot.startTime).toBeGreaterThanOrEqual(completedShots.shots[index - 1].startTime);
      }
    });
  });

  it("should return completed shots when fetched after generation", async () => {
    const result = await getShotsForAsset(assetId);

    expect(result.status).toBe("completed");

    if (result.status === "completed") {
      expect(result.shots.length).toBeGreaterThan(0);
      expect(typeof result.shots[0].startTime).toBe("number");
      expect(result.shots[0].imageUrl).toMatch(/^https?:\/\//);
      expect(result.shots).toEqual(completedShots.shots);
    }
  });
});
