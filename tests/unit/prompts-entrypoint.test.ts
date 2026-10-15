import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  PromptOverrides,
  SceneContextItemV1,
} from "../../src/prompts/index";
import {
  createPromptBuilder,
  createSafetyReporter,
  detectSystemPromptLeak,
  renderSection,
} from "../../src/prompts/index";

describe("prompts entry point", () => {
  it("exports prompt construction utilities", () => {
    const builder = createPromptBuilder({
      template: {
        task: { tag: "task", content: "Analyze the scenes." },
      },
      sectionOrder: ["task"],
    });

    expect(builder.build()).toBe("<task>\nAnalyze the scenes.\n</task>");
    expect(renderSection({ tag: "context", content: "Scene context" }))
      .toBe("<context>\nScene context\n</context>");
  });

  it("exports output safety utilities", () => {
    const safety = createSafetyReporter();

    expect(detectSystemPromptLeak("A safe scene description.")).toBe(false);
    expect(safety.scrub("A safe scene description.", "scene[0]")).toBe("A safe scene description.");
    expect(safety.report()).toEqual({
      leaksDetected: false,
      scrubbedFields: [],
    });
  });

  it("exports the compact scene context contract", () => {
    expectTypeOf<SceneContextItemV1>().toMatchTypeOf<{
      scene_index: number;
      start_ms: number;
      end_ms: number;
      title: string;
      audible_narrative?: string;
      visual_narrative?: string;
      blended_narrative?: string;
      notable_audible_concepts?: string[];
      notable_visual_concepts?: string[];
      shot_count?: number;
    }>();
    expectTypeOf<PromptOverrides<"sceneContext">>().toEqualTypeOf<{
      sceneContext?: string | { tag: string; content: string; attributes?: Record<string, string> };
    }>();
  });
});
