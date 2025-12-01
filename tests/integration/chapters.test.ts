import { describe, expect, it } from "vitest";

import "../../src/env";
import { generateChapters } from "../../src/functions";

describe("chapters Integration Tests", () => {
  const assetId = "88Lb01qNUqFJrOFMITk00Ck201F00Qmcbpc5qgopNV4fCOk";
  const languageCode = "en";

  it("should generate chapters with OpenAI provider", async () => {
    const result = await generateChapters(assetId, languageCode, {
      provider: "openai",
    });

    // Assert that the result exists
    expect(result).toBeDefined();

    // Assert that chapters array exists
    expect(result.chapters).toBeDefined();
    expect(Array.isArray(result.chapters)).toBe(true);

    // Assert that at least one chapter was generated
    expect(result.chapters.length).toBeGreaterThan(0);

    // Verify chapter structure
    result.chapters.forEach((chapter) => {
      expect(chapter).toHaveProperty("startTime");
      expect(chapter).toHaveProperty("title");
      expect(typeof chapter.startTime).toBe("number");
      expect(typeof chapter.title).toBe("string");
    });
  });

  it("should generate chapters with Anthropic provider", async () => {
    const result = await generateChapters(assetId, languageCode, {
      provider: "anthropic",
    });

    // Assert that the result exists
    expect(result).toBeDefined();

    // Assert that chapters array exists
    expect(result.chapters).toBeDefined();
    expect(Array.isArray(result.chapters)).toBe(true);

    // Assert that at least one chapter was generated
    expect(result.chapters.length).toBeGreaterThan(0);

    // Verify chapter structure
    result.chapters.forEach((chapter) => {
      expect(chapter).toHaveProperty("startTime");
      expect(chapter).toHaveProperty("title");
      expect(typeof chapter.startTime).toBe("number");
      expect(typeof chapter.title).toBe("string");
    });
  });

  it("should generate chapters with Google provider", async () => {
    const result = await generateChapters(assetId, languageCode, {
      provider: "google",
    });

    // Assert that the result exists
    expect(result).toBeDefined();

    // Assert that chapters array exists
    expect(result.chapters).toBeDefined();
    expect(Array.isArray(result.chapters)).toBe(true);

    // Assert that at least one chapter was generated
    expect(result.chapters.length).toBeGreaterThan(0);

    // Verify chapter structure
    result.chapters.forEach((chapter) => {
      expect(chapter).toHaveProperty("startTime");
      expect(chapter).toHaveProperty("title");
      expect(typeof chapter.startTime).toBe("number");
      expect(typeof chapter.title).toBe("string");
    });
  });
});
