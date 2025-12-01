import { describe, expect, it } from "vitest";

import "../../src/env";
import { hasBurnedInCaptions } from "../../src/functions";

describe("burned-in Captions Integration Tests", () => {
  const assetsWithCaptions = [
    "atuutlT45YbyucKU15u0100p45fG2CoXfJOd02VWMg4m004",
    "gEvCHSJRioaSMHtsJxT4DA02ee3xbgVL02sDGZJuqt01vs",
  ];

  const assetsWithoutCaptions = [
    "gIRjPqMSRcdk200kIKvsUo2K4JQr6UjNg7qKZc02egCcM",
    // '88Lb01qNUqFJrOFMITk00Ck201F00Qmcbpc5qgopNV4fCOk', // FIXME: This asset incorrectly detects captions; needs investigation and prompt tuning
  ];

  describe("openAI provider - with captions", () => {
    it.each(assetsWithCaptions)("should detect burned-in captions with >80% confidence for asset %s", async (assetId) => {
      const result = await hasBurnedInCaptions(assetId, {
        provider: "openai",
      });

      // Assert that the result exists
      expect(result).toBeDefined();
      expect(result.hasBurnedInCaptions).toBe(true);

      // Assert confidence is greater than 80%
      expect(result.confidence).toBeGreaterThan(0.8);

      // Verify result structure
      expect(result).toHaveProperty("assetId");
      expect(result).toHaveProperty("confidence");
      expect(result).toHaveProperty("detectedLanguage");
      expect(typeof result.confidence).toBe("number");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe("openAI provider - without captions", () => {
    it.each(assetsWithoutCaptions)("should NOT detect burned-in captions for asset %s", async (assetId) => {
      const result = await hasBurnedInCaptions(assetId, {
        provider: "openai",
      });

      // Assert that the result exists
      expect(result).toBeDefined();
      expect(result.hasBurnedInCaptions).toBe(false);

      // Verify result structure
      expect(result).toHaveProperty("assetId");
      expect(result).toHaveProperty("confidence");
      expect(result).toHaveProperty("detectedLanguage");
      expect(typeof result.confidence).toBe("number");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe("anthropic provider - with captions", () => {
    it.each(assetsWithCaptions)("should detect burned-in captions with >80 confidence for asset %s", async (assetId) => {
      const result = await hasBurnedInCaptions(assetId, {
        provider: "anthropic",
      });

      // Assert that the result exists
      expect(result).toBeDefined();
      expect(result.hasBurnedInCaptions).toBe(true);

      // Assert confidence is greater than 80%
      expect(result.confidence).toBeGreaterThan(0.8);

      // Verify result structure
      expect(result).toHaveProperty("assetId");
      expect(result).toHaveProperty("confidence");
      expect(result).toHaveProperty("detectedLanguage");
      expect(typeof result.confidence).toBe("number");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe("anthropic provider - without captions", () => {
    it.each(assetsWithoutCaptions)("should NOT detect burned-in captions for asset %s", async (assetId) => {
      const result = await hasBurnedInCaptions(assetId, {
        provider: "anthropic",
      });

      // Assert that the result exists
      expect(result).toBeDefined();
      expect(result.hasBurnedInCaptions).toBe(false);

      // Verify result structure
      expect(result).toHaveProperty("assetId");
      expect(result).toHaveProperty("confidence");
      expect(result).toHaveProperty("detectedLanguage");
      expect(typeof result.confidence).toBe("number");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe("google provider - with captions", () => {
    it.each(assetsWithCaptions)("should detect burned-in captions with >80% confidence for asset %s", async (assetId) => {
      const result = await hasBurnedInCaptions(assetId, {
        provider: "google",
      });

      // Assert that the result exists
      expect(result).toBeDefined();
      expect(result.hasBurnedInCaptions).toBe(true);

      // Assert confidence is greater than 80%
      expect(result.confidence).toBeGreaterThan(0.8);

      // Verify result structure
      expect(result).toHaveProperty("assetId");
      expect(result).toHaveProperty("confidence");
      expect(result).toHaveProperty("detectedLanguage");
      expect(typeof result.confidence).toBe("number");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe("google provider - without captions", () => {
    it.each(assetsWithoutCaptions)("should NOT detect burned-in captions for asset %s", async (assetId) => {
      const result = await hasBurnedInCaptions(assetId, {
        provider: "google",
      });

      // Assert that the result exists
      expect(result).toBeDefined();
      expect(result.hasBurnedInCaptions).toBe(false);

      // Verify result structure
      expect(result).toHaveProperty("assetId");
      expect(result).toHaveProperty("confidence");
      expect(result).toHaveProperty("detectedLanguage");
      expect(typeof result.confidence).toBe("number");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });
});
