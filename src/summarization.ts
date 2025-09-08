import Mux from '@mux/mux-node';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { MuxAIOptions, ToneType } from './types';

export interface SummaryAndTagsResult {
  assetId: string;
  title: string;
  description: string;
  tags: string[];
  storyboardUrl?: string;
}

export interface SummarizationOptions extends MuxAIOptions {
  provider?: 'openai' | 'anthropic';
  model?: string;
  maxSummaryLength?: number;
  maxTags?: number;
  customPrompt?: string;
  tone?: ToneType;
  includeTranscript?: boolean;
}

const summarySchema = z.object({
  keywords: z.array(z.string()).max(10),
  title: z.string().max(100),
  description: z.string().max(1000)
});

const DEFAULT_PROMPT = "Generate a short title (max 100 characters) and description (max 500 characters) for what happens. Start immediately with the action or subject - never reference that this is a video, content, or storyboard. Example: Title: 'Cooking Pasta Tutorial' Description: 'Someone cooks pasta by boiling water and adding noodles.'";

const ANTHROPIC_JSON_PROMPT = `You must respond with valid JSON in exactly this format:
{
  "title": "Your title here (max 100 characters)",
  "description": "Your description here (max 500 characters)",
  "keywords": ["keyword1", "keyword2", "keyword3"]
}

Do not include any text before or after the JSON. The JSON must be valid and parseable.`;

