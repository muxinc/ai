import { describe, expect, it } from "vitest";

import type { SupportedProvider } from "../../src/lib/providers";
import type { ToneType } from "../../src/types";
import { getSummaryAndTags } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("summarization Integration Tests", () => {
  const testAssetId = muxTestAssets.assetId;
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)("should return valid result for %s provider", async (provider) => {
    const result = await getSummaryAndTags(testAssetId, { provider });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("assetId", testAssetId);
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("description");
    expect(result).toHaveProperty("tags");
  });

  it("should throw a useful error if tone is not valid", async () => {
    const provider = providers[0];

    await expect(
      getSummaryAndTags(testAssetId, { provider, tone: "blah" as ToneType }),
    ).rejects.toThrow("Invalid tone \"blah\". Valid tones are: neutral, playful, professional");
  });

  describe("audio-only assets", () => {
    const audioOnlyAssetId = "vakDEjEbE3J7mGOfRqAwYoLyw00CthM1Anx2300ECnkNU";

    it.each(providers)("should analyze audio-only asset with %s provider", async (provider) => {
      const result = await getSummaryAndTags(audioOnlyAssetId, { provider });

      expect(result).toBeDefined();
      expect(result).toHaveProperty("assetId", audioOnlyAssetId);
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("description");
      expect(result).toHaveProperty("tags");
      expect(result.tags).toBeInstanceOf(Array);
      expect(result.tags.length).toBeGreaterThan(0);
    });

    it("should return undefined storyboardUrl for audio-only asset", async () => {
      const provider = providers[0];
      const result = await getSummaryAndTags(audioOnlyAssetId, { provider });

      expect(result.storyboardUrl).toBeUndefined();
    });

    it("should include transcriptText when requested", async () => {
      const provider = providers[0];
      const result = await getSummaryAndTags(audioOnlyAssetId, {
        provider,
        includeTranscript: true,
      });

      expect(result.transcriptText).toBeDefined();
      expect(typeof result.transcriptText).toBe("string");
      expect(result.transcriptText!.length).toBeGreaterThan(0);
    });

    it("should throw error if includeTranscript is false for audio-only", async () => {
      const provider = providers[0];

      await expect(
        getSummaryAndTags(audioOnlyAssetId, {
          provider,
          includeTranscript: false,
        }),
      ).rejects.toThrow("Audio-only assets require transcripts for analysis");
    });

    it("should work with different tones for audio-only", async () => {
      const provider = providers[0];
      const tones: ToneType[] = ["neutral", "playful", "professional"];

      for (const tone of tones) {
        const result = await getSummaryAndTags(audioOnlyAssetId, {
          provider,
          tone,
        });

        expect(result).toBeDefined();
        expect(result.title).toBeDefined();
        expect(result.description).toBeDefined();
        expect(result.tags.length).toBeGreaterThan(0);
      }
    });

    it("should return usage statistics for audio-only", async () => {
      const provider = providers[0];
      const result = await getSummaryAndTags(audioOnlyAssetId, { provider });

      expect(result.usage).toBeDefined();
      expect(result.usage?.inputTokens).toBeGreaterThan(0);
      expect(result.usage?.outputTokens).toBeGreaterThan(0);
      expect(result.usage?.totalTokens).toBeGreaterThan(0);
    });
  });
});
