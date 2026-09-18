import { describe, expect, it } from "vitest";
import { start } from "workflow/api";

import type { SupportedProvider } from "../../src/lib/providers";
import { generateText } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("generateText Integration Tests for Workflow DevKit", () => {
  const assetId = muxTestAssets.assetId;
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)("should return a run with a runId for %s provider", async (provider) => {
    const run = await start(generateText, [assetId, {
      provider,
      artifacts: [
        { key: "x_post", kind: "short_form", channel: "x" },
        { key: "summary", kind: "long_form", maxLength: { unit: "words", value: 200 } },
      ],
    }]);
    expect(run.runId).toMatch(/^wrun_/);

    const result = await run.returnValue;
    expect(result.assetId).toBe(assetId);
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0].artifacts.map(artifact => artifact.key)).toEqual(["x_post", "summary"]);
    for (const artifact of result.variants[0].artifacts) {
      expect(artifact.content.length).toBeGreaterThan(0);
    }
  }, 180000);
});
