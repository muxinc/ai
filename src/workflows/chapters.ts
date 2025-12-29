import { generateObject } from "ai";
import dedent from "dedent";
import { z } from "zod";

import { getPlaybackIdForAsset, isAudioOnlyAsset } from "@mux/ai/lib/mux-assets";
import type { PromptOverrides, PromptSection } from "@mux/ai/lib/prompt-builder";
import { createPromptBuilder } from "@mux/ai/lib/prompt-builder";
import { createLanguageModelFromConfig, resolveLanguageModelConfig } from "@mux/ai/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "@mux/ai/lib/providers";
import { withRetry } from "@mux/ai/lib/retry";
import { resolveMuxSigningContext } from "@mux/ai/lib/workflow-credentials";
import {
  extractTimestampedTranscript,
  fetchTranscriptForAsset,
  getReadyTextTracks,
} from "@mux/ai/primitives/transcripts";
import type { MuxAIOptions, TokenUsage, WorkflowCredentialsInput } from "@mux/ai/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export const chapterSchema = z.object({
  startTime: z.number(),
  title: z.string(),
});

export type Chapter = z.infer<typeof chapterSchema>;

export const chaptersSchema = z.object({
  chapters: z.array(chapterSchema),
});

export type ChaptersType = z.infer<typeof chaptersSchema>;

/** Structured return payload from `generateChapters`. */
export interface ChaptersResult {
  assetId: string;
  languageCode: string;
  chapters: Chapter[];
  /** Token usage from the AI provider (for efficiency/cost analysis). */
  usage?: TokenUsage;
}

/**
 * Sections of the chaptering user prompt that can be overridden.
 * Use these to customize the AI's behavior for your specific use case.
 */
export type ChaptersPromptSections =
  "task" |
  "outputFormat" |
  "chapterGuidelines" |
  "titleGuidelines";

/**
 * Override specific sections of the chaptering prompt.
 * Each key corresponds to a section that can be customized.
 *
 * @example
 * ```typescript
 * const result = await generateChapters(assetId, "en", {
 *   promptOverrides: {
 *     titleGuidelines: "Use short, punchy titles under 6 words.",
 *   },
 * });
 * ```
 */
export type ChaptersPromptOverrides = PromptOverrides<ChaptersPromptSections>;

