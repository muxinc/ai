import { generateText, Output } from "ai";
import dedent from "dedent";
import { z } from "zod";

import type { ImageDownloadOptions } from "@mux/ai/lib/image-download";
import { downloadImageAsBase64 } from "@mux/ai/lib/image-download";
import { getLanguageName } from "@mux/ai/lib/language-codes";
import { MuxAiError, wrapError } from "@mux/ai/lib/mux-ai-error";
import {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  isAudioOnlyAsset,
} from "@mux/ai/lib/mux-assets";
import { createSafetyReporter } from "@mux/ai/lib/output-safety";
import type { SafetyReport } from "@mux/ai/lib/output-safety";
import type {
  PromptOverrides,
} from "@mux/ai/lib/prompt-builder";
import {
  createLanguageSection,
  createPromptBuilder,
  createToneSection,
  createTranscriptSection,
} from "@mux/ai/lib/prompt-builder";
import {
  CANARY_TRIPWIRE,
  createLanguageGuidelines,
  METADATA_BOUNDARY_WARNING,
  NO_FABRICATION_CONSTRAINT,
  NON_DISCLOSURE_CONSTRAINT,
  promptDedent,
  STORYBOARD_FRAME_INSTRUCTIONS,
  STRUCTURED_DATA_CONSTRAINT,
  TONE_GUIDANCE,
  UNTRUSTED_USER_INPUT_NOTICE,
  VISUAL_TEXT_AS_CONTENT,
} from "@mux/ai/lib/prompt-fragments";
import { createLanguageModelFromConfig, resolveLanguageModelConfig } from "@mux/ai/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "@mux/ai/lib/providers";
import { withRetry } from "@mux/ai/lib/retry";
import {
  resolveMuxSigningContext,
} from "@mux/ai/lib/workflow-credentials";
import { getStoryboardUrl } from "@mux/ai/primitives/storyboards";
import { fetchTranscriptForAsset, getReadyTextTracks, getReliableLanguageCode } from "@mux/ai/primitives/transcripts";
import type {
  ImageSubmissionMode,
  MuxAIOptions,
  TokenUsage,
  ToneType,
  WorkflowCredentialsInput,
} from "@mux/ai/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_SUMMARY_KEYWORD_LIMIT = 10;
export const DEFAULT_TITLE_LENGTH = 10;
export const DEFAULT_DESCRIPTION_LENGTH = 50;

export const summarySchema = z.object({
  keywords: z.array(z.string()),
  title: z.string(),
  description: z.string(),
}).strict();

export type SummaryType = z.infer<typeof summarySchema>;

const SUMMARY_OUTPUT = Output.object({
  name: "summary_metadata",
  description: "Structured summary with title, description, and keywords.",
  schema: summarySchema,
});

/** Structured return payload for `getSummaryAndTags`. */
export interface SummaryAndTagsResult {
  /** Asset ID passed into the workflow. */
  assetId: string;
  /** Short headline generated from the storyboard. */
  title: string;
  /** Longer description of the detected content. */
  description: string;
  /** Up to 10 keywords extracted by the model. */
  tags: string[];
  /** Storyboard image URL that was analyzed (undefined for audio-only assets). */
  storyboardUrl?: string;
  /** Token usage from the AI provider (for efficiency/cost analysis). */
  usage?: TokenUsage;
  /** Raw transcript text used for analysis (when includeTranscript is true). */
  transcriptText?: string;
  /**
   * Aggregate report of output-side scrubbing performed during this call.
   * When `leaksDetected` is `true`, at least one of `title`, `description`,
   * or an element of `tags` was suppressed because the scrubber detected
   * signs of a prompt leak — consult `scrubbedFields` for which.
   * Suppressed fields are returned as empty strings or omitted from the
   * tags array.
   */
  safety?: SafetyReport;
}

/**
 * Sections of the summarization user prompt that can be overridden.
 * Use these to customize the AI's behavior for your specific use case.
 */
export type SummarizationPromptSections =
  | "task" |
  "title" |
  "description" |
  "keywords" |
  "qualityGuidelines";

