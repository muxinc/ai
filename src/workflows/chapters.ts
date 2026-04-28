import { generateText, Output } from "ai";
import dedent from "dedent";
import { z } from "zod";

import { getLanguageName } from "@mux/ai/lib/language-codes";
import { MuxAiError, wrapError } from "@mux/ai/lib/mux-ai-error";
import {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  isAudioOnlyAsset,
  toPlaybackAsset,
} from "@mux/ai/lib/mux-assets";
import { createSafetyReporter, detectUnexpectedKeys, detectUnexpectedKeysFromRawText } from "@mux/ai/lib/output-safety";
import type { SafetyReport } from "@mux/ai/lib/output-safety";
import type { PromptOverrides, PromptSection } from "@mux/ai/lib/prompt-builder";
import { createLanguageSection, createPromptBuilder } from "@mux/ai/lib/prompt-builder";
import {
  CANARY_TRIPWIRE,
  NON_DISCLOSURE_CONSTRAINT,
  UNTRUSTED_USER_INPUT_NOTICE,
} from "@mux/ai/lib/prompt-fragments";
import { createLanguageModelFromConfig, resolveLanguageModelConfig } from "@mux/ai/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "@mux/ai/lib/providers";
import { withRetry } from "@mux/ai/lib/retry";
import { resolveMuxSigningContext } from "@mux/ai/lib/workflow-credentials";
import {
  extractTimestampedTranscript,
  fetchTranscriptForAsset,
  getReadyTextTracks,
  getReliableLanguageCode,
} from "@mux/ai/primitives/transcripts";
import type { MuxAIOptions, MuxAsset, TokenUsage, WorkflowCredentialsInput } from "@mux/ai/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Uses zod's default `.strip()` on both schemas so extra keys the model
 * emits are silently stripped rather than failing the workflow. The
 * smuggling-channel concern (a coerced model emitting prompt fragments
 * under an unexpected key) is surfaced by the call site's
 * `detectUnexpectedKeysFromRawText` pass, which records each extra as
 * an `unexpected_key` entry in the workflow's safety report.
 *
 * `.max(300)` on `title` caps the exfiltration channel.
 *
 * Tuning notes:
 * - Chapter titles are short labels ("Introduction", "Main Topic
 *   Discussion") and typically run 10–50 characters.
 * - 300 chars leaves generous headroom (~6x typical). Could plausibly
 *   tighten to 150 once telemetry shows no legitimate output
 *   approaches that length.
 */
export const chapterSchema = z.object({
  startTime: z.number(),
  title: z.string().max(300),
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
  /**
   * Aggregate report of output-side scrubbing performed during this call.
   * When `leaksDetected` is `true`, at least one chapter title was
   * suppressed. Suppressed chapters are dropped from the returned
   * `chapters` array so playback timelines are not decorated with blank
   * titles; consult `scrubbedFields` to know how many were removed.
   */
  safety?: SafetyReport;
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
 * const result = await generateChapters(assetId, {
 *   promptOverrides: {
 *     titleGuidelines: "Use short, punchy titles under 6 words.",
 *   },
 * });
 * ```
 */
export type ChaptersPromptOverrides = PromptOverrides<ChaptersPromptSections>;

/** Configuration accepted by `generateChapters`. */
export interface ChaptersOptions extends MuxAIOptions {
  /** BCP 47 language code of the caption track to use (e.g. "en", "fr"). When omitted, prefers English if available. */
  languageCode?: string;
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
  /**
   * BCP 47 language code for chapter titles (e.g. "en", "fr", "ja").
   * When omitted, auto-detects from the transcript track's language.
   * Falls back to unconstrained (LLM decides) if no language metadata is available.
   */
  outputLanguageCode?: string;
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
}): Promise<{
  chapters: ChaptersType;
  usage: TokenUsage;
  /** Unexpected keys on the root envelope (alongside `chapters`). */
  unexpectedRootKeys: string[];
  /** Unexpected keys on each chapter object, aligned by index. */
  unexpectedChapterKeys: string[][];
}> {
  "use step";

  const model = await createLanguageModelFromConfig(provider, modelId, credentials);

  const response = await withRetry(() =>
    generateText({
      model,
      output: Output.object({ schema: chaptersSchema }),
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

  // Detect schema-smuggling. response.output has already been stripped;
  // re-parse response.text to see what the model actually emitted.
  const unexpectedRootKeys = detectUnexpectedKeysFromRawText(
    response.text,
    chaptersSchema.keyof().options,
  );
  const unexpectedChapterKeys: string[][] = [];
  try {
    const rawEnvelope = JSON.parse(response.text ?? "{}");
    const rawChapters = Array.isArray(rawEnvelope?.chapters) ? rawEnvelope.chapters : [];
    // Hoisted out of the loop: the per-chapter shape is identical for
    // every element, so we derive its keys once.
    const chapterKeys = chapterSchema.keyof().options;
    for (const rawChapter of rawChapters) {
      // `rawChapter` is already parsed; skip the stringify + re-parse
      // roundtrip via the object-form detector.
      unexpectedChapterKeys.push(detectUnexpectedKeys(rawChapter, chapterKeys));
    }
  } catch {
    // Non-JSON raw text; skip per-chapter detection silently.
  }

  return {
    chapters: response.output,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      reasoningTokens: response.usage.reasoningTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
    },
    unexpectedRootKeys,
    unexpectedChapterKeys,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sections of the chaptering system prompt that can be overridden.
 * Use these to customize the AI's persona and constraints.
 */
export type ChapterSystemPromptSections = "role" | "context" | "security" | "constraints" | "qualityGuidelines";

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
    security: {
      tag: "security",
      content: dedent`
        ${NON_DISCLOSURE_CONSTRAINT}

        ${UNTRUSTED_USER_INPUT_NOTICE}

        ${CANARY_TRIPWIRE}`,
    },
    constraints: {
      tag: "constraints",
      content: dedent`
        - Only use information present in the transcript
        - Return structured data that matches the requested JSON schema
        - Do not add commentary or extra text outside the JSON
        - When a <language> section is provided, all chapter titles MUST be written in that language`,
    },
    qualityGuidelines: {
      tag: "quality_guidelines",
      content: dedent`
        - Create chapters at topic shifts or clear transitions
        - Keep chapter titles concise and descriptive
        - Ensure the first chapter starts at 0 seconds`,
    },
  },
  sectionOrder: ["role", "context", "security", "constraints", "qualityGuidelines"],
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
        - Use the transcript's terminology`,
    },
  },
  sectionOrder: ["task", "outputFormat", "chapterGuidelines", "titleGuidelines"],
});

