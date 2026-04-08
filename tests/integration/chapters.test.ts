import { describe, expect, it } from "vitest";

import type { SupportedProvider } from "../../src/lib/providers";
import { generateChapters } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("chapters Integration Tests", () => {
  const assetId = muxTestAssets.assetId;
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)("should return valid result for %s provider", async (provider) => {
    const result = await generateChapters(assetId, { provider });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("assetId", assetId);
    expect(result).toHaveProperty("languageCode", "en");
    expect(result).toHaveProperty("chapters");
    expect(Array.isArray(result.chapters)).toBe(true);
  });

  describe("language parameter", () => {
    it("should accept an explicit language code for chapter titles", async () => {
      const result = await generateChapters(assetId, {
        provider: "openai",
        languageCode: "en",
        outputLanguageCode: "es",
      });

      expect(result).toBeDefined();
      expect(result.chapters.length).toBeGreaterThan(0);
      expect(result.chapters[0].title).toBeDefined();
    });

    it("should accept outputLanguageCode: 'auto' without error", async () => {
      const result = await generateChapters(assetId, {
        provider: "openai",
        languageCode: "en",
        outputLanguageCode: "auto",
      });

      expect(result).toBeDefined();
      expect(result.chapters.length).toBeGreaterThan(0);
    });
  });
});
