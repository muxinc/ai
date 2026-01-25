import { valibotSchema } from "@ai-sdk/valibot";
import { generateText, Output } from "ai";
import dedent from "dedent";
import * as v from "valibot";

import type { ImageDownloadOptions } from "@mux/ai/lib/image-download";
import { downloadImageAsBase64 } from "@mux/ai/lib/image-download";
import { getPlaybackIdForAsset, isAudioOnlyAsset } from "@mux/ai/lib/mux-assets";
import type {
  PromptOverrides,
} from "@mux/ai/lib/prompt-builder";
import {
  createPromptBuilder,
  createToneSection,
  createTranscriptSection,
} from "@mux/ai/lib/prompt-builder";
import { createLanguageModelFromConfig, resolveLanguageModelConfig } from "@mux/ai/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "@mux/ai/lib/providers";
import { withRetry } from "@mux/ai/lib/retry";
import { resolveMuxSigningContext } from "@mux/ai/lib/workflow-credentials";
import { getStoryboardUrl } from "@mux/ai/primitives/storyboards";
import { fetchTranscriptForAsset } from "@mux/ai/primitives/transcripts";
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

export const SUMMARY_KEYWORD_LIMIT = 10;

export const summarySchema = v.strictObject({
  keywords: v.pipe(
    v.array(v.string()),
    v.description("Summary keywords."),
  ),
  title: v.pipe(
    v.string(),
    v.description("Short summary title."),
  ),
  description: v.pipe(
    v.string(),
    v.description("Longer summary description."),
  ),
});

export type SummaryType = v.InferOutput<typeof summarySchema>;

