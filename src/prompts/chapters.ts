import dedent from "dedent";

import type { PromptTemplate } from "../lib/prompt-builder.ts";

export interface ChapterGuidanceOptions {
  terminologySource?: "transcript" | "evidence";
}

/** Chapter quality guidance; callers own chapter density, boundaries, and output format. */
export function createChapterGuidance({
  terminologySource = "transcript",
}: ChapterGuidanceOptions = {}): PromptTemplate<"qualityGuidelines" | "titleGuidelines"> {
  return {
    qualityGuidelines: {
      tag: "quality_guidelines",
      content: dedent`
        - Create chapters at topic shifts or clear transitions
        - Keep chapter titles concise and descriptive`,
    },
    titleGuidelines: {
      tag: "title_guidelines",
      content: dedent`
        - Keep titles concise and descriptive
        - Avoid filler or generic labels like "Chapter 1"
        ${terminologySource === "transcript" ? "- Use the transcript's terminology" : "- Use terminology from the provided evidence"}`,
    },
  };
}
