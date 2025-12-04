import { describe, expect, it } from "vitest";

import type { SupportedProvider } from "../../src/lib/providers";
import { translateCaptions } from "../../src/workflows";

import "../../src/env";

describe("translateCaptions Integration Tests", () => {
  const testAssetId = "88Lb01qNUqFJrOFMITk00Ck201F00Qmcbpc5qgopNV4fCOk";
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)("should return valid result for %s provider", async (provider) => {
    const result = await translateCaptions(testAssetId, "en", "fr", {
      provider,
      uploadToMux: false,
    });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("assetId", testAssetId);
    expect(result).toHaveProperty("sourceLanguageCode", "en");
    expect(result).toHaveProperty("targetLanguageCode", "fr");
    expect(result).toHaveProperty("originalVtt");
    expect(result).toHaveProperty("translatedVtt");

    // Verify ISO 639-1 and ISO 639-3 language code pairs
    expect(result.sourceLanguage).toEqual({ iso639_1: "en", iso639_3: "eng" });
    expect(result.targetLanguage).toEqual({ iso639_1: "fr", iso639_3: "fra" });
  });
});
