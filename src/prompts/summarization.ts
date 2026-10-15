import dedent from "dedent";

import type { PromptTemplate } from "../lib/prompt-builder.ts";

export const DEFAULT_SUMMARY_KEYWORD_LIMIT = 10;
export const DEFAULT_TITLE_LENGTH = 10;
export const DEFAULT_DESCRIPTION_LENGTH = 50;

export type SummarizationGuidanceSections = "title" | "description" | "keywords" | "qualityGuidelines";

export interface SummarizationGuidanceOptions {
  mediaType?: "video" | "audio";
  titleLength?: number;
  descriptionLength?: number;
  tagCount?: number;
  hasSceneContext?: boolean;
  /** Whether a storyboard accompanies scene context. Defaults to true. */
  hasStoryboard?: boolean;
}

const DESCRIPTION_LENGTH_THRESHOLD_SMALL = 25;
const DESCRIPTION_LENGTH_THRESHOLD_LARGE = 100;

function buildDescriptionGuidance(wordCount: number, contentType: "video" | "audio"): string {
  if (wordCount < DESCRIPTION_LENGTH_THRESHOLD_SMALL) {
    if (contentType === "video") {
      return dedent`A brief summary of the video in no more than ${wordCount} words. Shorter is fine.
        Focus on the single most important subject or action.
        Write in present tense.`;
    }
    return dedent`A brief summary of the audio content in no more than ${wordCount} words. Shorter is fine.
      Focus on the single most important topic or theme.
      Write in present tense.`;
  }

  if (wordCount > DESCRIPTION_LENGTH_THRESHOLD_LARGE) {
    if (contentType === "video") {
      return dedent`A detailed summary that describes what happens across the video.
        Never exceed ${wordCount} words, but shorter is perfectly fine. You may use multiple sentences.
        Be thorough: cover subjects, actions, setting, progression, and any notable details visible across frames.
        Write in present tense. Be specific about observable details rather than making assumptions.
        If the transcript provides dialogue or narration, incorporate key points but prioritize visual content.`;
    }
    return dedent`A detailed summary that describes the audio content.
      Never exceed ${wordCount} words, but shorter is perfectly fine. You may use multiple sentences.
      Be thorough: cover topics, speakers, themes, progression, and any notable insights.
      Write in present tense. Be specific about what is discussed or presented rather than making assumptions.
      Focus on the spoken content and any key insights, dialogue, or narrative elements.`;
  }

  if (contentType === "video") {
    return dedent`A summary that describes what happens across the video.
      Never exceed ${wordCount} words, but shorter is perfectly fine. You may use multiple sentences.
      Cover the main subjects, actions, setting, and any notable progression visible across frames.
      Write in present tense. Be specific about observable details rather than making assumptions.
      If the transcript provides dialogue or narration, incorporate key points but prioritize visual content.`;
  }
  return dedent`A summary that describes the audio content.
    Never exceed ${wordCount} words, but shorter is perfectly fine. You may use multiple sentences.
    Cover the main topics, speakers, themes, and any notable progression in the discussion or narration.
    Write in present tense. Be specific about what is discussed or presented rather than making assumptions.
    Focus on the spoken content and any key insights, dialogue, or narrative elements.`;
}

function buildSceneAwareDescriptionGuidance(wordCount: number, hasStoryboard: boolean): string {
  const storyboardGuidance = hasStoryboard ?
    "Use the storyboard as direct visual evidence and the scene context to preserve progression." :
    "Use the ordered scene context as grounded evidence of the content and its progression.";
  if (wordCount < DESCRIPTION_LENGTH_THRESHOLD_SMALL) {
    return dedent`A brief summary of the video in no more than ${wordCount} words. Shorter is fine.
      Focus on the single most important subject or action across the ordered scenes.
      ${storyboardGuidance}
      Write in present tense.`;
  }

  if (wordCount > DESCRIPTION_LENGTH_THRESHOLD_LARGE) {
    return dedent`A detailed summary that describes what happens across the ordered scenes.
      Never exceed ${wordCount} words, but shorter is perfectly fine. You may use multiple sentences.
      Be thorough: cover subjects, actions, setting, progression, and notable details supported across scenes.
      ${storyboardGuidance}
      Write in present tense. If the transcript provides dialogue or narration, incorporate key points while preserving scene progression.`;
  }

  return dedent`A summary that describes what happens across the ordered scenes.
    Never exceed ${wordCount} words, but shorter is perfectly fine. You may use multiple sentences.
    Cover the main subjects, actions, setting, and notable progression supported across scenes.
    ${storyboardGuidance}
    Write in present tense. If the transcript provides dialogue or narration, incorporate key points while preserving scene progression.`;
}

