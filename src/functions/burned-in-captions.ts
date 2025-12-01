import { generateObject } from "ai";
import { z } from "zod";

import type { ImageDownloadOptions } from "../lib/image-download";
import type { ModelIdByProvider, SupportedProvider } from "../lib/providers";
import type { ImageSubmissionMode, MuxAIOptions } from "../types";

import { createWorkflowClients } from "../lib/client-factory";
import { downloadImageAsBase64 } from "../lib/image-download";
import { getPlaybackIdForAsset } from "../lib/mux-assets";
import { resolveSigningContext } from "../lib/url-signing";
import { getStoryboardUrl } from "../primitives/storyboards";

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
}

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
}

/** Schema used to validate burned-in captions analysis responses. */
export const burnedInCaptionsSchema = z.object({
  hasBurnedInCaptions: z.boolean(),
  confidence: z.number().min(0).max(1),
  detectedLanguage: z.string().nullable(),
});

/** Inferred shape returned from the burned-in captions schema. */
export type BurnedInCaptionsAnalysis = z.infer<typeof burnedInCaptionsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PROVIDER = "openai";

const SYSTEM_PROMPT = `You are an expert at analyzing video frames to detect burned-in captions (also called open captions or hardcoded subtitles). These are text overlays that are permanently embedded in the video image, common on TikTok, Instagram Reels, and other social media platforms.

CRITICAL: Burned-in captions must appear consistently across MOST frames in the storyboard. Text appearing in only 1-2 frames at the end is typically marketing copy, taglines, or end-cards - NOT burned-in captions.

Analyze the provided video storyboard by:
1. COUNT how many frames contain text overlays vs. how many don't
2. Check if text appears in consistent positions across multiple frames
3. Verify text changes content between frames (indicating dialogue/narration)
4. Ensure text has caption-style formatting (contrasting colors, readable fonts)

ONLY classify as burned-in captions if:
- Text appears in multiple frames (not just 1-2 end frames)
- Text positioning is consistent across those frames
- Content suggests dialogue, narration, or subtitles (not marketing)
- Formatting looks like captions (not graphics/logos)

DO NOT classify as burned-in captions:
- Marketing taglines appearing only in final 1-2 frames
- Single words or phrases that don't change between frames
- Graphics, logos, watermarks, or UI elements
- Text that's part of the original scene content
- End-cards with calls-to-action or brand messaging

If you detect burned-in captions, try to identify the language of the text, and classify whether burned-in captions are present in the storyboard.`;

const USER_PROMPT = `Analyze this storyboard:
- Count frames with text vs no text.
- Note position consistency and whether text changes across frames.
- Decide if captions exist, with confidence (0.0-1.0) and detected language if any.`;

export async function hasBurnedInCaptions(
  assetId: string,
  options: BurnedInCaptionsOptions = {},
): Promise<BurnedInCaptionsResult> {
  const {
    provider = DEFAULT_PROVIDER,
    model,
    imageSubmissionMode = "url",
    imageDownloadOptions,
    ...config
  } = options;

  const clients = createWorkflowClients(
    { ...config, model },
    provider as SupportedProvider,
  );
  const { playbackId, policy } = await getPlaybackIdForAsset(clients.mux, assetId);

  // Resolve signing context for signed playback IDs
  const signingContext = resolveSigningContext(options);
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. "
      + "Provide muxSigningKey and muxPrivateKey in options or set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  const imageUrl = await getStoryboardUrl(playbackId, 640, policy === "signed" ? signingContext : undefined);

  let analysisResult: BurnedInCaptionsAnalysis | null = null;

  const analyzeStoryboard = async (imageDataUrl: string) => {
    const response = await generateObject({
      model: clients.languageModel.model,
      schema: burnedInCaptionsSchema,
      abortSignal: options.abortSignal,
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: [
            { type: "text", text: USER_PROMPT },
            { type: "image", image: imageDataUrl },
          ],
        },
      ],
    });

    return response.object;
  };

  if (imageSubmissionMode === "base64") {
    const downloadResult = await downloadImageAsBase64(imageUrl, imageDownloadOptions);
    analysisResult = await analyzeStoryboard(downloadResult.base64Data);
  }
  else {
    analysisResult = await analyzeStoryboard(imageUrl);
  }

  if (!analysisResult) {
    throw new Error("No analysis result received from AI provider");
  }

  return {
    assetId,
    hasBurnedInCaptions: analysisResult.hasBurnedInCaptions ?? false,
    confidence: analysisResult.confidence ?? 0,
    detectedLanguage: analysisResult.detectedLanguage ?? null,
    storyboardUrl: imageUrl,
  };
}