function buildUserPrompt({
  timestampedTranscript,
  promptOverrides,
  minChaptersPerHour = 3,
  maxChaptersPerHour = 8,
  languageName,
}: {
  timestampedTranscript: string;
  promptOverrides?: ChaptersPromptOverrides;
  minChaptersPerHour?: number;
  maxChaptersPerHour?: number;
  languageName?: string;
}): string {
  const contextSections: PromptSection[] = [
    {
      tag: "timestamped_transcript",
      content: timestampedTranscript,
      attributes: { format: "seconds" },
    },
  ];

  if (languageName) {
    contextSections.push(createLanguageSection(languageName));
  }

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
  asset: string | MuxAsset,
  options: ChaptersOptions = {},
): Promise<ChaptersResult> {
  "use workflow";
  const {
    languageCode,
    provider = "openai",
    model,
    promptOverrides,
    minChaptersPerHour,
    maxChaptersPerHour,
    credentials,
    outputLanguageCode,
  } = options;

  const modelConfig = resolveLanguageModelConfig({
    ...options,
    model,
    provider: provider as SupportedProvider,
  });
  const assetId = typeof asset === "string" ? asset : asset.id;
  // Fetch asset and transcript
  const { asset: assetData, playbackId, policy } = typeof asset === "string" ?
      await getPlaybackIdForAsset(asset, credentials) :
      toPlaybackAsset(asset);
  const assetDurationSeconds = getAssetDurationSecondsFromAsset(assetData);
  const isAudioOnly = isAudioOnlyAsset(assetData);

  // Resolve signing context for signed playback IDs
  const signingContext = await resolveMuxSigningContext(credentials);
  if (policy === "signed" && !signingContext) {
    throw new MuxAiError(
      "Signed playback ID requires signing credentials. " +
      "Set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
      { type: "validation_error" },
    );
  }

  const readyTextTracks = getReadyTextTracks(assetData);
  const transcriptResult = await fetchTranscriptForAsset(assetData, playbackId, {
    languageCode,
    cleanTranscript: false, // keep timestamps for chapter segmentation
    shouldSign: policy === "signed",
    credentials,
  });

  if (!transcriptResult.track || !transcriptResult.transcriptText) {
    const availableLanguages = readyTextTracks
      .map(t => t.language_code)
      .filter(Boolean)
      .join(", ");
    throw new MuxAiError(
      `No caption track found${languageCode ? ` for language ${languageCode}` : ""}. Available languages: ${availableLanguages || "none"}.`,
      { type: "validation_error" },
    );
  }
  const timestampedTranscript = extractTimestampedTranscript(transcriptResult.transcriptText);
  if (!timestampedTranscript) {
    const contentLabel = isAudioOnly ? "transcript" : "caption track";
    throw new MuxAiError(`No usable content found in ${contentLabel}.`, { type: "validation_error" });
  }

  // Resolve output language: explicit code takes priority, otherwise auto-detect from transcript track.
  // Low-confidence auto-detected languages and undetermined codes ("und") are filtered out.
  const resolvedLanguageCode = outputLanguageCode && outputLanguageCode !== "auto" ?
    outputLanguageCode :
      (getReliableLanguageCode(transcriptResult.track) ?? languageCode);
  const languageName = resolvedLanguageCode ? getLanguageName(resolvedLanguageCode) : undefined;

  const userPrompt = buildUserPrompt({
    timestampedTranscript,
    promptOverrides,
    minChaptersPerHour,
    maxChaptersPerHour,
    languageName,
  });

  // Generate chapters using AI SDK
  let chaptersData: Awaited<ReturnType<typeof generateChaptersWithAI>> | null = null;

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
    wrapError(error, `Failed to generate chapters with ${provider}`);
  }

  if (!chaptersData || !chaptersData.chapters) {
    throw new MuxAiError(`Failed to generate chapters for asset ${assetId}.`);
  }

  // Validate and sort chapters
  const { chapters: chaptersPayload, usage } = chaptersData;
  const validChapters = chaptersPayload.chapters
    .filter(chapter => typeof chapter.startTime === "number" && typeof chapter.title === "string")
    .sort((a, b) => a.startTime - b.startTime);

  if (validChapters.length === 0) {
    throw new MuxAiError(`Failed to generate valid chapters for asset ${assetId}.`);
  }

  // Scrub chapter titles for signs of a system-prompt leak. Titles are
  // free-text model output and are a viable exfiltration channel — a
  // handful of "chapters" whose titles each hold a fragment of the system
  // prompt could reassemble into a full leak on the consumer's side.
  // Chapters whose titles fail the scrub are dropped entirely rather than
  // kept with an empty title (empty titles would create useless markers
  // on a player timeline).
  const safety = createSafetyReporter();

  // Record schema-smuggling signals from the step before scrubbing
  // titles, so the safety report reflects both sources of concern.
  //
  // Important distinction on the field names: the `chaptersData`
  // arrays are indexed by RAW model-output position (pre-filter,
  // pre-sort), while `validChapters` below is indexed by the
  // filtered-and-sorted-by-startTime position — they are two
  // different coordinate systems. An entry `chapters[2].title`
  // from the title scrub and an entry `chapters[2].foo` from the
  // unexpected-key detection could refer to completely different
  // chapters if the model emitted them out of order. Use a
  // `chapters_raw[idx]` field-name prefix for the raw-order entries
  // so operators reading the safety report can't conflate the two.
  for (const key of chaptersData.unexpectedRootKeys) {
    safety.record(`chapters_envelope.${key}`, "unexpected_key");
  }
  chaptersData.unexpectedChapterKeys.forEach((extras, idx) => {
    for (const key of extras) {
      safety.record(`chapters_raw[${idx}].${key}`, "unexpected_key");
    }
  });
  const totalUnexpected = chaptersData.unexpectedRootKeys.length +
    chaptersData.unexpectedChapterKeys.reduce((sum, e) => sum + e.length, 0);
  if (totalUnexpected > 0) {
    console.warn(
      `[@mux/ai] Model emitted ${totalUnexpected} unexpected key(s) in chapters output (stripped).`,
    );
  }

  // Title scrub uses `validChapters` indices — i.e. the position in
  // the final sorted-and-filtered output the caller receives. These
  // indices match the `chapters` array in the returned result, so
  // operators can correlate safety entries with chapters in the
  // output directly.
  const scrubbedChapters = validChapters.filter((chapter, idx) => {
    const scrub = safety.scrubDetailed(chapter.title, `chapters[${idx}].title`);
    return !scrub.leaked;
  });

  if (scrubbedChapters.length === 0) {
    throw new MuxAiError(`Failed to generate valid chapters for asset ${assetId}.`);
  }

  // Ensure first chapter starts at 0
  if (scrubbedChapters[0].startTime !== 0) {
    scrubbedChapters[0].startTime = 0;
  }

  const usageWithMetadata: TokenUsage = {
    ...usage,
    metadata: {
      ...usage?.metadata,
      assetDurationSeconds,
    },
  };

  return {
    assetId,
    languageCode: languageCode ?? getReliableLanguageCode(transcriptResult.track) ?? "en",
    chapters: scrubbedChapters,
    usage: usageWithMetadata,
    safety: safety.report(),
  };
}