/** Metadata guidance without a workflow task, output schema, or evidence fetching. */
export function createSummarizationGuidance({
  mediaType = "video",
  titleLength,
  descriptionLength,
  tagCount,
  hasSceneContext = false,
  hasStoryboard = true,
}: SummarizationGuidanceOptions = {}): PromptTemplate<SummarizationGuidanceSections> {
  const titleLimit = titleLength ?? DEFAULT_TITLE_LENGTH;
  const descriptionLimit = descriptionLength ?? DEFAULT_DESCRIPTION_LENGTH;
  const keywordLimit = tagCount ?? DEFAULT_SUMMARY_KEYWORD_LIMIT;
  const isAudioOnly = mediaType === "audio";
  const sceneAware = !isAudioOnly && hasSceneContext;
  const qualityGuidelines = isAudioOnly ?
    dedent`
      - Analyze the full transcript to understand context and themes
      - Be precise: use specific terminology when mentioned
      - Capture the narrative: what is introduced, discussed, and concluded
      - Balance brevity with informativeness` :
    sceneAware ?
      dedent`
        - Follow scene_index order to understand what begins, develops, and concludes
        - Use scene narratives and concepts as grounded evidence, preserving consistent terminology across the output
        ${hasStoryboard ? "- Use the storyboard as direct visual evidence for whole-asset details" : "- Ground whole-asset details in the provided scene context and transcript when available"}
        - Balance brevity with informativeness` :
      dedent`
        - Examine all frames to understand the full context and progression
        - Be precise: "golden retriever" is better than "dog" when identifiable
        - Capture the narrative: what begins, develops, and concludes
        - Balance brevity with informativeness`;

  return {
    title: {
      tag: "title_requirements",
      content: isAudioOnly ?
        dedent`
          A concise, label-style title — not a sentence or description.
          Never exceed ${titleLimit} words, but shorter is better.
          Think of how a podcast episode title or playlist entry would read — e.g. "Weekly News Roundup" or "Interview with Dr. Smith".
          Start with the primary subject or topic. Never begin with "An audio of" or similar phrasing.
          Use specific nouns over lengthy descriptions. Avoid clauses, conjunctions, or narrative structure.` :
        dedent`
          A concise, label-style title — not a sentence or description.
          Never exceed ${titleLimit} words, but shorter is better.
          Think of how a video card title, playlist entry, or file name would read — e.g. "Predator: Badlands Trailer" or "Chef Prepares Holiday Feast".
          Start with the primary subject or topic. Never begin with "A video of" or similar phrasing.
          Use specific nouns over lengthy descriptions. Avoid clauses, conjunctions, or narrative structure.`,
    },
    description: {
      tag: "description_requirements",
      content: sceneAware ?
          buildSceneAwareDescriptionGuidance(descriptionLimit, hasStoryboard) :
          buildDescriptionGuidance(descriptionLimit, mediaType),
    },
    keywords: {
      tag: "keywords_requirements",
      content: isAudioOnly ?
        dedent`
          Specific, searchable terms (up to ${keywordLimit}) that capture:
          - Primary topics and themes
          - Speakers or presenters (if named)
          - Key concepts and terminology
          - Content type (interview, lecture, music, etc.)
          - Genre or style (if applicable)
          Prefer concrete nouns and relevant terms over abstract concepts.
          Use lowercase. Avoid redundant or overly generic terms like "audio" or "content".` :
        dedent`
          Specific, searchable terms (up to ${keywordLimit}) that capture:
          - Primary subjects (people, animals, objects)
          - Actions and activities being performed
          - Setting and environment
          - Notable objects or tools
          - Style or genre (if applicable)
          Prefer concrete nouns and action verbs over abstract concepts.
          Use lowercase. Avoid redundant or overly generic terms like "video" or "content".`,
    },
    qualityGuidelines: { tag: "quality_guidelines", content: qualityGuidelines },
  };
}