/**
 * Override specific sections of the summarization prompt.
 * Each key corresponds to a section that can be customized.
 *
 * @example
 * ```typescript
 * const result = await getSummaryAndTags(assetId, {
 *   promptOverrides: {
 *     task: 'Generate SEO-optimized metadata for this product video.',
 *     title: 'Create a click-worthy title under 60 characters for YouTube.',
 *   },
 * });
 * ```
 */
export type SummarizationPromptOverrides = PromptOverrides<SummarizationPromptSections>;

/** Configuration accepted by `getSummaryAndTags`. */
export interface SummarizationOptions extends MuxAIOptions {
  /** AI provider to run (defaults to 'openai'). */
  provider?: SupportedProvider;
  /** Provider-specific chat model identifier. */
  model?: ModelIdByProvider[SupportedProvider];
  /** BCP 47 language code of the caption track to use (e.g. "en", "fr"). When omitted, prefers English if available. */
  languageCode?: string;
  /** Prompt tone shim applied to the system instruction (defaults to 'neutral'). */
  tone?: ToneType;
  /** Fetch the transcript and send it alongside the storyboard (defaults to true). */
  includeTranscript?: boolean;
  /** Strip timestamps/markup from transcripts before including them (defaults to true). */
  cleanTranscript?: boolean;
  /** How storyboard frames should be delivered to the provider (defaults to 'url'). */
  imageSubmissionMode?: ImageSubmissionMode;
  /** Fine-tune storyboard downloads when `imageSubmissionMode` === 'base64'. */
  imageDownloadOptions?: ImageDownloadOptions;
  /**
   * Override specific sections of the user prompt.
   * Useful for customizing the AI's output for specific use cases (SEO, social media, etc.)
   */
  promptOverrides?: SummarizationPromptOverrides;
  /** Maximum title length in words. Shorter titles are preferred. */
  titleLength?: number;
  /** Maximum description length in words. Shorter descriptions are acceptable. */
  descriptionLength?: number;
  /** Desired number of tags. */
  tagCount?: number;
  /**
   * BCP 47 language code for the output (e.g. "en", "fr", "ja").
   * When omitted, auto-detects from the transcript track's language.
   * Falls back to unconstrained (LLM decides) if no language metadata is available.
   */
  outputLanguageCode?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

const VALID_TONES = ["neutral", "playful", "professional"] as const;

const TONE_INSTRUCTIONS: Record<ToneType, string> = {
  neutral: "Provide a clear, straightforward analysis.",
  playful: "Channel your inner diva! Answer with maximum sass, wit, and playful attitude. Don't hold back - be cheeky, clever, and delightfully snarky. Make it pop!",
  professional: "Provide a professional, executive-level analysis suitable for business reporting.",
};

interface PromptConstraints {
  titleLength?: number;
  descriptionLength?: number;
  tagCount?: number;
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

function createSummarizationBuilder({ titleLength, descriptionLength, tagCount }: PromptConstraints = {}) {
  const titleLimit = titleLength ?? DEFAULT_TITLE_LENGTH;
  const keywordLimit = tagCount ?? DEFAULT_SUMMARY_KEYWORD_LIMIT;

  return createPromptBuilder<SummarizationPromptSections>({
    template: {
      task: {
        tag: "task",
        content: "Analyze the storyboard frames and generate metadata that captures the essence of the video content.",
      },
      title: {
        tag: "title_requirements",
        content: dedent`
          A concise, label-style title — not a sentence or description.
          Never exceed ${titleLimit} words, but shorter is better.
          Think of how a video card title, playlist entry, or file name would read — e.g. "Predator: Badlands Trailer" or "Chef Prepares Holiday Feast".
          Start with the primary subject or topic. Never begin with "A video of" or similar phrasing.
          Use specific nouns over lengthy descriptions. Avoid clauses, conjunctions, or narrative structure.`,
      },
      description: {
        tag: "description_requirements",
        content: buildDescriptionGuidance(descriptionLength ?? DEFAULT_DESCRIPTION_LENGTH, "video"),
      },
      keywords: {
        tag: "keywords_requirements",
        content: dedent`
          Specific, searchable terms (up to ${keywordLimit}) that capture:
          - Primary subjects (people, animals, objects)
          - Actions and activities being performed
          - Setting and environment
          - Notable objects or tools
          - Style or genre (if applicable)
          Prefer concrete nouns and action verbs over abstract concepts.
          Use lowercase. Avoid redundant or overly generic terms like "video" or "content".`,
      },
      qualityGuidelines: {
        tag: "quality_guidelines",
        content: dedent`
          - Examine all frames to understand the full context and progression
          - Be precise: "golden retriever" is better than "dog" when identifiable
          - Capture the narrative: what begins, develops, and concludes
          - Balance brevity with informativeness`,
      },
    },
    sectionOrder: ["task", "title", "description", "keywords", "qualityGuidelines"],
  });
}

function createAudioOnlyBuilder({ titleLength, descriptionLength, tagCount }: PromptConstraints = {}) {
  const titleLimit = titleLength ?? DEFAULT_TITLE_LENGTH;
  const keywordLimit = tagCount ?? DEFAULT_SUMMARY_KEYWORD_LIMIT;

  return createPromptBuilder<SummarizationPromptSections>({
    template: {
      task: {
        tag: "task",
        content: "Analyze the transcript and generate metadata that captures the essence of the audio content.",
      },
      title: {
        tag: "title_requirements",
        content: dedent`
          A concise, label-style title — not a sentence or description.
          Never exceed ${titleLimit} words, but shorter is better.
          Think of how a podcast episode title or playlist entry would read — e.g. "Weekly News Roundup" or "Interview with Dr. Smith".
          Start with the primary subject or topic. Never begin with "An audio of" or similar phrasing.
          Use specific nouns over lengthy descriptions. Avoid clauses, conjunctions, or narrative structure.`,
      },
      description: {
        tag: "description_requirements",
        content: buildDescriptionGuidance(descriptionLength ?? DEFAULT_DESCRIPTION_LENGTH, "audio"),
      },
      keywords: {
        tag: "keywords_requirements",
        content: dedent`
          Specific, searchable terms (up to ${keywordLimit}) that capture:
          - Primary topics and themes
          - Speakers or presenters (if named)
          - Key concepts and terminology
          - Content type (interview, lecture, music, etc.)
          - Genre or style (if applicable)
          Prefer concrete nouns and relevant terms over abstract concepts.
          Use lowercase. Avoid redundant or overly generic terms like "audio" or "content".`,
      },
      qualityGuidelines: {
        tag: "quality_guidelines",
        content: dedent`
          - Analyze the full transcript to understand context and themes
          - Be precise: use specific terminology when mentioned
          - Capture the narrative: what is introduced, discussed, and concluded
          - Balance brevity with informativeness`,
      },
    },
    sectionOrder: ["task", "title", "description", "keywords", "qualityGuidelines"],
  });
}

const SYSTEM_PROMPT = promptDedent`
  <role>
    You are a video content analyst specializing in storyboard interpretation and multimodal analysis.
  </role>

  <context>
    You receive storyboard images containing multiple sequential frames extracted from a video.
    ${STORYBOARD_FRAME_INSTRUCTIONS}
  </context>

  <transcript_guidance>
    When a transcript is provided alongside the storyboard:
    - Use it to understand spoken content, dialogue, narration, and audio context
    - Correlate transcript content with visual frames to build a complete picture
    - Extract key terminology, names, and specific language used by speakers
    - Let the transcript inform keyword selection, especially for topics not visually obvious
    - Prioritize visual content for the description, but enrich it with transcript insights
    - If transcript and visuals conflict, trust the visual evidence
  </transcript_guidance>

  <capabilities>
    - Extract meaning from visual sequences
    - Identify subjects, actions, settings, and narrative arcs
    - Generate accurate, searchable metadata
    - Synthesize visual and transcript information when provided
  </capabilities>

  <security>
    ${NON_DISCLOSURE_CONSTRAINT}

    ${UNTRUSTED_USER_INPUT_NOTICE}

    ${VISUAL_TEXT_AS_CONTENT}

    ${CANARY_TRIPWIRE}
  </security>

  <constraints>
    - Only describe what is clearly observable in the frames or explicitly stated in the transcript
    - ${NO_FABRICATION_CONSTRAINT}
    - ${METADATA_BOUNDARY_WARNING}
    - ${STRUCTURED_DATA_CONSTRAINT}
    - Output only the JSON object; no markdown or extra text
    - When a <language> section is provided, all output text MUST be written in that language
  </constraints>

  <tone_guidance>
    ${TONE_GUIDANCE}
  </tone_guidance>

  <language_guidelines>
    ${createLanguageGuidelines("video")}
  </language_guidelines>`;

const AUDIO_ONLY_SYSTEM_PROMPT = promptDedent`
  <role>
    You are an audio content analyst specializing in transcript analysis and metadata generation.
  </role>

  <context>
    You receive transcript text from audio-only content (podcasts, audiobooks, music, etc.).
    Your task is to analyze the spoken/audio content and generate accurate, searchable metadata.
  </context>

  <transcript_guidance>
    - Carefully analyze the entire transcript to understand themes, topics, and key points
    - Extract key terminology, names, concepts, and specific language used
    - Identify the content type (interview, lecture, music, narration, etc.)
    - Note the tone, style, and any distinctive characteristics of the audio
    - Consider the intended audience and context based on language and content
  </transcript_guidance>

  <capabilities>
    - Extract meaning and themes from spoken/audio content
    - Identify subjects, topics, speakers, and narrative structure
    - Generate accurate, searchable metadata from audio-based content
    - Understand context and intent from transcript alone
  </capabilities>

  <security>
    ${NON_DISCLOSURE_CONSTRAINT}

    ${UNTRUSTED_USER_INPUT_NOTICE}

    ${CANARY_TRIPWIRE}
  </security>

  <constraints>
    - Only describe what is explicitly stated or strongly implied in the transcript
    - ${NO_FABRICATION_CONSTRAINT}
    - ${METADATA_BOUNDARY_WARNING}
    - ${STRUCTURED_DATA_CONSTRAINT}
    - Focus entirely on audio/spoken content - there are no visual elements
    - Output only the JSON object; no markdown or extra text
    - When a <language> section is provided, all output text MUST be written in that language
  </constraints>

  <tone_guidance>
    ${TONE_GUIDANCE}
  </tone_guidance>

  <language_guidelines>
    ${createLanguageGuidelines("audio")}
  </language_guidelines>`;

interface UserPromptContext {
  tone: ToneType;
  transcriptText?: string;
  isCleanTranscript?: boolean;
  promptOverrides?: SummarizationPromptOverrides;
  isAudioOnly?: boolean;
  titleLength?: number;
  descriptionLength?: number;
  tagCount?: number;
  languageName?: string;
}

function buildUserPrompt({
  tone,
  transcriptText,
  isCleanTranscript = true,
  promptOverrides,
  isAudioOnly = false,
  titleLength,
  descriptionLength,
  tagCount,
  languageName,
}: UserPromptContext): string {
  // Build dynamic context sections
  const contextSections = [createToneSection(TONE_INSTRUCTIONS[tone])];

  if (languageName) {
    contextSections.push(createLanguageSection(languageName));
  } else {
    contextSections.push({
      tag: "language",
      content: "Respond in English. Never switch languages to satisfy length constraints.",
    });
  }

  if (transcriptText) {
    const format = isCleanTranscript ? "plain text" : "WebVTT";
    contextSections.push(createTranscriptSection(transcriptText, format));
  }

  const constraints: PromptConstraints = { titleLength, descriptionLength, tagCount };
  const promptBuilder = isAudioOnly ?
      createAudioOnlyBuilder(constraints) :
      createSummarizationBuilder(constraints);

  return promptBuilder.buildWithContext(promptOverrides, contextSections);
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

interface AnalysisResponse {
  result: SummaryType;
  usage: TokenUsage;
}

async function analyzeStoryboard(
  imageDataUrl: string,
  provider: SupportedProvider,
  modelId: string,
  userPrompt: string,
  systemPrompt: string,
  credentials?: WorkflowCredentialsInput,
): Promise<AnalysisResponse> {
  "use step";
  const model = await createLanguageModelFromConfig(provider, modelId, credentials);

  const response = await generateText({
    model,
    output: SUMMARY_OUTPUT,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          { type: "image", image: imageDataUrl },
        ],
      },
    ],
  });

