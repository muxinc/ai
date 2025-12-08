import { describe, expect, it } from "vitest";

import type { SupportedProvider } from "../../src/lib/providers";
import { getSummaryAndTags } from "../../src/workflows";

import "../../src/env";

describe("summarization Integration Tests", () => {
  const testAssetId = "X9F02RxSEEBbC02lXPzAeGgsi4Ypowr9ds";
  // const providers: SupportedProvider[] = ["openai", "anthropic", "google"];
  const providers: SupportedProvider[] = ["openai", "anthropic"];

  describe("running in-line", () => {
    it.each(providers)("should return valid result for %s provider", async (provider) => {
      const result = await getSummaryAndTags(testAssetId, { provider });

      expect(result).toBeDefined();
      expect(result).toHaveProperty("assetId", testAssetId);
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("description");
      expect(result).toHaveProperty("tags");
    });
  });

  describe("running in a workflow context", () => {
    it.each(providers)("should return valid result for %s provider", async (provider) => {
      const result = await getSummaryAndTags(testAssetId, { provider });

      expect(result).toBeDefined();
      expect(result).toHaveProperty("assetId", testAssetId);
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("description");
      expect(result).toHaveProperty("tags");
    });
  });
});
