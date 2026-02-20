import { describe, expect, it } from "vitest";

import env from "../../src/env";
import { getSummaryAndTags } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("vercel AI Gateway Integration Tests", () => {
  const testAssetId = muxTestAssets.assetId;
  const hasGatewayApiKey = Boolean(env.AI_GATEWAY_API_KEY);

  it.skipIf(!hasGatewayApiKey)("should return valid result for vercel provider", async () => {
    const result = await getSummaryAndTags(testAssetId, {
      provider: "vercel",
      model: "openai/gpt-5-mini",
    });

    expect(result).toBeDefined();
    expect(result).toHaveProperty("assetId", testAssetId);
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("description");
    expect(result).toHaveProperty("tags");
  });
});
