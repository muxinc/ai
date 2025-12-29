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
});
