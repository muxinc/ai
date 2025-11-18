import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { MuxAIOptions, ToneType } from './types';
import { ImageDownloadOptions, downloadImageAsBase64, uploadImageToAnthropicFiles } from './utils/image-download';
import { extractTextFromVTT } from './utils/vtt-parser';
import { createWorkflowClients } from './lib/client-factory';
import { getDefaultModel, validateProvider } from './lib/provider-models';
import { withRetry } from './lib/retry';

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
  /** Whether to clean VTT timestamps and formatting from transcript (default: true) */
  cleanTranscript?: boolean;
  /** Method for submitting storyboard to AI providers (default: 'url') */
  imageSubmissionMode?: 'url' | 'base64';
  /** Options for image download when using base64 submission mode */
  imageDownloadOptions?: ImageDownloadOptions;
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
    cleanTranscript = true,
    imageSubmissionMode = 'url',
    imageDownloadOptions,
  } = actualOptions;

  // Validate provider and get default model
  validateProvider(provider);
  const finalModel = model || getDefaultModel(provider);

  // Initialize clients with validated credentials
  const clients = createWorkflowClients(actualOptions, provider);

  // Fetch asset data from Mux
  let assetData;
  try {
    const asset = await clients.mux.video.assets.retrieve(assetId);
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
          const rawVttContent = await transcriptResponse.text();
          // Use clean text or raw VTT based on user preference
          transcriptText = cleanTranscript 
            ? extractTextFromVTT(rawVttContent)
            : rawVttContent;
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
    const transcriptType = cleanTranscript ? 'transcript' : 'WebVTT transcript';
    contextualPrompt += ` Use the following ${transcriptType} for additional context: "${transcriptText}"`;
  }

  // Analyze storyboard with AI provider
  const imageUrl = `https://image.mux.com/${playbackId}/storyboard.png?width=640`;

  let aiAnalysis: { title?: string; description?: string; keywords?: string[] } | null = null;

  if (provider === 'openai') {
    if (!clients.openai) {
      throw new Error('OpenAI client not initialized');
    }

    const analyzeWithOpenAI = async (imageDataUrl: string) => {
      return await clients.openai!.responses.parse({
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
                image_url: imageDataUrl,
                detail: "high",
              },
            ],
          },
        ],
        text: {
          format: zodTextFormat(summarySchema, "analysis"),
        },
      });
    };

    try {
      if (imageSubmissionMode === 'base64') {
        const downloadResult = await downloadImageAsBase64(imageUrl, imageDownloadOptions);
        const response = await analyzeWithOpenAI(downloadResult.base64Data);
        aiAnalysis = response.output_parsed;
      } else {
        // URL-based submission with retry logic
        const response = await withRetry(() => analyzeWithOpenAI(imageUrl));
        aiAnalysis = response.output_parsed;
      }
    } catch (error: unknown) {
      throw new Error(`Failed to analyze video content with OpenAI: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else if (provider === 'anthropic') {
    if (!clients.anthropic) {
      throw new Error('Anthropic client not initialized');
    }

    // Anthropic doesn't have structured outputs, so we use prompt engineering
    const anthropicPrompt = `${contextualPrompt}

${ANTHROPIC_JSON_PROMPT}`;

    const parseAnthropicResponse = (response: any) => {
      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type from Anthropic');
      }

      const jsonText = content.text.trim();
      try {
        return JSON.parse(jsonText);
      } catch (parseError) {
        throw new Error(`Failed to parse JSON response from Anthropic: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
      }
    };

    try {
      if (imageSubmissionMode === 'base64') {
        // Upload to Files API instead of using base64 inline (no 5MB limit)
        const fileUploadResult = await uploadImageToAnthropicFiles(
          imageUrl,
          clients.credentials.anthropicApiKey!,
          imageDownloadOptions
        );

        const response = await clients.anthropic.messages.create({
          model: finalModel,
          max_tokens: 1000,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "file",
                    file_id: fileUploadResult.fileId,
                  } as any, // Type assertion for Files API support
                },
                {
                  type: "text",
                  text: anthropicPrompt,
                },
              ],
            },
          ],
        }, {
          headers: {
            'anthropic-beta': 'files-api-2025-04-14'
          }
        });

        aiAnalysis = parseAnthropicResponse(response);
      } else {
        // URL-based submission with retry logic
        const response = await withRetry(async () => {
          return await clients.anthropic!.messages.create({
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
        });

        aiAnalysis = parseAnthropicResponse(response);
      }
    } catch (error: unknown) {
      throw new Error(`Failed to analyze video content with Anthropic: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
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