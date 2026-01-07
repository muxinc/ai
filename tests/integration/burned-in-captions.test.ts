import { describe, expect, it } from "vitest";

import type { SupportedProvider } from "../../src/lib/providers";
import { hasBurnedInCaptions } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("burned-in Captions Integration Tests", () => {
  const testAssetId = muxTestAssets.burnedInCaptionsAssetId;
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)("should return valid result for %s provider", async (provider) => {
    const result = await hasBurnedInCaptions(testAssetId, { provider });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("assetId", testAssetId);
    expect(result).toHaveProperty("hasBurnedInCaptions");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("detectedLanguage");
  });
});
