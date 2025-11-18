import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { MuxAIOptions } from './types';
import { ImageDownloadOptions, downloadImageAsBase64 } from './utils/image-download';
import {
  getAssetInfo,
  processStoryboardWithOpenAI,
  processStoryboardWithAnthropic,
  StoryboardProcessorOptions
} from './utils/storyboard-processor';
import { getDefaultModel, validateProvider } from './lib/provider-models';
import { withRetry } from './lib/retry';

export interface BurnedInCaptionsResult {
  assetId: string;
  hasBurnedInCaptions: boolean;
  confidence: number;
  detectedLanguage: string | null;
  storyboardUrl?: string;
}

export interface BurnedInCaptionsOptions extends MuxAIOptions {
  provider?: 'openai' | 'anthropic';
  model?: string;
  /** Method for submitting storyboard to AI providers (default: 'url') */
  imageSubmissionMode?: 'url' | 'base64';
  /** Options for image download when using base64 submission mode */
  imageDownloadOptions?: ImageDownloadOptions;
}

const burnedInCaptionsSchema = z.object({
  hasBurnedInCaptions: z.boolean(),
  confidence: z.number().min(0).max(1),
  detectedLanguage: z.string().nullable()
});

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

If you detect burned-in captions, try to identify the language of the text.`;

const USER_PROMPT = `Analyze this video storyboard for burned-in captions. Follow this systematic approach:

STEP 1: Count the frames
- How many total frames are shown in this storyboard?
- How many frames contain any text overlays?
- What percentage of frames contain text?

STEP 2: Analyze text consistency
- If text is present, does it appear in the same position across multiple frames?
- Does the text content change between frames (suggesting dialogue)?
- Or is it the same text in just 1-2 frames (suggesting marketing/end-card)?

STEP 3: Classification
- Are there burned-in captions (text overlaid that appears to be subtitles/captions)?
- How confident are you (0.0 to 1.0)? Be decisive and accurate:
  * If clear dialogue/caption text across multiple frames → 0.8+ confidence, TRUE
  * If ONLY marketing text in final frames → 0.0 confidence, FALSE
  * If truly uncertain → 0.3-0.5 confidence
- If captions are present, what language?

REMEMBER: Marketing taglines in final frames = NOT captions (0.0 confidence, FALSE). Dialogue text across timeline = captions (0.8+ confidence, TRUE).

Respond with your analysis.`;

const JSON_FORMAT_PROMPT = `Apply the frame analysis above.

Key rule: Text appearing only in final 2-3 frames = NOT captions. Text distributed throughout timeline = captions.

Respond ONLY with valid JSON:
{
  "hasBurnedInCaptions": true/false,
  "confidence": 0.85,
  "detectedLanguage": "English" (or null if no captions or language unclear)
}

Do not include any text before or after the JSON. The JSON must be valid and parseable.`;

export async function hasBurnedInCaptions(
  assetId: string,
  options: BurnedInCaptionsOptions = {}
): Promise<BurnedInCaptionsResult> {
  const {
    provider = 'openai',
    model,
    imageSubmissionMode = 'url',
    imageDownloadOptions,
  } = options;

  // Validate provider and get default model
  validateProvider(provider);
  const finalModel = model || getDefaultModel(provider);

  // Get asset information
  const storyboardOptions: StoryboardProcessorOptions = {
    ...options,
    imageSubmissionMode,
    imageDownloadOptions
  };

  const assetInfo = await getAssetInfo(assetId, storyboardOptions);
  const imageUrl = `https://image.mux.com/${assetInfo.playbackId}/storyboard.png?width=640`;

  let analysisResult: { hasBurnedInCaptions?: boolean; confidence?: number; detectedLanguage?: string | null } | null = null;

  // Get API keys from options or environment
  const openaiKey = options.openaiApiKey || process.env.OPENAI_API_KEY;
  const anthropicKey = options.anthropicApiKey || process.env.ANTHROPIC_API_KEY;

  if (provider === 'openai') {
    if (!openaiKey) {
      throw new Error('OpenAI API key is required for OpenAI provider. Provide openaiApiKey in options or set OPENAI_API_KEY environment variable.');
    }

    // Handle OpenAI with structured outputs directly
    const openaiClient = new OpenAI({ apiKey: openaiKey });

    const analyzeWithOpenAI = async (imageDataUrl: string) => {
      return await openaiClient.responses.parse({
        model: finalModel,
        input: [
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: USER_PROMPT,
              },
              {
                type: "input_image",
                image_url: imageDataUrl,
                detail: "high",
              },
            ],
          },
        ],
        text: {
          format: zodTextFormat(burnedInCaptionsSchema, "analysis"),
        },
      });
    };

    try {
      if (imageSubmissionMode === 'base64') {
        const downloadResult = await downloadImageAsBase64(imageUrl, imageDownloadOptions);
        const response = await analyzeWithOpenAI(downloadResult.base64Data);
        analysisResult = response.output_parsed;
      } else {
        // URL-based submission with retry logic
        const response = await withRetry(() => analyzeWithOpenAI(imageUrl));
        analysisResult = response.output_parsed;
      }
    } catch (error: unknown) {
      throw new Error(`Failed to analyze storyboard with OpenAI: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else if (provider === 'anthropic') {
    if (!anthropicKey) {
      throw new Error('Anthropic API key is required for Anthropic provider. Provide anthropicApiKey in options or set ANTHROPIC_API_KEY environment variable.');
    }

    const anthropicPrompt = `${USER_PROMPT}

${JSON_FORMAT_PROMPT}`;

    const responseParser = (response: any) => {
      const content = response.content[0];
      if (content.type === 'text') {
        const jsonText = content.text.trim();
        try {
          return JSON.parse(jsonText);
        } catch (parseError) {
          throw new Error(`Failed to parse JSON response from Anthropic: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
        }
      } else {
        throw new Error('Unexpected response type from Anthropic');
      }
    };

    try {
      analysisResult = await processStoryboardWithAnthropic(
        imageUrl,
        anthropicPrompt,
        {
          apiKey: anthropicKey,
          model: finalModel,
          responseParser,
          imageSubmissionMode,
          imageDownloadOptions
        }
      );
    } catch (error: unknown) {
      throw new Error(`Failed to analyze storyboard with Anthropic: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  if (!analysisResult) {
    throw new Error('No analysis result received from AI provider');
  }

  return {
    assetId,
    hasBurnedInCaptions: analysisResult.hasBurnedInCaptions ?? false,
    confidence: analysisResult.confidence ?? 0,
    detectedLanguage: analysisResult.detectedLanguage ?? null,
    storyboardUrl: imageUrl,
  };
}