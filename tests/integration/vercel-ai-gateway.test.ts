import { describe, expect, it } from "vitest";

import env from "../../src/env";
import { getSummaryAndTags } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

const hasVercelKey = Boolean(env.VERCEL_AI_GATEWAY_API_KEY);

describe.skipIf(!hasVercelKey)("vercel AI Gateway integration", () => {
  const testAssetId = muxTestAssets.assetId;

  it("should return valid summarization result via vercel gateway", async () => {
    const result = await getSummaryAndTags(testAssetId, {
      provider: "vercel",
      model: "openai/gpt-5.1",
    });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("assetId", testAssetId);
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("description");
    expect(result).toHaveProperty("tags");
    expect(result.tags).toBeInstanceOf(Array);
    expect(result.tags.length).toBeGreaterThan(0);
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
  });
});
