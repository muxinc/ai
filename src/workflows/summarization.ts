import { generateObject } from "ai";
import dedent from "dedent";
import { z } from "zod";

import { createWorkflowConfig } from "../lib/client-factory";
import type { WorkflowConfig } from "../lib/client-factory";
import type { ImageDownloadOptions } from "../lib/image-download";
import { downloadImageAsBase64 } from "../lib/image-download";
import { getPlaybackIdForAsset } from "../lib/mux-assets";
import type {
  PromptOverrides,
} from "../lib/prompt-builder";
import {
  createPromptBuilder,
  createToneSection,
  createTranscriptSection,
} from "../lib/prompt-builder";
import { createLanguageModelFromConfig } from "../lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "../lib/providers";
import { resolveSigningContext } from "../lib/url-signing";
import { getStoryboardUrl } from "../primitives/storyboards";
import { fetchTranscriptForAsset } from "../primitives/transcripts";
import type { ImageSubmissionMode, MuxAIOptions, TokenUsage, ToneType } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export const SUMMARY_KEYWORD_LIMIT = 10;

export const summarySchema = z.object({
  keywords: z.array(z.string()),
  title: z.string(),
  description: z.string(),
});

export type SummaryType = z.infer<typeof summarySchema>;

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
  /** Storyboard image URL that was analyzed. */
  storyboardUrl: string;
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
  /** Prompt tone shim applied to the system instruction (defaults to 'normal'). */
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

const TONE_INSTRUCTIONS: Record<ToneType, string> = {
  normal: "Provide a clear, straightforward analysis.",
  sassy: "Answer with a sassy, playful attitude and personality.",
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
        Specific, searchable terms (up to 10) that capture:
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
  </constraints>

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

interface UserPromptContext {
  tone: ToneType;
  transcriptText?: string;
  isCleanTranscript?: boolean;
  promptOverrides?: SummarizationPromptOverrides;
}

function buildUserPrompt({
  tone,
  transcriptText,
  isCleanTranscript = true,
  promptOverrides,
}: UserPromptContext): string {
  // Build dynamic context sections
  const contextSections = [createToneSection(TONE_INSTRUCTIONS[tone])];

  if (transcriptText) {
    const format = isCleanTranscript ? "plain text" : "WebVTT";
    contextSections.push(createTranscriptSection(transcriptText, format));
  }

  return summarizationPromptBuilder.buildWithContext(promptOverrides, contextSections);
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
  workflowConfig: WorkflowConfig,
  userPrompt: string,
  systemPrompt: string,
): Promise<AnalysisResponse> {
  "use step";
  const model = createLanguageModelFromConfig(
    workflowConfig.provider,
    workflowConfig.modelId,
    workflowConfig.credentials,
  );

  const response = await generateObject({
    model,
    schema: summarySchema,
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

  return {
    result: response.object,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      reasoningTokens: response.usage.reasoningTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
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
    tone = "normal",
    includeTranscript = true,
    cleanTranscript = true,
    imageSubmissionMode = "url",
    imageDownloadOptions,
    abortSignal,
    promptOverrides,
  } = options ?? {};

  // Validate credentials and resolve language model
  const config = await createWorkflowConfig(
    { ...options, model },
    provider as SupportedProvider,
  );

  // Fetch asset data from Mux and grab playback/transcript details
  const { asset: assetData, playbackId, policy } = await getPlaybackIdForAsset(config.credentials, assetId);

  // Resolve signing context for signed playback IDs
  const signingContext = await resolveSigningContext(options ?? {});
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
          signingContext: policy === "signed" ? signingContext : undefined,
        })).transcriptText :
      "";

  // Build the user prompt with all context and any overrides
  const userPrompt = buildUserPrompt({
    tone,
    transcriptText,
    isCleanTranscript: cleanTranscript,
    promptOverrides,
  });

  // Analyze storyboard with AI provider (signed if needed)
  const imageUrl = await getStoryboardUrl(playbackId, 640, policy === "signed" ? signingContext : undefined);

  let analysisResponse: AnalysisResponse;

  try {
    if (imageSubmissionMode === "base64") {
      const downloadResult = await downloadImageAsBase64(imageUrl, imageDownloadOptions);
      analysisResponse = await analyzeStoryboard(
        downloadResult.base64Data,
        config,
        userPrompt,
        SYSTEM_PROMPT,
      );
    } else {
      // URL-based submission with retry logic
      analysisResponse = await analyzeStoryboard(imageUrl, config, userPrompt, SYSTEM_PROMPT);
    }
  } catch (error: unknown) {
    throw new Error(
      `Failed to analyze video content with ${provider}: ${
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
    storyboardUrl: imageUrl,
    usage: analysisResponse.usage,
    transcriptText: transcriptText || undefined,
  };
}
