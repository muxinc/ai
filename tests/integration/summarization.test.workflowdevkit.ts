import { describe, expect, it } from "vitest";
import { start } from "workflow/api";

import type { SupportedProvider } from "../../src/lib/providers";
import { getSummaryAndTags } from "../../src/workflows";

import "../../src/env";

describe("summarization Integration Tests", () => {
  const testAssetId = "88Lb01qNUqFJrOFMITk00Ck201F00Qmcbpc5qgopNV4fCOk";
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)("should return valid result for %s provider", async (provider) => {
    const run = await start(getSummaryAndTags, [testAssetId, { provider }]);
    const result = await run.returnValue;

    expect(result).toBeDefined();
    expect(result).toHaveProperty("assetId", testAssetId);
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("description");
    expect(result).toHaveProperty("tags");
  });
});
