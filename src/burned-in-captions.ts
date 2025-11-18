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

const SYSTEM_PROMPT = `You are an expert at analyzing video frames to detect burned-in captions (also called open captions or hardcoded subtitles). These are text overlays permanently embedded in video images, common on social media platforms.

Key principles:
1. Burned-in captions appear across multiple frames throughout the video timeline
2. End-cards and marketing text appear only in final frames
3. Captions have consistent positioning and caption-style formatting
4. Caption text typically changes between frames (dialogue/narration)

Analysis approach:
- Look for text overlays distributed across different parts of the timeline
- Distinguish between dialogue captions vs. marketing end-cards
- Consider text positioning, formatting, and content patterns`;

const USER_PROMPT = `Analyze this storyboard for burned-in captions:

1. Examine each frame from left to right (timeline order)
2. Note which frames have text overlays and their positions
3. Determine the pattern:
   - Text scattered across timeline = likely captions
   - Text only in final 1-2 frames = likely end-card/marketing

Classification rules:
- If text appears in 3+ frames distributed throughout timeline → burned-in captions
- If text appears only in final frames → NOT burned-in captions
- Look for dialogue-style content vs. marketing taglines

Analyze and classify with confidence level.`;

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