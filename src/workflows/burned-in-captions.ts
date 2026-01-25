import { valibotSchema } from "@ai-sdk/valibot";
import { generateText, Output } from "ai";
import dedent from "dedent";
import * as v from "valibot";

import type { ImageDownloadOptions } from "@mux/ai/lib/image-download";
import { downloadImageAsBase64 } from "@mux/ai/lib/image-download";
import { getPlaybackIdForAsset } from "@mux/ai/lib/mux-assets";
import type { PromptOverrides } from "@mux/ai/lib/prompt-builder";
import { createPromptBuilder } from "@mux/ai/lib/prompt-builder";
import { createLanguageModelFromConfig, resolveLanguageModelConfig } from "@mux/ai/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "@mux/ai/lib/providers";
import { getStoryboardUrl } from "@mux/ai/primitives/storyboards";
import type {
  ImageSubmissionMode,
  MuxAIOptions,
  TokenUsage,
  WorkflowCredentialsInput,
} from "@mux/ai/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Structured payload returned from `hasBurnedInCaptions`. */
export interface BurnedInCaptionsResult {
  assetId: string;
  hasBurnedInCaptions: boolean;
  confidence: number;
  detectedLanguage: string | null;
  storyboardUrl: string;
  /** Token usage from the AI provider (for efficiency/cost analysis). */
  usage?: TokenUsage;
}

/**
 * Sections of the burned-in captions user prompt that can be overridden.
 * Use these to customize the AI's behavior for your specific use case.
 */
export type BurnedInCaptionsPromptSections =
  "task" |
  "analysisSteps" |
  "positiveIndicators" |
  "negativeIndicators";

/**
 * Override specific sections of the burned-in captions prompt.
 * Each key corresponds to a section that can be customized.
 *
 * @example
 * ```typescript
 * const result = await hasBurnedInCaptions(assetId, {
 *   promptOverrides: {
 *     task: 'Detect any text overlays in the video frames.',
 *     positiveIndicators: 'Classify as captions if text appears consistently.',
 *   },
 * });
 * ```
 */
export type BurnedInCaptionsPromptOverrides = PromptOverrides<BurnedInCaptionsPromptSections>;

/** Configuration accepted by `hasBurnedInCaptions`. */
export interface BurnedInCaptionsOptions extends MuxAIOptions {
  /** AI provider used for storyboard inspection (defaults to 'openai'). */
  provider?: SupportedProvider;
  /** Provider-specific model identifier. */
  model?: ModelIdByProvider[SupportedProvider];
  /** Transport used for storyboard submission (defaults to 'url'). */
  imageSubmissionMode?: ImageSubmissionMode;
  /** Download tuning used when `imageSubmissionMode` === 'base64'. */
  imageDownloadOptions?: ImageDownloadOptions;
  /**
   * Override specific sections of the user prompt.
   * Useful for customizing the AI's detection criteria for specific use cases.
   */
  promptOverrides?: BurnedInCaptionsPromptOverrides;
}

/** Schema used to validate burned-in captions analysis responses. */
export const burnedInCaptionsSchema = v.strictObject({
  hasBurnedInCaptions: v.pipe(
    v.boolean(),
    v.description("Whether burned-in captions are detected."),
  ),
  confidence: v.pipe(
    v.number(),
    v.description("Confidence score between 0 and 1."),
  ),
  detectedLanguage: v.pipe(
    v.nullable(v.string()),
    v.description("Detected language of captions, if any."),
  ),
});

/** Inferred shape returned from the burned-in captions schema. */
export type BurnedInCaptionsAnalysis = v.InferOutput<typeof burnedInCaptionsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = dedent`
  <role>
    You are an expert at analyzing video frames to detect burned-in captions (also called open captions or hardcoded subtitles).
    These are text overlays that are permanently embedded in the video image, common on TikTok, Instagram Reels, and other social media platforms.
  </role>

  <critical_note>
    Burned-in captions must appear consistently across MOST frames in the storyboard.
    Text appearing in only 1-2 frames at the end is typically marketing copy, taglines, or end-cards - NOT burned-in captions.
  </critical_note>

  <confidence_scoring>
    Use this rubric to determine your confidence score (0.0-1.0):

    - Score 1.0: Definitive captions - text overlays visible in most frames, consistent positioning, content changes between frames indicating dialogue/narration, clear caption-style formatting
    - Score 0.7-0.9: Strong evidence - captions visible across multiple frames with consistent placement, but minor ambiguity (e.g., some frames unclear, atypical styling)
    - Score 0.4-0.6: Moderate evidence - text present in several frames but uncertain classification (e.g., could be captions or persistent on-screen graphics, ambiguous formatting)
    - Score 0.1-0.3: Weak evidence - minimal text detected, appears in only a few frames, likely marketing copy or end-cards rather than captions
    - Score 0.0: No captions - no text overlays detected, or text is clearly not captions (logos, watermarks, scene content, single end-card)
  </confidence_scoring>

  <context>
    You receive storyboard images containing multiple sequential frames extracted from a video.
    These frames are arranged in a grid and represent the visual progression of the content over time.
    Read frames left-to-right, top-to-bottom to understand the temporal sequence.
  </context>

  <capabilities>
    - Detect and analyze text overlays in video frames
    - Distinguish between captions and other text elements (marketing, logos, UI)
    - Identify language of detected caption text
    - Assess confidence in caption detection
  </capabilities>

  <constraints>
    - Only classify as burned-in captions when evidence is clear across multiple frames
    - Base decisions on observable visual evidence
    - Return structured data matching the requested schema
  </constraints>`;

