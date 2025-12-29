import { describe, expect, it } from "vitest";
import { start } from "workflow/api";

import type { SupportedProvider } from "../../src/lib/providers";
import { getSummaryAndTags } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("summarization Integration Tests", () => {
  const testAssetId = muxTestAssets.assetId;
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)("should return a run with a runId for each provider", async (provider) => {
    const run = await start(getSummaryAndTags, [testAssetId, { provider }]);
    expect(run.runId).toMatch(/^wrun_/);

    const result = await run.returnValue;
    expect(result).toHaveProperty("assetId", testAssetId);
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("description");
    expect(result).toHaveProperty("tags");
  });
});