export async function getSummaryAndTags(
  assetId: string,
  promptOrOptions?: string | SummarizationOptions,
  options?: SummarizationOptions
): Promise<SummaryAndTagsResult> {
  // Handle overloaded parameters
  let prompt: string;
  let actualOptions: SummarizationOptions;
  
  if (typeof promptOrOptions === 'string') {
    prompt = promptOrOptions;
    actualOptions = options || {};
  } else {
    prompt = DEFAULT_PROMPT;
    actualOptions = promptOrOptions || {};
  }
  const {
    provider = 'openai',
    model,
    tone = 'normal',
    includeTranscript = true,
    muxTokenId,
    muxTokenSecret,
    openaiApiKey,
    anthropicApiKey,
    ...config
  } = actualOptions;

  // Set default models based on provider
  const defaultModel = provider === 'anthropic' ? 'claude-3-5-haiku-20241022' : 'gpt-4o-mini';
  const finalModel = model || defaultModel;

  // Validate required credentials
  const muxId = muxTokenId || process.env.MUX_TOKEN_ID;
  const muxSecret = muxTokenSecret || process.env.MUX_TOKEN_SECRET;
  const openaiKey = openaiApiKey || process.env.OPENAI_API_KEY;
  const anthropicKey = anthropicApiKey || process.env.ANTHROPIC_API_KEY;

  if (!muxId || !muxSecret) {
    throw new Error('Mux credentials are required. Provide muxTokenId and muxTokenSecret in options or set MUX_TOKEN_ID and MUX_TOKEN_SECRET environment variables.');
  }

  if (provider === 'openai' && !openaiKey) {
    throw new Error('OpenAI API key is required. Provide openaiApiKey in options or set OPENAI_API_KEY environment variable.');
  }

  if (provider === 'anthropic' && !anthropicKey) {
    throw new Error('Anthropic API key is required. Provide anthropicApiKey in options or set ANTHROPIC_API_KEY environment variable.');
  }

  // Initialize clients
  const mux = new Mux({
    tokenId: muxId,
    tokenSecret: muxSecret,
  });

  let openaiClient: OpenAI | undefined;
  let anthropicClient: Anthropic | undefined;

  if (provider === 'openai') {
    openaiClient = new OpenAI({
      apiKey: openaiKey!,
    });
  } else if (provider === 'anthropic') {
    anthropicClient = new Anthropic({
      apiKey: anthropicKey!,
    });
  }

  // Fetch asset data from Mux
  let assetData;
  try {
    const asset = await mux.video.assets.retrieve(assetId);
    assetData = asset;
  } catch (error) {
    throw new Error(`Failed to fetch asset from Mux: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Get playback ID for storyboard URL
  const playbackId = assetData.playback_ids?.[0]?.id;
  if (!playbackId) {
    throw new Error('No playback ID found for this asset');
  }

  // Check for text tracks and fetch transcript if available
  let transcriptText = '';
  if (includeTranscript && assetData.tracks) {
    const textTrack = assetData.tracks.find((track) => 
      track.type === 'text' && track.status === 'ready'
    );
    
    if (textTrack) {
      const transcriptUrl = `https://stream.mux.com/${playbackId}/text/${textTrack.id}.vtt`;
      
      try {
        const transcriptResponse = await fetch(transcriptUrl);
        if (transcriptResponse.ok) {
          transcriptText = await transcriptResponse.text();
        }
      } catch (error) {
        console.warn('Failed to fetch transcript:', error);
      }
    }
  }

  // Create tone-informed prompt
  let toneInstruction = '';
  switch (tone) {
    case 'sassy':
      toneInstruction = ' Answer with a sassy, playful attitude and personality.';
      break;
    case 'professional':
      toneInstruction = ' Provide a professional, executive-level analysis suitable for business reporting.';
      break;
    default: // normal
      toneInstruction = ' Provide a clear, straightforward analysis.';
  }

  // Add transcript context to prompt if available
  let contextualPrompt = prompt + toneInstruction;
  if (transcriptText) {
    contextualPrompt += ` Use the following WebVTT transcript for additional context: "${transcriptText}"`;
  }

  // Analyze storyboard with AI provider
  const imageUrl = `https://image.mux.com/${playbackId}/storyboard.png?width=640`;
  
  let aiAnalysis: { title?: string; description?: string; keywords?: string[] } | null = null;
  let retryAttempt = 0;
  const maxRetries = 3;
  
  if (provider === 'openai') {
    while (retryAttempt <= maxRetries) {
      try {
        const response = await openaiClient!.responses.parse({
          model: finalModel,
          input: [
            {
              role: "system",
              content: "You are an image analysis tool. You will be given a storyboard image from a video showing multiple frames/scenes, and be expected to return structured data about the contents across all the frames.",
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: contextualPrompt,
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
            format: zodTextFormat(summarySchema, "analysis"),
          },
        });

        aiAnalysis = response.output_parsed;
        break; // Success, exit retry loop
        
      } catch (error: unknown) {
        const isTimeoutError = error instanceof Error && error.message && error.message.includes('Timeout while downloading');
        
        if (isTimeoutError && retryAttempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          retryAttempt++;
          continue;
        }
        
        throw new Error(`Failed to analyze video content with OpenAI: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  } else if (provider === 'anthropic') {
    // Anthropic doesn't have structured outputs, so we use prompt engineering
    const anthropicPrompt = `${contextualPrompt}

${ANTHROPIC_JSON_PROMPT}`;
    
    while (retryAttempt <= maxRetries) {
      try {
        const response = await anthropicClient!.messages.create({
          model: finalModel,
          max_tokens: 1000,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "url",
                    url: imageUrl,
                  } as any, // Type assertion to work around SDK type definitions
                },
                {
                  type: "text",
                  text: anthropicPrompt,
                },
              ],
            },
          ],
        });

        const content = response.content[0];
        if (content.type === 'text') {
          // Parse JSON from Anthropic response
          const jsonText = content.text.trim();
          try {
            aiAnalysis = JSON.parse(jsonText);
            break; // Success, exit retry loop
          } catch (parseError) {
            if (retryAttempt < maxRetries) {
              console.warn(`Failed to parse JSON from Anthropic (attempt ${retryAttempt + 1}):`, jsonText);
              retryAttempt++;
              await new Promise(resolve => setTimeout(resolve, 2000));
              continue;
            }
            throw new Error(`Failed to parse JSON response from Anthropic: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
          }
        } else {
          throw new Error('Unexpected response type from Anthropic');
        }
        
      } catch (error: unknown) {
        if (retryAttempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          retryAttempt++;
          continue;
        }
        
        throw new Error(`Failed to analyze video content with Anthropic: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  } else {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  if (!aiAnalysis) {
    throw new Error('No analysis result received from AI provider');
  }

  return {
    assetId,
    title: aiAnalysis.title || 'No title available',
    description: aiAnalysis.description || 'No description available',
    tags: aiAnalysis.keywords || [],
    storyboardUrl: imageUrl,
  };
}