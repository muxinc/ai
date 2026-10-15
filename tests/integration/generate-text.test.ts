import { describe, expect, it } from "vitest";

import type { SupportedProvider } from "../../src/lib/providers";
import { generateText, measureGenerateTextLength } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

const MARKDOWN_SYNTAX = /^\s{0,3}#{1,6}\s|\*\*|__|^\s*[-*+]\s|^\s*\d+\.\s|\[[^\]]+\]\([^)]+\)|`/m;
const MARKDOWN_HEADING = /^\s{0,3}#{1,6}\s\S/m;
const RECAP_FRAMING = /\b(?:this|the) (?:video|transcript|recording|clip|podcast|episode|speaker|host|presenter) (?:explains|discusses|covers|shows|walks|talks|dives|explores|highlights|demonstrates|describes|goes)\b|\bthe (?:speaker|presenter|narrator)\b|\bin (?:this|today's) (?:video|episode|transcript|recording|content)\b|\bwe(?:'ll| will) (?:explore|discuss|cover)\b/i;

function artifactContent(result: Awaited<ReturnType<typeof generateText>>, variantKey: string, artifactKey: string): string {
  const variant = result.variants.find(entry => entry.key === variantKey);
  const artifact = variant?.artifacts.find(entry => entry.key === artifactKey);
  if (!artifact) {
    throw new Error(`Missing ${variantKey}.${artifactKey}`);
  }
  return artifact.content;
}

function countWordsFrom(text: string, words: readonly string[]): number {
  const vocabulary = new Set(words);
  return (text.toLowerCase().match(/\p{L}+/gu) ?? []).filter(word => vocabulary.has(word)).length;
}

describe("generateText Integration Tests", () => {
  const testAssetId = muxTestAssets.assetId;
  const providers: SupportedProvider[] = ["openai", "anthropic", "google"];

  it.each(providers)("honours channel, format, length, and non-recap rules for %s provider", async (provider) => {
    const result = await generateText(testAssetId, {
      provider,
      variants: [
        { key: "product_led", instructions: "Use a promotional, product-led angle." },
        { key: "insight_led", instructions: "Use an educational, insight-led angle." },
      ],
      artifacts: [
        { key: "x_post", channel: "x" },
        { key: "linkedin_post", channel: "linkedin", maxLength: { unit: "words", value: 120 } },
        {
          key: "blog_post",
          maxLength: { unit: "words", value: 300 },
          format: "markdown",
          instructions: "Use at least two section headings.",
        },
      ],
      audience: "Video developers",
      voice: "conversational",
    });

    expect(result.assetId).toBe(testAssetId);
    expect(result.storyboardUrl).toBeDefined();
    expect(result.variants.map(variant => variant.key)).toEqual(["product_led", "insight_led"]);

    for (const variant of result.variants) {
      expect(variant.artifacts.map(artifact => artifact.key)).toEqual(["x_post", "linkedin_post", "blog_post"]);

      const xPost = artifactContent(result, variant.key, "x_post");
      expect(xPost.length).toBeGreaterThan(0);
      expect(measureGenerateTextLength(xPost, "characters")).toBeLessThanOrEqual(280);
      expect(xPost).not.toMatch(MARKDOWN_SYNTAX);

      const linkedinPost = artifactContent(result, variant.key, "linkedin_post");
      expect(measureGenerateTextLength(linkedinPost, "words")).toBeLessThanOrEqual(120);
      expect(linkedinPost).not.toMatch(MARKDOWN_SYNTAX);

      const blogPost = artifactContent(result, variant.key, "blog_post");
      expect(measureGenerateTextLength(blogPost, "words")).toBeLessThanOrEqual(300);
      expect(blogPost).toMatch(MARKDOWN_HEADING);

      for (const content of [xPost, linkedinPost, blogPost]) {
        expect(content).not.toMatch(RECAP_FRAMING);
      }
    }

    expect(artifactContent(result, "product_led", "x_post")).not.toBe(artifactContent(result, "insight_led", "x_post"));
    expect(result.usage?.totalTokens).toBeGreaterThan(0);
    expect(result.safety?.leaksDetected).toBe(false);
  });

  it("writes in the requested output language", async () => {
    const result = await generateText(testAssetId, {
      provider: "openai",
      artifacts: [{ key: "post", channel: "linkedin", maxLength: { unit: "words", value: 120 } }],
      outputLanguageCode: "es",
    });

    const content = artifactContent(result, "default", "post");
    const spanish = countWordsFrom(content, ["el", "la", "los", "las", "de", "que", "y", "para", "con", "una", "es", "en"]);
    const english = countWordsFrom(content, ["the", "and", "of", "to", "is", "for", "with", "that", "this", "are"]);
    expect(spanish).toBeGreaterThan(english);
  });

  it("writes from the transcript alone for audio-only assets", async () => {
    const result = await generateText(muxTestAssets.audioOnlyAssetId, {
      provider: "openai",
      artifacts: [{ key: "post", channel: "linkedin" }],
    });

    expect(result.storyboardUrl).toBeUndefined();
    expect(result.usage?.metadata?.thumbnailCount).toBe(0);
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0].key).toBe("default");

    const content = artifactContent(result, "default", "post");
    expect(content.length).toBeGreaterThan(0);
    expect(measureGenerateTextLength(content, "words")).toBeLessThanOrEqual(300);
    expect(content).not.toMatch(RECAP_FRAMING);
  });

  it("scopes the storyboard to the requested window", async () => {
    const result = await generateText(testAssetId, {
      provider: "openai",
      artifacts: [{ key: "post", maxLength: { unit: "words", value: 80 } }],
      scope: { startTime: 0, endTime: 20 },
    });

    expect(result.storyboardUrl).toContain("asset_end_time=20");
    const content = artifactContent(result, "default", "post");
    expect(content.length).toBeGreaterThan(0);
    expect(measureGenerateTextLength(content, "words")).toBeLessThanOrEqual(80);
  });

  it("rejects invalid options before contacting Mux", async () => {
    await expect(generateText(testAssetId, {
      provider: "openai",
      artifacts: [{ key: "x_post", channel: "x", maxLength: { unit: "characters", value: 500 } }],
    })).rejects.toThrow("supports at most 280 characters");
  });
});
