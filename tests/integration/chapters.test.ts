import { describe, expect, it } from "vitest";

import type { SupportedProvider } from "../../src/lib/providers";
import { generateChapters } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("chapters Integration Tests", () => {
  const assetId = muxTestAssets.assetId;
  const languageCode = "en";
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)("should return valid result for %s provider", async (provider) => {
    const result = await generateChapters(assetId, languageCode, { provider });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("assetId", assetId);
    expect(result).toHaveProperty("languageCode", languageCode);
    expect(result).toHaveProperty("chapters");
    expect(Array.isArray(result.chapters)).toBe(true);
  });
});
