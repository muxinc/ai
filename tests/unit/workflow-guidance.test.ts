import { describe, expect, it } from "vitest";

import { createChapterGuidance, createSummarizationGuidance } from "../../src/prompts/index";

describe("reusable workflow guidance", () => {
  it("exports metadata guidance with the existing defaults", () => {
    const guidance = createSummarizationGuidance();

    expect(Object.keys(guidance)).toEqual(["title", "description", "keywords", "qualityGuidelines"]);
    expect(guidance.title.content).toContain("Never exceed 10 words");
    expect(guidance.description.content).toContain("Never exceed 50 words");
    expect(guidance.keywords.content).toContain("up to 10");
  });

  it("supports scene evidence without referring to a missing storyboard", () => {
    const guidance = createSummarizationGuidance({ hasSceneContext: true, hasStoryboard: false });
    const content = Object.values(guidance).map(section => section.content).join("\n");

    expect(content).toContain("Follow scene_index order");
    expect(content).toContain("Use the ordered scene context as grounded evidence");
    expect(content).not.toMatch(/storyboard|across frames/);
  });

  it("exports chapter guidance without workflow-specific timing rules", () => {
    const guidance = createChapterGuidance();
    const content = Object.values(guidance).map(section => section.content).join("\n");

    expect(content).toContain("Create chapters at topic shifts or clear transitions");
    expect(content).toContain("Use the transcript's terminology");
    expect(content).not.toMatch(/0 seconds|startTime|per hour|JSON/);
    expect(createChapterGuidance({ terminologySource: "evidence" }).titleGuidelines.content)
      .toContain("Use terminology from the provided evidence");
  });
});
