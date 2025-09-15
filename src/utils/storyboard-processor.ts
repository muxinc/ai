import Mux from '@mux/mux-node';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { ImageDownloadOptions, downloadImageAsBase64, uploadImageToAnthropicFiles } from './image-download';

export interface StoryboardProcessorOptions {
  muxTokenId?: string;
  muxTokenSecret?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  imageSubmissionMode?: 'url' | 'base64';
  imageDownloadOptions?: ImageDownloadOptions;
}

export interface AssetInfo {
  playbackId: string;
  duration?: number;
}

/**
 * Retrieves asset information from Mux including playback ID and duration
 */
export async function getAssetInfo(assetId: string, options: StoryboardProcessorOptions): Promise<AssetInfo> {
  const muxId = options.muxTokenId || process.env.MUX_TOKEN_ID;
  const muxSecret = options.muxTokenSecret || process.env.MUX_TOKEN_SECRET;

  if (!muxId || !muxSecret) {
    throw new Error('Mux credentials are required. Provide muxTokenId and muxTokenSecret in options or set MUX_TOKEN_ID and MUX_TOKEN_SECRET environment variables.');
  }

  const mux = new Mux({
    tokenId: muxId,
    tokenSecret: muxSecret,
  });

  try {
    const asset = await mux.video.assets.retrieve(assetId);
    
    const playbackId = asset.playback_ids?.[0]?.id;
    if (!playbackId) {
      throw new Error('No playback ID found for this asset');
    }

    return {
      playbackId,
      duration: asset.duration || undefined
    };
  } catch (error) {
    throw new Error(`Failed to fetch asset from Mux: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Processes a storyboard image with OpenAI
 */
export async function processStoryboardWithOpenAI<T>(
  imageUrl: string,
  prompt: string,
  systemPrompt: string,
  options: {
    apiKey: string;
    model: string;
    responseParser: (response: any) => T;
    imageSubmissionMode?: 'url' | 'base64';
    imageDownloadOptions?: ImageDownloadOptions;
    maxRetries?: number;
  }
): Promise<T> {
  const { apiKey, model, responseParser, imageSubmissionMode = 'url', imageDownloadOptions, maxRetries = 3 } = options;
  
  const openaiClient = new OpenAI({ apiKey });
  let retryAttempt = 0;

  if (imageSubmissionMode === 'base64') {
    try {
      const downloadResult = await downloadImageAsBase64(imageUrl, imageDownloadOptions);
      
      const response = await openaiClient.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt,
              },
              {
                type: "image_url",
                image_url: {
                  url: downloadResult.base64Data,
                  detail: "high",
                },
              },
            ],
          },
        ],
      });

      return responseParser(response);
      
    } catch (error: unknown) {
      throw new Error(`Failed to process storyboard with OpenAI in base64 mode: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else {
    // URL-based submission with retry logic
    while (retryAttempt <= maxRetries) {
      try {
        const response = await openaiClient.chat.completions.create({
          model,
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: prompt,
                },
                {
                  type: "image_url",
                  image_url: {
                    url: imageUrl,
                    detail: "high",
                  },
                },
              ],
            },
          ],
        });

        return responseParser(response);
        
      } catch (error: unknown) {
        const isTimeoutError = error instanceof Error && error.message && error.message.includes('Timeout while downloading');
        
        if (isTimeoutError && retryAttempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          retryAttempt++;
          continue;
        }
        
        throw new Error(`Failed to process storyboard with OpenAI: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }

  throw new Error('All retry attempts failed');
}

/**
 * Processes a storyboard image with Anthropic
 */
export async function processStoryboardWithAnthropic<T>(
  imageUrl: string,
  prompt: string,
  options: {
    apiKey: string;
    model: string;
    responseParser: (response: any) => T;
    imageSubmissionMode?: 'url' | 'base64';
    imageDownloadOptions?: ImageDownloadOptions;
    maxRetries?: number;
  }
): Promise<T> {
  const { apiKey, model, responseParser, imageSubmissionMode = 'url', imageDownloadOptions, maxRetries = 3 } = options;
  
  const anthropicClient = new Anthropic({ apiKey });
  let retryAttempt = 0;

  if (imageSubmissionMode === 'base64') {
    try {
      // Upload to Files API instead of using base64 inline (no 5MB limit)
      const fileUploadResult = await uploadImageToAnthropicFiles(imageUrl, apiKey, imageDownloadOptions);
      
      const response = await anthropicClient.messages.create({
        model,
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
                text: prompt,
              },
            ],
          },
        ],
      }, {
        headers: {
          'anthropic-beta': 'files-api-2025-04-14'
        }
      });

      return responseParser(response);
      
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to process storyboard with Anthropic Files API: ${errorMessage}`);
    }
  } else {
    // URL-based submission with retry logic
    while (retryAttempt <= maxRetries) {
      try {
        const response = await anthropicClient.messages.create({
          model,
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
                  text: prompt,
                },
              ],
            },
          ],
        });

        return responseParser(response);
        
      } catch (error: unknown) {
        if (retryAttempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          retryAttempt++;
          continue;
        }
        
        throw new Error(`Failed to process storyboard with Anthropic: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }

  throw new Error('All retry attempts failed');
}