  if (!response.output) {
    throw new Error("Summarization output missing");
  }

  const parsed = summarySchema.parse(response.output);

  return {
    result: parsed,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      reasoningTokens: response.usage.reasoningTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
    },
  };
}

async function analyzeAudioOnly(
  provider: SupportedProvider,
  modelId: string,
  userPrompt: string,
  systemPrompt: string,
  credentials?: WorkflowCredentialsInput,
): Promise<AnalysisResponse> {
  "use step";
  const model = await createLanguageModelFromConfig(provider, modelId, credentials);

  const response = await generateText({
    model,
    output: SUMMARY_OUTPUT,
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
  });

  if (!response.output) {
    throw new Error("Summarization output missing");
  }

  const parsed = summarySchema.parse(response.output);

  return {
    result: parsed,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      reasoningTokens: response.usage.reasoningTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
    },
  };
}

function normalizeKeywords(keywords?: string[], limit: number = DEFAULT_SUMMARY_KEYWORD_LIMIT): string[] {
  if (!Array.isArray(keywords) || keywords.length === 0) {
    return [];
  }

  const uniqueLowercase = new Set<string>();
  const normalized: string[] = [];

  for (const keyword of keywords) {
    const trimmed = keyword?.trim();
    if (!trimmed) {
      continue;
    }

    const lower = trimmed.toLowerCase();
    if (uniqueLowercase.has(lower)) {
      continue;
    }

    uniqueLowercase.add(lower);
    normalized.push(trimmed);

    if (normalized.length === limit) {
      break;
    }
  }

  return normalized;
}