/** Configuration accepted by `generateChapters`. */
export interface ChaptersOptions extends MuxAIOptions {
  /** AI provider used to interpret the transcript (defaults to 'openai'). */
  provider?: SupportedProvider;
  /** Provider-specific model identifier. */
  model?: ModelIdByProvider[SupportedProvider];
  /**
   * Override specific sections of the user prompt.
   * Useful for customizing chaptering criteria for specific use cases.
   */
  promptOverrides?: ChaptersPromptOverrides;
  /**
   * Minimum number of chapters to generate per hour of content.
   * Defaults to 3.
   */
  minChaptersPerHour?: number;
  /**
   * Maximum number of chapters to generate per hour of content.
   * Defaults to 8.
   */
  maxChaptersPerHour?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

async function generateChaptersWithAI({
  provider,
  modelId,
  userPrompt,
  systemPrompt,
  credentials,
}: {
  provider: SupportedProvider;
  modelId: string;
  userPrompt: string;
  systemPrompt: string;
  credentials?: WorkflowCredentialsInput;
}): Promise<{ chapters: ChaptersType; usage: TokenUsage }> {
  "use step";

  const model = await createLanguageModelFromConfig(provider, modelId, credentials);

  const response = await withRetry(() =>
    generateObject({
      model,
      schema: chaptersSchema,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
    }),
  );

  return {
    chapters: response.object,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      reasoningTokens: response.usage.reasoningTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sections of the chaptering system prompt that can be overridden.
 * Use these to customize the AI's persona and constraints.
 */
export type ChapterSystemPromptSections = "role" | "context" | "constraints" | "qualityGuidelines";

/**
 * Prompt builder for the chaptering system prompt.
 * Sections can be individually overridden for different content types.
 */
const chapterSystemPromptBuilder = createPromptBuilder<ChapterSystemPromptSections>({
  template: {
    role: {
      tag: "role",
      content: "You are a video editor and transcript analyst specializing in segmenting content into logical chapters.",
    },
    context: {
      tag: "context",
      content: dedent`
        You receive a timestamped transcript with lines in the form "[12s] Caption text".
        Use those timestamps as anchors to determine chapter start times in seconds.`,
    },
    constraints: {
      tag: "constraints",
      content: dedent`
        - Only use information present in the transcript
        - Return structured data that matches the requested JSON schema
        - Do not add commentary or extra text outside the JSON`,
    },
    qualityGuidelines: {
      tag: "quality_guidelines",
      content: dedent`
        - Create chapters at topic shifts or clear transitions
        - Keep chapter titles concise and descriptive
        - Ensure the first chapter starts at 0 seconds`,
    },
  },
  sectionOrder: ["role", "context", "constraints", "qualityGuidelines"],
});

/**
 * System prompt overrides for audio-only assets.
 * Adjusts the role and context to be audio-focused rather than video-focused.
 */
const AUDIO_ONLY_SYSTEM_PROMPT_OVERRIDES: Partial<Record<ChapterSystemPromptSections, string>> = {
  role: "You are an audio editor and transcript analyst specializing in segmenting content into logical chapters.",
  context: dedent`
    You receive a timestamped transcript from audio-only content with lines in the form "[12s] Transcript text".
    Use those timestamps as anchors to determine chapter start times in seconds.`,
};

/**
 * Prompt builder for the chaptering user prompt.
 * Sections can be individually overridden via `promptOverrides` in ChaptersOptions.
 */
const chaptersPromptBuilder = createPromptBuilder<ChaptersPromptSections>({
  template: {
    task: {
      tag: "task",
      content: "Segment the transcript into logical chapters and provide a short title for each chapter.",
    },
    outputFormat: {
      tag: "output_format",
      content: dedent`
        Return valid JSON in this exact shape:
        {
          "chapters": [
            {"startTime": 0, "title": "Introduction"},
            {"startTime": 45.5, "title": "Main Topic Discussion"},
            {"startTime": 120.0, "title": "Conclusion"}
          ]
        }`,
    },
    // Note: chapterGuidelines is dynamically generated in buildUserPrompt()
    // based on minChaptersPerHour/maxChaptersPerHour options
    chapterGuidelines: {
      tag: "chapter_guidelines",
      content: "", // Placeholder - always overridden with dynamic content
    },
    titleGuidelines: {
      tag: "title_guidelines",
      content: dedent`
        - Keep titles concise and descriptive
        - Avoid filler or generic labels like "Chapter 1"
        - Use the transcript's language and terminology`,
    },
  },
  sectionOrder: ["task", "outputFormat", "chapterGuidelines", "titleGuidelines"],
});

function buildUserPrompt({
  timestampedTranscript,
  promptOverrides,
  minChaptersPerHour = 3,
  maxChaptersPerHour = 8,
}: {
  timestampedTranscript: string;
  promptOverrides?: ChaptersPromptOverrides;
  minChaptersPerHour?: number;
  maxChaptersPerHour?: number;
}): string {
  const contextSections: PromptSection[] = [
    {
      tag: "timestamped_transcript",
      content: timestampedTranscript,
      attributes: { format: "seconds" },
    },
  ];

  // Build dynamic chapter guidelines with configurable min/max per hour
  const dynamicChapterGuidelines = dedent`
    - Create at least ${minChaptersPerHour} and at most ${maxChaptersPerHour} chapters per hour of content
    - Use start times in seconds (not HH:MM:SS)
    - Chapter start times should be non-decreasing
    - Do not include text before or after the JSON`;

  // Merge with any user-provided overrides (user overrides take precedence)
  const mergedOverrides: ChaptersPromptOverrides = {
    chapterGuidelines: dynamicChapterGuidelines,
    ...promptOverrides,
  };

  return chaptersPromptBuilder.buildWithContext(mergedOverrides, contextSections);
}

export async function generateChapters(
  assetId: string,
  languageCode: string,
  options: ChaptersOptions = {},
): Promise<ChaptersResult> {
  "use workflow";
  const {
    provider = "openai",
    model,
    promptOverrides,
    minChaptersPerHour,
    maxChaptersPerHour,
    credentials,
  } = options;

  const modelConfig = resolveLanguageModelConfig({
    ...options,
    model,
    provider: provider as SupportedProvider,
  });

  // Fetch asset and transcript
  const { asset: assetData, playbackId, policy } = await getPlaybackIdForAsset(assetId, credentials);
  const isAudioOnly = isAudioOnlyAsset(assetData);

  // Resolve signing context for signed playback IDs
  const signingContext = await resolveMuxSigningContext(credentials);
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. " +
      "Provide muxSigningKey and muxPrivateKey in options or set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  const readyTextTracks = getReadyTextTracks(assetData);
  let transcriptResult = await fetchTranscriptForAsset(assetData, playbackId, {
    languageCode,
    cleanTranscript: false, // keep timestamps for chapter segmentation
    shouldSign: policy === "signed",
    credentials,
  });

  if (isAudioOnly && !transcriptResult.track && readyTextTracks.length === 1) {
    transcriptResult = await fetchTranscriptForAsset(assetData, playbackId, {
      cleanTranscript: false, // keep timestamps for chapter segmentation
      shouldSign: policy === "signed",
      credentials,
      required: true,
    });
  }

  if (!transcriptResult.track || !transcriptResult.transcriptText) {
    const availableLanguages = readyTextTracks
      .map(t => t.language_code)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `No caption track found for language '${languageCode}'. Available languages: ${availableLanguages || "none"}`,
    );
  }

  const timestampedTranscript = extractTimestampedTranscript(transcriptResult.transcriptText);
  if (!timestampedTranscript) {
    const contentLabel = isAudioOnly ? "transcript" : "caption track";
    throw new Error(`No usable content found in ${contentLabel}`);
  }

  const userPrompt = buildUserPrompt({
    timestampedTranscript,
    promptOverrides,
    minChaptersPerHour,
    maxChaptersPerHour,
  });

  // Generate chapters using AI SDK
  let chaptersData: { chapters: ChaptersType; usage: TokenUsage } | null = null;

  try {
    const systemPrompt = isAudioOnly ?
        chapterSystemPromptBuilder.build(AUDIO_ONLY_SYSTEM_PROMPT_OVERRIDES) :
        chapterSystemPromptBuilder.build();
    chaptersData = await generateChaptersWithAI({
      provider: modelConfig.provider,
      modelId: modelConfig.modelId,
      userPrompt,
      systemPrompt,
      credentials,
    });
  } catch (error) {
    throw new Error(
      `Failed to generate chapters with ${provider}: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  if (!chaptersData || !chaptersData.chapters) {
    throw new Error("No chapters generated from AI response");
  }

  // Validate and sort chapters
  const { chapters: chaptersPayload, usage } = chaptersData;
  const validChapters = chaptersPayload.chapters
    .filter(chapter => typeof chapter.startTime === "number" && typeof chapter.title === "string")
    .sort((a, b) => a.startTime - b.startTime);

  if (validChapters.length === 0) {
    throw new Error("No valid chapters found in AI response");
  }

  // Ensure first chapter starts at 0
  if (validChapters[0].startTime !== 0) {
    validChapters[0].startTime = 0;
  }

  return {
    assetId,
    languageCode,
    chapters: validChapters,
    usage,
  };
}
