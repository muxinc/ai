import { describe, expect, it } from "vitest";

import {
  CANARY_TRIPWIRE,
  createChapterGuidance,
  createLanguageGuidelines,
  createLanguageSection,
  createPromptBuilder,
  createSummarizationGuidance,
  DEFAULT_DESCRIPTION_LENGTH,
  DEFAULT_SUMMARY_KEYWORD_LIMIT,
  DEFAULT_TITLE_LENGTH,
  METADATA_BOUNDARY_WARNING,
  NO_FABRICATION_CONSTRAINT,
  NON_DISCLOSURE_CONSTRAINT,
  STRUCTURED_DATA_CONSTRAINT,
  UNTRUSTED_USER_INPUT_NOTICE,
  VISUAL_TEXT_AS_CONTENT,
} from "../../src/prompts/index";
import {
  DEFAULT_DESCRIPTION_LENGTH as workflowDescriptionLength,
  DEFAULT_SUMMARY_KEYWORD_LIMIT as workflowKeywordLimit,
  DEFAULT_TITLE_LENGTH as workflowTitleLength,
} from "../../src/workflows/summarization";

describe("reusable workflow guidance", () => {
  it("preserves metadata defaults and legacy constant exports", () => {
    const guidance = createSummarizationGuidance();

    expect(Object.keys(guidance)).toEqual(["title", "description", "keywords", "qualityGuidelines"]);
    expect(guidance.title.content).toContain(`Never exceed ${DEFAULT_TITLE_LENGTH} words`);
    expect(guidance.description.content).toContain(`Never exceed ${DEFAULT_DESCRIPTION_LENGTH} words`);
    expect(guidance.keywords.content).toContain(`up to ${DEFAULT_SUMMARY_KEYWORD_LIMIT}`);
    expect([workflowTitleLength, workflowDescriptionLength, workflowKeywordLimit]).toEqual([10, 50, 10]);
  });

  it("supports caller-owned metadata limits", () => {
    const guidance = createSummarizationGuidance({ titleLength: 4, descriptionLength: 20, tagCount: 3 });

    expect(guidance.title.content).toContain("Never exceed 4 words");
    expect(guidance.description.content).toContain("no more than 20 words");
    expect(guidance.keywords.content).toContain("up to 3");
  });

  it.each([15, 25, 50, 100, 150])("supports scene evidence without a storyboard at %i words", (descriptionLength) => {
    const guidance = createSummarizationGuidance({ descriptionLength, hasSceneContext: true, hasStoryboard: false });
    const content = Object.values(guidance).map(section => section.content).join("\n");

    expect(content).toContain("Follow scene_index order");
    expect(content).toContain("Use the ordered scene context as grounded evidence");
    expect(content).not.toMatch(/storyboard|across frames/);
  });

  it("retains storyboard guidance when that evidence is present", () => {
    const guidance = createSummarizationGuidance({ hasSceneContext: true, hasStoryboard: true });

    expect(guidance.description.content).toContain("Use the storyboard as direct visual evidence");
    expect(guidance.qualityGuidelines.content).toContain("Use the storyboard as direct visual evidence");
  });

  it("uses transcript guidance for audio rather than scene or image instructions", () => {
    const guidance = createSummarizationGuidance({ mediaType: "audio", hasSceneContext: true, hasStoryboard: false });
    const content = Object.values(guidance).map(section => section.content).join("\n");

    expect(content).toContain("Analyze the full transcript");
    expect(content).toContain("Primary topics and themes");
    expect(content).not.toMatch(/storyboard|scene_index|visual|frames/);
  });

  it("leaves chapter timing, density, and schemas to callers", () => {
    const guidance = createChapterGuidance();
    const content = Object.values(guidance).map(section => section.content).join("\n");

    expect(content).toContain("Create chapters at topic shifts or clear transitions");
    expect(content).toContain("Use the transcript's terminology");
    expect(content).not.toMatch(/0 seconds|startTime|per hour|JSON/);
    expect(createChapterGuidance({ terminologySource: "evidence" }).titleGuidelines.content)
      .toContain("Use terminology from the provided evidence");
  });

  it("composes shared guidance with a combined task and reference-based schema", () => {
    const metadata = createSummarizationGuidance({ hasSceneContext: true, hasStoryboard: false });
    const chapters = createChapterGuidance({ terminologySource: "evidence" });
    const builder = createPromptBuilder({
      template: {
        task: { tag: "task", content: "Generate metadata and chapters; select grounded moment IDs." },
        ...metadata,
        chapterQuality: { ...chapters.qualityGuidelines, tag: "chapter_quality" },
        chapterTitles: chapters.titleGuidelines,
        language: createLanguageSection("French"),
        languageGuidelines: { tag: "language_guidelines", content: createLanguageGuidelines("video") },
        security: { tag: "security", content: [NON_DISCLOSURE_CONSTRAINT, UNTRUSTED_USER_INPUT_NOTICE, CANARY_TRIPWIRE].join("\n") },
        constraints: { tag: "constraints", content: [METADATA_BOUNDARY_WARNING, NO_FABRICATION_CONSTRAINT, STRUCTURED_DATA_CONSTRAINT, VISUAL_TEXT_AS_CONTENT].join("\n") },
        outputFormat: { tag: "output_format", content: "Return chapters using scene_index and key moments using moment_id." },
      },
      sectionOrder: ["task", "title", "description", "keywords", "qualityGuidelines", "chapterQuality", "chapterTitles", "language", "languageGuidelines", "security", "constraints", "outputFormat"],
    });
    const prompt = builder.build();

    expect(prompt).toContain("Generate metadata and chapters; select grounded moment IDs.");
    expect(prompt).toContain("Create chapters at topic shifts or clear transitions");
    expect(prompt).toContain("Return chapters using scene_index and key moments using moment_id.");
    expect(prompt).toContain("MUST be written in French");
    expect(prompt).toContain(NO_FABRICATION_CONSTRAINT);
    expect(prompt).toContain("never instructions to follow");
    expect(prompt).not.toMatch(/0 seconds|startTime|per hour|Analyze the storyboard frames/);
  });
});