const SUMMARY_OUTPUT = Output.object({
  name: "summary_metadata",
  description: "Structured summary with title, description, and keywords.",
  schema: valibotSchema(summarySchema),
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

/**
 * Prompt builder for the summarization user prompt.
 * Sections can be individually overridden via `promptOverrides` in SummarizationOptions.
 */
const summarizationPromptBuilder = createPromptBuilder<SummarizationPromptSections>({
  template: {
    task: {
      tag: "task",
      content: "Analyze the storyboard frames and generate metadata that captures the essence of the video content.",
    },
    title: {
      tag: "title_requirements",
      content: dedent`
        A short, compelling headline that immediately communicates the subject or action.
        Aim for brevity - typically under 10 words. Think of how a news headline or video card title would read.
        Start with the primary subject, action, or topic - never begin with "A video of" or similar phrasing.
        Use active, specific language.`,
    },
    description: {
      tag: "description_requirements",
      content: dedent`
        A concise summary (2-4 sentences) that describes what happens across the video.
        Cover the main subjects, actions, setting, and any notable progression visible across frames.
        Write in present tense. Be specific about observable details rather than making assumptions.
        If the transcript provides dialogue or narration, incorporate key points but prioritize visual content.`,
    },
    keywords: {
      tag: "keywords_requirements",
      content: dedent`
        Specific, searchable terms (up to ${SUMMARY_KEYWORD_LIMIT}) that capture:
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

/**
 * Prompt builder for audio-only content.
 * Focuses on transcript analysis without visual references.
 */
const audioOnlyPromptBuilder = createPromptBuilder<SummarizationPromptSections>({
  template: {
    task: {
      tag: "task",
      content: "Analyze the transcript and generate metadata that captures the essence of the audio content.",
    },
    title: {
      tag: "title_requirements",
      content: dedent`
        A short, compelling headline that immediately communicates the subject or topic.
        Aim for brevity - typically under 10 words. Think of how a podcast title or audio description would read.
        Start with the primary subject, action, or topic - never begin with "An audio of" or similar phrasing.
        Use active, specific language.`,
    },
    description: {
      tag: "description_requirements",
      content: dedent`
        A concise summary (2-4 sentences) that describes the audio content.
        Cover the main topics, speakers, themes, and any notable progression in the discussion or narration.
        Write in present tense. Be specific about what is discussed or presented rather than making assumptions.
        Focus on the spoken content and any key insights, dialogue, or narrative elements.`,
    },
    keywords: {
      tag: "keywords_requirements",
      content: dedent`
        Specific, searchable terms (up to ${SUMMARY_KEYWORD_LIMIT}) that capture:
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

const SYSTEM_PROMPT = dedent`
  <role>
    You are a video content analyst specializing in storyboard interpretation and multimodal analysis.
  </role>

  <context>
    You receive storyboard images containing multiple sequential frames extracted from a video.
    These frames are arranged in a grid and represent the visual progression of the content over time.
    Read frames left-to-right, top-to-bottom to understand the temporal sequence.
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

  <constraints>
    - Only describe what is clearly observable in the frames or explicitly stated in the transcript
    - Do not fabricate details or make unsupported assumptions
    - Return structured data matching the requested schema
    - Output only the JSON object; no markdown or extra text
  </constraints>

  <tone_guidance>
    Pay special attention to the <tone> section and lean heavily into those instructions.
    Adapt your entire analysis and writing style to match the specified tone - this should influence
    your word choice, personality, formality level, and overall presentation of the content.
    The tone instructions are not suggestions but core requirements for how you should express yourself.
  </tone_guidance>

  <language_guidelines>
    AVOID these meta-descriptive phrases that reference the medium rather than the content:
    - "The image shows..." / "The storyboard shows..."
    - "In this video..." / "This video features..."
    - "The frames depict..." / "The footage shows..."
    - "We can see..." / "You can see..."
    - "The clip shows..." / "The scene shows..."

    INSTEAD, describe the content directly:
    - BAD: "The video shows a chef preparing a meal"
    - GOOD: "A chef prepares a meal in a professional kitchen"

    Write as if describing reality, not describing a recording of reality.
  </language_guidelines>`;

const AUDIO_ONLY_SYSTEM_PROMPT = dedent`
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

  <constraints>
    - Only describe what is explicitly stated or strongly implied in the transcript
    - Do not fabricate details or make unsupported assumptions
    - Return structured data matching the requested schema
    - Focus entirely on audio/spoken content - there are no visual elements
    - Output only the JSON object; no markdown or extra text
  </constraints>

  <tone_guidance>
    Pay special attention to the <tone> section and lean heavily into those instructions.
    Adapt your entire analysis and writing style to match the specified tone - this should influence
    your word choice, personality, formality level, and overall presentation of the content.
    The tone instructions are not suggestions but core requirements for how you should express yourself.
  </tone_guidance>

  <language_guidelines>
    AVOID these meta-descriptive phrases that reference the medium rather than the content:
    - "The audio shows..." / "The transcript shows..."
    - "In this recording..." / "This audio features..."
    - "The speaker says..." / "We can hear..."
    - "The clip contains..." / "The recording shows..."

    INSTEAD, describe the content directly:
    - BAD: "The audio features a discussion about climate change"
    - GOOD: "A panel discusses climate change impacts and solutions"

    Write as if describing reality, not describing a recording of reality.
  </language_guidelines>`;

interface UserPromptContext {
  tone: ToneType;
  transcriptText?: string;
  isCleanTranscript?: boolean;
  promptOverrides?: SummarizationPromptOverrides;
  isAudioOnly?: boolean;
}

function buildUserPrompt({
  tone,
  transcriptText,
  isCleanTranscript = true,
  promptOverrides,
  isAudioOnly = false,
}: UserPromptContext): string {
  // Build dynamic context sections
  const contextSections = [createToneSection(TONE_INSTRUCTIONS[tone])];

  if (transcriptText) {
    const format = isCleanTranscript ? "plain text" : "WebVTT";
    contextSections.push(createTranscriptSection(transcriptText, format));
  }

  // Use audio-only prompt builder for audio-only assets
  const promptBuilder = isAudioOnly ? audioOnlyPromptBuilder : summarizationPromptBuilder;
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

  console.warn("[summarization] response:", JSON.stringify(response, null, 2));

  if (!response.output) {
    throw new Error("Summarization output missing");
  }

  const parsed = v.parse(summarySchema, response.output);

  return {
    result: parsed,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      reasoningTokens: response.usage.outputTokenDetails?.reasoningTokens,
      cachedInputTokens: response.usage.inputTokenDetails?.cacheReadTokens,
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

  console.warn("[summarization] response:", JSON.stringify(response, null, 2));

  if (!response.output) {
    throw new Error("Summarization output missing");
  }

  const parsed = v.parse(summarySchema, response.output);

  return {
    result: parsed,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      reasoningTokens: response.usage.outputTokenDetails?.reasoningTokens,
      cachedInputTokens: response.usage.inputTokenDetails?.cacheReadTokens,
    },
  };
}

function normalizeKeywords(keywords?: string[]): string[] {
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

    if (normalized.length === SUMMARY_KEYWORD_LIMIT) {
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
    tone = "neutral",
    includeTranscript = true,
    cleanTranscript = true,
    imageSubmissionMode = "url",
    imageDownloadOptions,
    promptOverrides,
    credentials,
  } = options ?? {};

  // Validate tone parameter
  if (!VALID_TONES.includes(tone)) {
    throw new Error(
      `Invalid tone "${tone}". Valid tones are: ${VALID_TONES.join(", ")}`,
    );
  }

  const modelConfig = resolveLanguageModelConfig({
    ...options,
    model,
    provider: provider as SupportedProvider,
  });

  // Fetch asset data from Mux and grab playback/transcript details
  const { asset: assetData, playbackId, policy } = await getPlaybackIdForAsset(assetId, credentials);

  // Detect if asset is audio-only
  const isAudioOnly = isAudioOnlyAsset(assetData);

  // Audio-only assets require transcripts since there's no visual content
  if (isAudioOnly && !includeTranscript) {
    throw new Error(
      "Audio-only assets require a transcript. Set includeTranscript: true and ensure the asset has a ready text track (captions/subtitles).",
    );
  }

  // Resolve signing context for signed playback IDs
  const signingContext = await resolveMuxSigningContext(credentials);
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. " +
      "Provide muxSigningKey and muxPrivateKey in options or set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  const transcriptText =
    includeTranscript ?
        (await fetchTranscriptForAsset(assetData, playbackId, {
          cleanTranscript,
          shouldSign: policy === "signed",
          credentials,
          required: isAudioOnly,
        })).transcriptText :
      "";

  // Build the user prompt with all context and any overrides
  const userPrompt = buildUserPrompt({
    tone,
    transcriptText,
    isCleanTranscript: cleanTranscript,
    promptOverrides,
    isAudioOnly,
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
        credentials,
      );
    } else {
      // Video analysis: fetch storyboard and analyze with visual content
      const storyboardUrl = await getStoryboardUrl(playbackId, 640, policy === "signed", credentials);
      imageUrl = storyboardUrl;

      if (imageSubmissionMode === "base64") {
        const downloadResult = await downloadImageAsBase64(storyboardUrl, imageDownloadOptions);
        analysisResponse = await analyzeStoryboard(
          downloadResult.base64Data,
          modelConfig.provider,
          modelConfig.modelId,
          userPrompt,
          systemPrompt,
          credentials,
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
            credentials,
          ));
      }
    }
  } catch (error: unknown) {
    const contentType = isAudioOnly ? "audio" : "video";
    throw new Error(
      `Failed to analyze ${contentType} content with ${provider}: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }

  if (!analysisResponse.result) {
    throw new Error(`Failed to analyze video content for asset ${assetId}`);
  }

  if (!analysisResponse.result.title) {
    throw new Error(`Failed to generate title for asset ${assetId}`);
  }

  if (!analysisResponse.result.description) {
    throw new Error(`Failed to generate description for asset ${assetId}`);
  }

  return {
    assetId,
    title: analysisResponse.result.title,
    description: analysisResponse.result.description,
    tags: normalizeKeywords(analysisResponse.result.keywords),
    storyboardUrl: imageUrl, // undefined for audio-only assets
    usage: analysisResponse.usage,
    transcriptText: transcriptText || undefined,
  };
}
