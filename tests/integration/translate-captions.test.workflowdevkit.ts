import { describe, expect, it } from "vitest";
import { start } from "workflow/api";

import type { SupportedProvider } from "../../src/lib/providers";
import { translateCaptions } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("Caption Translation Integration Tests for Workflow DevKit", () => {
  const assetId = muxTestAssets.assetId;
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)("should translate captions to French with %s provider without uploading to Mux", async (provider) => {
    const run = await start(translateCaptions, [assetId, "en", "fr", {
      provider,
      uploadToMux: false,
    }]);
    expect(run.runId).toMatch(/^wrun_/);

    const result = await run.returnValue;

    // Assert that the result exists
    expect(result).toBeDefined();

    // Verify structure
    expect(result).toHaveProperty("assetId");
    expect(result).toHaveProperty("sourceLanguageCode");
    expect(result).toHaveProperty("targetLanguageCode");
    expect(result).toHaveProperty("sourceLanguage");
    expect(result).toHaveProperty("targetLanguage");
    expect(result).toHaveProperty("originalVtt");
    expect(result).toHaveProperty("translatedVtt");
    expect(result).toHaveProperty("usage");

    // Verify asset ID matches
    expect(result.assetId).toBe(assetId);

    // Verify language codes
    expect(result.sourceLanguageCode).toBe("en");
    expect(result.targetLanguageCode).toBe("fr");

    // Verify language pairs
    expect(result.sourceLanguage.iso639_1).toBe("en");
    expect(result.targetLanguage.iso639_1).toBe("fr");

    // Verify VTT content exists
    expect(typeof result.originalVtt).toBe("string");
    expect(result.originalVtt.length).toBeGreaterThan(0);
    expect(typeof result.translatedVtt).toBe("string");
    expect(result.translatedVtt.length).toBeGreaterThan(0);

    // Verify VTT format
    expect(result.translatedVtt).toContain("WEBVTT");

    // Verify usage stats
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.usage?.outputTokens).toBeGreaterThan(0);

    // Since uploadToMux is false, these should not be present
    expect(result.uploadedTrackId).toBeUndefined();
    expect(result.presignedUrl).toBeUndefined();
  }, 120000); // 2 minute timeout for AI processing
});
