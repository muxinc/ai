import { describe, expect, it } from "vitest";

import type { SupportedProvider } from "../../src/lib/providers";
import { hasBurnedInCaptions } from "../../src/workflows";

import "../../src/env";

describe("burned-in Captions Integration Tests", () => {
  const testAssetId = "atuutlT45YbyucKU15u0100p45fG2CoXfJOd02VWMg4m004";
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