/**
 * Prompt builder for the burned-in captions user prompt.
 * Sections can be individually overridden via `promptOverrides` in BurnedInCaptionsOptions.
 */
const burnedInCaptionsPromptBuilder = createPromptBuilder<BurnedInCaptionsPromptSections>({
  template: {
    task: {
      tag: "task",
      content: dedent`
        Analyze the provided video storyboard to detect burned-in captions (hardcoded subtitles).
        Count frames with text vs no text, note position consistency and whether text changes across frames.
        Decide if captions exist, with confidence (0.0-1.0) and detected language if any.`,
    },
    analysisSteps: {
      tag: "analysis_steps",
      content: dedent`
        1. COUNT how many frames contain text overlays vs. how many don't
        2. Check if text appears in consistent positions across multiple frames
        3. Verify text changes content between frames (indicating dialogue/narration)
        4. Ensure text has caption-style formatting (contrasting colors, readable fonts)
        5. If captions are detected, identify the language of the text`,
    },
    positiveIndicators: {
      tag: "classify_as_captions",
      content: dedent`
        ONLY classify as burned-in captions if:
        - Text appears in multiple frames (not just 1-2 end frames)
        - Text positioning is consistent across those frames
        - Content suggests dialogue, narration, or subtitles (not marketing)
        - Formatting looks like captions (not graphics/logos)`,
    },
    negativeIndicators: {
      tag: "not_captions",
      content: dedent`
        DO NOT classify as burned-in captions:
        - Marketing taglines appearing only in final 1-2 frames
        - Single words or phrases that don't change between frames
        - Graphics, logos, watermarks, or UI elements
        - Text that's part of the original scene content
        - End-cards with calls-to-action or brand messaging`,
    },
  },
  sectionOrder: ["task", "analysisSteps", "positiveIndicators", "negativeIndicators"],
});

function buildUserPrompt(promptOverrides?: BurnedInCaptionsPromptOverrides): string {
  return burnedInCaptionsPromptBuilder.build(promptOverrides);
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_PROVIDER = "openai";

interface AnalysisResponse {
  result: BurnedInCaptionsAnalysis;
  usage: TokenUsage;
}

async function fetchImageAsBase64(
  imageUrl: string,
  imageDownloadOptions?: ImageDownloadOptions,
): Promise<string> {
  "use step";

  const downloadResult = await downloadImageAsBase64(imageUrl, imageDownloadOptions);
  return downloadResult.base64Data;
}

async function analyzeStoryboard({
  imageDataUrl,
  provider,
  modelId,
  userPrompt,
  systemPrompt,
  credentials,
}: {
  imageDataUrl: string;
  provider: SupportedProvider;
  modelId: string;
  userPrompt: string;
  systemPrompt: string;
  credentials?: WorkflowCredentialsInput;
}): Promise<AnalysisResponse> {
  "use step";

  const model = await createLanguageModelFromConfig(provider, modelId, credentials);

  const response = await generateText({
    model,
    output: Output.object({ schema: valibotSchema(burnedInCaptionsSchema) }),
    experimental_telemetry: { isEnabled: true },
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
    result: {
      ...response.output,
      confidence: Math.min(1, Math.max(0, response.output.confidence)),
    },
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      reasoningTokens: response.usage.outputTokenDetails.reasoningTokens,
      cachedInputTokens: response.usage.inputTokenDetails.cacheReadTokens,
    },
  };
}

export async function hasBurnedInCaptions(
  assetId: string,
  options: BurnedInCaptionsOptions = {},
): Promise<BurnedInCaptionsResult> {
  "use workflow";
  const {
    provider = DEFAULT_PROVIDER,
    model,
    imageSubmissionMode = "url",
    imageDownloadOptions,
    promptOverrides,
    credentials,
    ...config
  } = options;

  // Build the user prompt with any overrides
  const userPrompt = buildUserPrompt(promptOverrides);

  const modelConfig = resolveLanguageModelConfig({
    ...config,
    model,
    provider: provider as SupportedProvider,
  });
  const { playbackId, policy } = await getPlaybackIdForAsset(assetId, credentials);

  const imageUrl = await getStoryboardUrl(playbackId, 640, policy === "signed", credentials);

  let analysisResponse: AnalysisResponse;

  if (imageSubmissionMode === "base64") {
    const base64Data = await fetchImageAsBase64(imageUrl, imageDownloadOptions);
    analysisResponse = await analyzeStoryboard({
      imageDataUrl: base64Data,
      provider: modelConfig.provider,
      modelId: modelConfig.modelId,
      userPrompt,
      systemPrompt: SYSTEM_PROMPT,
      credentials,
    });
  } else {
    analysisResponse = await analyzeStoryboard({
      imageDataUrl: imageUrl,
      provider: modelConfig.provider,
      modelId: modelConfig.modelId,
      userPrompt,
      systemPrompt: SYSTEM_PROMPT,
      credentials,
    });
  }

  if (!analysisResponse.result) {
    throw new Error("No analysis result received from AI provider");
  }

  return {
    assetId,
    hasBurnedInCaptions: analysisResponse.result.hasBurnedInCaptions ?? false,
    confidence: analysisResponse.result.confidence ?? 0,
    detectedLanguage: analysisResponse.result.detectedLanguage ?? null,
    storyboardUrl: imageUrl,
    usage: analysisResponse.usage,
  };
}
