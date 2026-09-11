import { describe, expect, it } from "vitest";

import type { SupportedProvider } from "../../src/lib/providers";
import { generateText } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

describe("generateText Integration Tests", () => {
  const testAssetId = muxTestAssets.assetId;
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)("should write every variant × artifact for %s provider", async (provider) => {
    const result = await generateText(testAssetId, {
      provider,
      variants: [
        { key: "product_led", instructions: "Use a promotional, product-led angle." },
        { key: "insight_led" },
      ],
      artifacts: [
        { key: "x_post", kind: "short_form", channel: "x" },
        { key: "blog_post", kind: "long_form", maxLength: { unit: "words", value: 300 } },
      ],
      audience: "Video developers",
      voice: "conversational",
    });

    expect(result.assetId).toBe(testAssetId);
    expect(result.storyboardUrl).toBeDefined();
    expect(result.variants.map(variant => variant.key)).toEqual(["product_led", "insight_led"]);
    for (const variant of result.variants) {
      expect(variant.artifacts.map(artifact => artifact.key)).toEqual(["x_post", "blog_post"]);
      const [xPost, blogPost] = variant.artifacts;
      expect([...xPost.content].length).toBeGreaterThan(0);
      expect([...xPost.content].length).toBeLessThanOrEqual(280);
      expect(blogPost.content.trim().split(/\s+/u).length).toBeGreaterThan(0);
      expect(blogPost.content.trim().split(/\s+/u).length).toBeLessThanOrEqual(300);
    }
    expect(result.usage?.totalTokens).toBeGreaterThan(0);
    expect(result.safety?.leaksDetected).toBe(false);
  });

  it("should write from the transcript alone for audio-only assets", async () => {
    const result = await generateText(muxTestAssets.audioOnlyAssetId, {
      provider: "openai",
      artifacts: [{ key: "post", kind: "short_form", channel: "linkedin" }],
    });

    expect(result.storyboardUrl).toBeUndefined();
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0].key).toBe("default");
    expect(result.variants[0].artifacts[0].content.length).toBeGreaterThan(0);
  });

  it("should respect a scoped execution window", async () => {
    const result = await generateText(testAssetId, {
      provider: "openai",
      artifacts: [{ key: "post", kind: "short_form" }],
      scope: { startTime: 0, endTime: 60 },
    });

    expect(result.storyboardUrl).toContain("asset_end_time=60");
    expect(result.variants[0].artifacts[0].content.length).toBeGreaterThan(0);
  });

  it("should reject invalid options before contacting Mux", async () => {
    await expect(generateText(testAssetId, {
      provider: "openai",
      artifacts: [{ key: "x_post", kind: "short_form", channel: "x", maxLength: { unit: "characters", value: 500 } }],
    })).rejects.toThrow("supports at most 280 characters");
  });
});