export async function getSummaryAndTags(
  assetId: string,
  options?: SummarizationOptions,
): Promise<SummaryAndTagsResult> {
  "use workflow";
  const {
    provider = "openai",
    model,
    languageCode,
    tone = "neutral",
    includeTranscript = true,
    cleanTranscript = true,
    imageSubmissionMode = "url",
    imageDownloadOptions,
    promptOverrides,
    credentials,
    titleLength,
    descriptionLength,
    tagCount,
    outputLanguageCode,
  } = options ?? {};

  // Validate tone parameter
  if (!VALID_TONES.includes(tone)) {
    throw new MuxAiError(
      `Invalid tone "${tone}". Valid tones are: ${VALID_TONES.join(", ")}.`,
      { type: "validation_error" },
    );
  }

  const modelConfig = resolveLanguageModelConfig({
    ...options,
    model,
    provider: provider as SupportedProvider,
  });
  const workflowCredentials = credentials;

  // Fetch asset data from Mux and grab playback/transcript details
  const { asset: assetData, playbackId, policy } = await getPlaybackIdForAsset(assetId, workflowCredentials);

  const assetDurationSeconds = getAssetDurationSecondsFromAsset(assetData);

  // Detect if asset is audio-only
  const isAudioOnly = isAudioOnlyAsset(assetData);

  // Audio-only assets require transcripts since there's no visual content
  if (isAudioOnly && !includeTranscript) {
    throw new MuxAiError(
      "Audio-only assets require a transcript. Set includeTranscript: true and ensure the asset has a ready text track (captions/subtitles).",
      { type: "validation_error" },
    );
  }

  // Resolve signing context for signed playback IDs
  const signingContext = await resolveMuxSigningContext(workflowCredentials);
  if (policy === "signed" && !signingContext) {
    throw new MuxAiError(
      "Signed playback ID requires signing credentials. " +
      "Set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
      { type: "validation_error" },
    );
  }

  const transcriptResult =
    includeTranscript ?
        await fetchTranscriptForAsset(assetData, playbackId, {
          languageCode,
          cleanTranscript,
          shouldSign: policy === "signed",
          credentials: workflowCredentials,
          required: isAudioOnly,
        }) :
      undefined;
  const transcriptText = transcriptResult?.transcriptText ?? "";

  // Resolve output language: explicit code takes priority, otherwise auto-detect from transcript track.
  // Low-confidence auto-detected languages and undetermined codes ("und") are filtered out.
  const resolvedLanguageCode = outputLanguageCode && outputLanguageCode !== "auto" ?
    outputLanguageCode :
      (getReliableLanguageCode(transcriptResult?.track) ?? getReliableLanguageCode(getReadyTextTracks(assetData)[0]));
  const languageName = resolvedLanguageCode ? getLanguageName(resolvedLanguageCode) : undefined;

  // Build the user prompt with all context and any overrides
  const userPrompt = buildUserPrompt({
    tone,
    transcriptText,
    isCleanTranscript: cleanTranscript,
    promptOverrides,
    isAudioOnly,
    titleLength,
    descriptionLength,
    tagCount,
    languageName,
  });

  let analysisResponse: AnalysisResponse;
  let imageUrl: string | undefined;

  // Choose system prompt and analysis method based on asset type
  const systemPrompt = isAudioOnly ? AUDIO_ONLY_SYSTEM_PROMPT : SYSTEM_PROMPT;

  try {
    if (isAudioOnly) {
      // Audio-only analysis: skip storyboard, analyze transcript only
      analysisResponse = await analyzeAudioOnly(
        modelConfig.provider,
        modelConfig.modelId,
        userPrompt,
        systemPrompt,
        workflowCredentials,
      );
    } else {
      // Video analysis: fetch storyboard and analyze with visual content
      const storyboardUrl = await getStoryboardUrl(playbackId, 640, policy === "signed", workflowCredentials);
      imageUrl = storyboardUrl;

      if (imageSubmissionMode === "base64") {
        const downloadResult = await downloadImageAsBase64(storyboardUrl, imageDownloadOptions);
        analysisResponse = await analyzeStoryboard(
          downloadResult.base64Data,
          modelConfig.provider,
          modelConfig.modelId,
          userPrompt,
          systemPrompt,
          workflowCredentials,
        );
      } else {
        // URL-based submission with retry logic
        analysisResponse = await withRetry(() =>
          analyzeStoryboard(
            storyboardUrl,
            modelConfig.provider,
            modelConfig.modelId,
            userPrompt,
            systemPrompt,
            workflowCredentials,
          ));
      }
    }
  } catch (error: unknown) {
    const contentType = isAudioOnly ? "audio" : "video";
    wrapError(error, `Failed to analyze ${contentType} content with ${provider}`);
  }

  if (!analysisResponse.result) {
    const contentType = isAudioOnly ? "audio" : "video";
    throw new MuxAiError(`Failed to analyze ${contentType} content for asset ${assetId}.`);
  }

  if (!analysisResponse.result.title) {
    throw new MuxAiError(`Failed to generate title for asset ${assetId}.`);
  }

  if (!analysisResponse.result.description) {
    throw new MuxAiError(`Failed to generate description for asset ${assetId}.`);
  }

  // Scrub model-generated free-text fields for signs of a system-prompt
  // leak. Title and description are the highest-value exfiltration targets
  // (description especially — it is unbounded, verbose, and surfaces to
  // end-users). Each keyword is scrubbed individually and dropped on leak.
  // Suppressed title/description are returned as empty strings rather than
  // thrown so callers can detect via the `safety` report and fall back.
  const safety = createSafetyReporter();
  const scrubbedTitle = safety.scrub(analysisResponse.result.title, "title");
  const scrubbedDescription = safety.scrub(analysisResponse.result.description, "description");
  const scrubbedKeywords = (analysisResponse.result.keywords ?? [])
    .map((kw, i) => safety.scrubDetailed(kw, `keywords[${i}]`))
    .filter(result => !result.leaked)
    .map(result => result.text);

  return {
    assetId,
    title: scrubbedTitle,
    description: scrubbedDescription,
    tags: normalizeKeywords(scrubbedKeywords, tagCount ?? DEFAULT_SUMMARY_KEYWORD_LIMIT),
    storyboardUrl: imageUrl, // undefined for audio-only assets
    usage: {
      ...analysisResponse.usage,
      metadata: {
        assetDurationSeconds,
      },
    },
    transcriptText: transcriptText || undefined,
    safety: safety.report(),
  };
}
