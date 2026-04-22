import { beforeAll, describe, expect, it } from "vitest";

import { getPlaybackIdForAsset } from "../../src/lib/mux-assets";
import type { SupportedProvider } from "../../src/lib/providers";
import { getReadyTextTracks } from "../../src/primitives/transcripts";
import { translateCaptions } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("translateCaptions Integration Tests", () => {
  const testAssetId = muxTestAssets.assetId;
  // const providers: SupportedProvider[] = ["openai", "anthropic", "google"];
  const providers: SupportedProvider[] = ["openai", "google"]; // TODO: Add anthropic unit tests back

  let englishTrackId: string;

  beforeAll(async () => {
    const { asset } = await getPlaybackIdForAsset(testAssetId);
    const tracks = getReadyTextTracks(asset);
    const englishTrack = tracks.find(t => t.language_code === "en");
    if (!englishTrack?.id)
      throw new Error("Test asset missing English track");
    englishTrackId = englishTrack.id;
  });

  it.each(providers)("should return valid result for %s provider", async (provider) => {
    const result = await translateCaptions(testAssetId, englishTrackId, "fr", {
      provider,
      uploadToS3: false,
      uploadToMux: false,
    });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("assetId", testAssetId);
    expect(result).toHaveProperty("trackId", englishTrackId);
    expect(result).toHaveProperty("sourceLanguageCode", "en");
    expect(result).toHaveProperty("targetLanguageCode", "fr");
    expect(result).toHaveProperty("originalVtt");
    expect(result).toHaveProperty("translatedVtt");

    // Verify ISO 639-1 and ISO 639-3 language code pairs
    expect(result.sourceLanguage).toEqual({ iso639_1: "en", iso639_3: "eng" });
    expect(result.targetLanguage).toEqual({ iso639_1: "fr", iso639_3: "fra" });
  });
});
