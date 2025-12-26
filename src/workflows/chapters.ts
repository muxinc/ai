import { generateObject } from "ai";
import dedent from "dedent";
import { z } from "zod";

import { createWorkflowConfig } from "@mux/ai/lib/client-factory";
import { getPlaybackIdForAsset } from "@mux/ai/lib/mux-assets";
import type { PromptOverrides, PromptSection } from "@mux/ai/lib/prompt-builder";
import { createPromptBuilder } from "@mux/ai/lib/prompt-builder";
import { createLanguageModelFromConfig } from "@mux/ai/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "@mux/ai/lib/providers";
import { withRetry } from "@mux/ai/lib/retry";
import { getMuxSigningContextFromEnv } from "@mux/ai/lib/url-signing";
import {
  extractTimestampedTranscript,
  fetchTranscriptForAsset,
  getReadyTextTracks,
} from "@mux/ai/primitives/transcripts";
import type { MuxAIOptions, TokenUsage } from "@mux/ai/types";

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
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

async function generateChaptersWithAI({
  provider,
  modelId,
  userPrompt,
  systemPrompt,
}: {
  provider: SupportedProvider;
  modelId: string;
  userPrompt: string;
  systemPrompt: string;
}): Promise<{ chapters: ChaptersType; usage: TokenUsage }> {
  "use step";

  const model = createLanguageModelFromConfig(provider, modelId);

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

const SYSTEM_PROMPT = dedent`
  <role>
    You are a video editor and transcript analyst specializing in segmenting content into logical chapters.
  </role>

  <context>
    You receive a timestamped transcript with lines in the form "[12s] Caption text".
    Use those timestamps as anchors to determine chapter start times in seconds.
  </context>

  <constraints>
    - Only use information present in the transcript
    - Return structured data that matches the requested JSON schema
    - Do not add commentary or extra text outside the JSON
  </constraints>

  <quality_guidelines>
    - Create chapters at topic shifts or clear transitions
    - Keep chapter titles concise and descriptive
    - Ensure the first chapter starts at 0 seconds
  </quality_guidelines>`;

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
    chapterGuidelines: {
      tag: "chapter_guidelines",
      content: dedent`
        - Create 3-8 chapters depending on content length and natural breaks
        - Use start times in seconds (not HH:MM:SS)
        - Chapter start times should be non-decreasing
        - Do not include text before or after the JSON`,
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
}: {
  timestampedTranscript: string;
  promptOverrides?: ChaptersPromptOverrides;
}): string {
  const contextSections: PromptSection[] = [
    {
      tag: "timestamped_transcript",
      content: timestampedTranscript,
      attributes: { format: "seconds" },
    },
  ];

  return chaptersPromptBuilder.buildWithContext(promptOverrides, contextSections);
}

export async function generateChapters(
  assetId: string,
  languageCode: string,
  options: ChaptersOptions = {},
): Promise<ChaptersResult> {
  "use workflow";
  const { provider = "openai", model, promptOverrides } = options;

  // Validate credentials and resolve language model
  const config = await createWorkflowConfig({ ...options, model }, provider as SupportedProvider);

  // Fetch asset and caption track/transcript
  const { asset: assetData, playbackId, policy } = await getPlaybackIdForAsset(assetId);

  // Resolve signing context for signed playback IDs
  const signingContext = getMuxSigningContextFromEnv();
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. " +
      "Provide muxSigningKey and muxPrivateKey in options or set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  const transcriptResult = await fetchTranscriptForAsset(assetData, playbackId, {
    languageCode,
    cleanTranscript: false, // keep timestamps for chapter segmentation
    shouldSign: policy === "signed",
  });

  if (!transcriptResult.track || !transcriptResult.transcriptText) {
    const availableLanguages = getReadyTextTracks(assetData)
      .map(t => t.language_code)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `No caption track found for language '${languageCode}'. Available languages: ${availableLanguages || "none"}`,
    );
  }

  const timestampedTranscript = extractTimestampedTranscript(transcriptResult.transcriptText);
  if (!timestampedTranscript) {
    throw new Error("No usable content found in caption track");
  }

  const userPrompt = buildUserPrompt({ timestampedTranscript, promptOverrides });

  // Generate chapters using AI SDK
  let chaptersData: { chapters: ChaptersType; usage: TokenUsage } | null = null;

  try {
    chaptersData = await generateChaptersWithAI({
      provider: config.provider,
      modelId: config.modelId,
      userPrompt,
      systemPrompt: SYSTEM_PROMPT,
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
