import { describe, expect, it } from "vitest";
import { start } from "workflow/api";

import type { SupportedProvider } from "../../src/lib/providers";
import { hasBurnedInCaptions } from "../../src/workflows";

describe("Burned-in Captions Integration Tests for Workflow DevKit", () => {
  const assetId = "88Lb01qNUqFJrOFMITk00Ck201F00Qmcbpc5qgopNV4fCOk";
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)("should detect burned-in captions with %s provider", async (provider) => {
    const run = await start(hasBurnedInCaptions, [assetId, { provider }]);
    expect(run.runId).toMatch(/^wrun_/);

    const result = await run.returnValue;

    // Assert that the result exists
    expect(result).toBeDefined();

    // Verify structure
    expect(result).toHaveProperty("assetId");
    expect(result).toHaveProperty("hasBurnedInCaptions");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("detectedLanguage");
    expect(result).toHaveProperty("storyboardUrl");
    expect(result).toHaveProperty("usage");

    // Verify asset ID matches
    expect(result.assetId).toBe(assetId);

    // Verify hasBurnedInCaptions is a boolean
    expect(typeof result.hasBurnedInCaptions).toBe("boolean");

    // Verify confidence is a number between 0 and 1
    expect(typeof result.confidence).toBe("number");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);

    // Verify detectedLanguage is null or a string
    expect(result.detectedLanguage === null || typeof result.detectedLanguage === "string").toBe(true);

    // Verify storyboardUrl is a valid URL
    expect(typeof result.storyboardUrl).toBe("string");
    expect(result.storyboardUrl).toContain("image.mux.com");

    // Verify usage stats
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
  }, 120000); // 2 minute timeout for AI processing
});
