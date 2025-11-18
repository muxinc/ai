import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { MuxAIOptions } from './types';
import { ImageDownloadOptions } from './utils/image-download';
import { 
  getAssetInfo, 
  processStoryboardWithOpenAI, 
  processStoryboardWithAnthropic,
  StoryboardProcessorOptions 
} from './utils/storyboard-processor';

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

const DEFAULT_SYSTEM_PROMPT = `You are an expert at analyzing video frames to detect burned-in captions (also called open captions or hardcoded subtitles). These are text overlays that are permanently embedded in the video image, common on TikTok, Instagram Reels, and other social media platforms.

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

const ANTHROPIC_SYSTEM_PROMPT = `You are an expert at analyzing video frames to detect burned-in captions (also called open captions or hardcoded subtitles). These are text overlays permanently embedded in video images, common on social media platforms.

Key principles:
1. Burned-in captions appear across multiple frames throughout the video timeline
2. End-cards and marketing text appear only in final frames
3. Captions have consistent positioning and caption-style formatting
4. Caption text typically changes between frames (dialogue/narration)

Analysis approach:
- Look for text overlays distributed across different parts of the timeline
- Distinguish between dialogue captions vs. marketing end-cards
- Consider text positioning, formatting, and content patterns`;

const DEFAULT_USER_PROMPT = `Analyze this video storyboard for burned-in captions. Follow this systematic approach:

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

const ANTHROPIC_USER_PROMPT = `Analyze this storyboard for burned-in captions:

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

const ANTHROPIC_JSON_PROMPT = `Apply the frame analysis above.

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
    muxTokenId,
    muxTokenSecret,
    openaiApiKey,
    anthropicApiKey,
    ...config
  } = options;

  // Set default models based on provider
  const defaultModel = provider === 'anthropic' ? 'claude-3-5-haiku-20241022' : 'gpt-4o-mini';
  const finalModel = model || defaultModel;

  // Validate required credentials
  const openaiKey = openaiApiKey || process.env.OPENAI_API_KEY;
  const anthropicKey = anthropicApiKey || process.env.ANTHROPIC_API_KEY;

  if (provider === 'openai' && !openaiKey) {
    throw new Error('OpenAI API key is required for OpenAI provider. Provide openaiApiKey in options or set OPENAI_API_KEY environment variable.');
  }

  if (provider === 'anthropic' && !anthropicKey) {
    throw new Error('Anthropic API key is required for Anthropic provider. Provide anthropicApiKey in options or set ANTHROPIC_API_KEY environment variable.');
  }

  // Get asset information
  const storyboardOptions: StoryboardProcessorOptions = {
    muxTokenId,
    muxTokenSecret,
    openaiApiKey,
    anthropicApiKey,
    imageSubmissionMode,
    imageDownloadOptions
  };

  const assetInfo = await getAssetInfo(assetId, storyboardOptions);
  const imageUrl = `https://image.mux.com/${assetInfo.playbackId}/storyboard.png?width=640`;

  let analysisResult: { hasBurnedInCaptions?: boolean; confidence?: number; detectedLanguage?: string | null } | null = null;

  if (provider === 'openai') {
    // Handle OpenAI with structured outputs directly
    const OpenAI = require('openai').default;
    const openaiClient = new OpenAI({ apiKey: openaiKey });

    if (imageSubmissionMode === 'base64') {
      const { downloadImageAsBase64 } = require('./utils/image-download');
      const downloadResult = await downloadImageAsBase64(imageUrl, imageDownloadOptions);
      
      const response = await openaiClient.responses.parse({
        model: finalModel,
        input: [
          {
            role: "system",
            content: ANTHROPIC_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: ANTHROPIC_USER_PROMPT,
              },
              {
                type: "input_image",
                image_url: downloadResult.base64Data,
                detail: "high",
              },
            ],
          },
        ],
        text: {
          format: zodTextFormat(burnedInCaptionsSchema, "analysis"),
        },
      });

      analysisResult = response.output_parsed;
    } else {
      // URL-based submission with retry logic for structured outputs
      let retryAttempt = 0;
      const maxRetries = 3;

      while (retryAttempt <= maxRetries) {
        try {
          const response = await openaiClient.responses.parse({
            model: finalModel,
            input: [
              {
                role: "system",
                content: ANTHROPIC_SYSTEM_PROMPT,
              },
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: ANTHROPIC_USER_PROMPT,
                  },
                  {
                    type: "input_image",
                    image_url: imageUrl,
                    detail: "high",
                  },
                ],
              },
            ],
            text: {
              format: zodTextFormat(burnedInCaptionsSchema, "analysis"),
            },
          });

          analysisResult = response.output_parsed;
          break;
          
        } catch (error: unknown) {
          const isTimeoutError = error instanceof Error && error.message && error.message.includes('Timeout while downloading');
          
          if (isTimeoutError && retryAttempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            retryAttempt++;
            continue;
          }
          
          throw new Error(`Failed to analyze storyboard with OpenAI: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    }
  } else if (provider === 'anthropic') {
    const anthropicPrompt = `${ANTHROPIC_USER_PROMPT}

${ANTHROPIC_JSON_PROMPT}`;

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

    analysisResult = await processStoryboardWithAnthropic(
      imageUrl,
      anthropicPrompt,
      {
        apiKey: anthropicKey!,
        model: finalModel,
        responseParser,
        imageSubmissionMode,
        imageDownloadOptions
      }
    );
  } else {
    throw new Error(`Unsupported provider: ${provider}`);
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