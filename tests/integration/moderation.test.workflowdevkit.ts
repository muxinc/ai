import { describe, expect, it } from "vitest";
import { start } from "workflow/api";

import type { ModerationProvider } from "../../src/workflows";
import { getModerationScores } from "../../src/workflows";

describe("Moderation Integration Tests for Workflow DevKit", () => {
  const assetId = "88Lb01qNUqFJrOFMITk00Ck201F00Qmcbpc5qgopNV4fCOk";
  const providers: ModerationProvider[] = ["openai"];

  it.each(providers)("should get moderation scores with %s provider", async (provider) => {
    const run = await start(getModerationScores, [assetId, {
      provider,
      thumbnailInterval: 30, // Use larger interval for faster test
    }]);
    expect(run.runId).toMatch(/^wrun_/);

    const result = await run.returnValue;

    // Assert that the result exists
    expect(result).toBeDefined();

    // Check that at least 1 thumbnailScore did not error
    expect(result.thumbnailScores.filter(s => !s.error).length).toBeGreaterThan(0);

    // Verify structure
    expect(result).toHaveProperty("assetId");
    expect(result).toHaveProperty("thumbnailScores");
    expect(result).toHaveProperty("maxScores");
    expect(result).toHaveProperty("exceedsThreshold");
    expect(result).toHaveProperty("thresholds");

    // Verify asset ID matches
    expect(result.assetId).toBe(assetId);

    // Verify thumbnailScores array
    expect(Array.isArray(result.thumbnailScores)).toBe(true);
    expect(result.thumbnailScores.length).toBeGreaterThan(0);

    // Verify thumbnail score structure
    result.thumbnailScores.forEach((score) => {
      expect(score).toHaveProperty("url");
      expect(score).toHaveProperty("sexual");
      expect(score).toHaveProperty("violence");
      expect(score).toHaveProperty("error");
      expect(typeof score.sexual).toBe("number");
      expect(typeof score.violence).toBe("number");
      expect(typeof score.error).toBe("boolean");
    });

    // Verify maxScores
    expect(result.maxScores).toHaveProperty("sexual");
    expect(result.maxScores).toHaveProperty("violence");
    expect(typeof result.maxScores.sexual).toBe("number");
    expect(typeof result.maxScores.violence).toBe("number");

    // Verify exceedsThreshold is a boolean
    expect(typeof result.exceedsThreshold).toBe("boolean");

    // Verify thresholds
    expect(result.thresholds).toHaveProperty("sexual");
    expect(result.thresholds).toHaveProperty("violence");
  }, 120000); // 2 minute timeout for moderation processing
});
