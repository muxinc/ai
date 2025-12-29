import { describe, expect, it } from "vitest";
import { start } from "workflow/api";

import type { SupportedProvider } from "../../src/lib/providers";
import { generateChapters } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("Chapters Integration Tests for Workflow DevKit", () => {
  const assetId = muxTestAssets.assetId;
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)("should generate chapters with %s provider", async (provider) => {
    const run = await start(generateChapters, [assetId, "en", { provider }]);
    expect(run.runId).toMatch(/^wrun_/);

    const result = await run.returnValue;

    // Assert that the result exists
    expect(result).toBeDefined();

    // Verify structure
    expect(result).toHaveProperty("assetId");
    expect(result).toHaveProperty("languageCode");
    expect(result).toHaveProperty("chapters");

    // Verify asset ID matches
    expect(result.assetId).toBe(assetId);

    // Verify language code
    expect(result.languageCode).toBe("en");

    // Verify chapters array
    expect(Array.isArray(result.chapters)).toBe(true);
    expect(result.chapters.length).toBeGreaterThan(0);

    // Verify first chapter starts at 0
    expect(result.chapters[0].startTime).toBe(0);

    // Verify chapter structure
    result.chapters.forEach((chapter) => {
      expect(typeof chapter.startTime).toBe("number");
      expect(typeof chapter.title).toBe("string");
      expect(chapter.title.length).toBeGreaterThan(0);
    });

    // Verify chapters are sorted by startTime
    for (let i = 1; i < result.chapters.length; i++) {
      expect(result.chapters[i].startTime).toBeGreaterThanOrEqual(result.chapters[i - 1].startTime);
    }
  }, 120000); // 2 minute timeout for AI processing
});
