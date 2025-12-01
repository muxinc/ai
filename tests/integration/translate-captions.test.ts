import { describe, expect, it } from "vitest";

import "../../src/env";
import { translateCaptions } from "../../src/functions";

describe("captions Translation Integration Tests", () => {
  const assetId = "88Lb01qNUqFJrOFMITk00Ck201F00Qmcbpc5qgopNV4fCOk";

  it("should translate captions from English to French without uploading to Mux", async () => {
    const result = await translateCaptions(assetId, "en", "fr", {
      provider: "anthropic",
      uploadToMux: false,
    });

    // Assert that the result exists
    expect(result).toBeDefined();

    // Verify structure
    expect(result).toHaveProperty("assetId");
    expect(result).toHaveProperty("sourceLanguageCode");
    expect(result).toHaveProperty("targetLanguageCode");
    expect(result).toHaveProperty("originalVtt");
    expect(result).toHaveProperty("translatedVtt");

    // Verify asset ID matches
    expect(result.assetId).toBe(assetId);

    // Verify language codes
    expect(result.sourceLanguageCode).toBe("en");
    expect(result.targetLanguageCode).toBe("fr");

    // Verify original VTT exists and has content
    expect(typeof result.originalVtt).toBe("string");
    expect(result.originalVtt.length).toBeGreaterThan(0);
    expect(result.originalVtt).toContain("WEBVTT");

    // Verify translated VTT exists and has content
    expect(typeof result.translatedVtt).toBe("string");
    expect(result.translatedVtt.length).toBeGreaterThan(0);
    expect(result.translatedVtt).toContain("WEBVTT");

    // Verify the translation is different from the original
    expect(result.translatedVtt).not.toBe(result.originalVtt);

    // Since uploadToMux is false, these should not be present
    expect(result.uploadedTrackId).toBeUndefined();
    expect(result.presignedUrl).toBeUndefined();
  });

  it("should translate captions from English to French with Google provider without uploading to Mux", async () => {
    const result = await translateCaptions(assetId, "en", "fr", {
      provider: "google",
      uploadToMux: false,
    });

    // Assert that the result exists
    expect(result).toBeDefined();

    // Verify structure
    expect(result).toHaveProperty("assetId");
    expect(result).toHaveProperty("sourceLanguageCode");
    expect(result).toHaveProperty("targetLanguageCode");
    expect(result).toHaveProperty("originalVtt");
    expect(result).toHaveProperty("translatedVtt");

    // Verify asset ID matches
    expect(result.assetId).toBe(assetId);

    // Verify language codes
    expect(result.sourceLanguageCode).toBe("en");
    expect(result.targetLanguageCode).toBe("fr");

    // Verify original VTT exists and has content
    expect(typeof result.originalVtt).toBe("string");
    expect(result.originalVtt.length).toBeGreaterThan(0);
    expect(result.originalVtt).toContain("WEBVTT");

    // Verify translated VTT exists and has content
    expect(typeof result.translatedVtt).toBe("string");
    expect(result.translatedVtt.length).toBeGreaterThan(0);
    expect(result.translatedVtt).toContain("WEBVTT");

    // Verify the translation is different from the original
    expect(result.translatedVtt).not.toBe(result.originalVtt);

    // Since uploadToMux is false, these should not be present
    expect(result.uploadedTrackId).toBeUndefined();
    expect(result.presignedUrl).toBeUndefined();
  });
});
