import Mux from '@mux/mux-node';
import OpenAI from 'openai';
import { MuxAIOptions } from './types';
import { ImageDownloadOptions, downloadImagesAsBase64 } from './utils/image-download';

export interface ThumbnailModerationScore {
  url: string;
  sexual: number;
  violence: number;
  error: boolean;
}

export interface ModerationResult {
  assetId: string;
  thumbnailScores: ThumbnailModerationScore[];
  maxScores: {
    sexual: number;
    violence: number;
  };
  exceedsThreshold: boolean;
  thresholds: {
    sexual: number;
    violence: number;
  };
}

export interface ModerationOptions extends MuxAIOptions {
  provider?: 'openai' | 'hive';
  model?: string;
  thresholds?: {
    sexual?: number;
    violence?: number;
  };
  thumbnailInterval?: number;
  thumbnailWidth?: number;
  maxConcurrent?: number;
  /** Method for submitting images to AI providers (default: 'url') */
  imageSubmissionMode?: 'url' | 'base64';
  /** Options for image download when using base64 submission mode */
  imageDownloadOptions?: ImageDownloadOptions;
  hiveApiKey?: string;
}

const DEFAULT_THRESHOLDS = {
  sexual: 0.7,
  violence: 0.8
};

// Process promises in batches with maximum concurrency limit
async function processConcurrently<T>(
  items: any[],
  processor: (item: any) => Promise<T>,
  maxConcurrent: number = 5
): Promise<T[]> {
  const results: T[] = [];
  
  for (let i = 0; i < items.length; i += maxConcurrent) {
    const batch = items.slice(i, i + maxConcurrent);
    const batchPromises = batch.map(processor);
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }
  
  return results;
}

// Mapping Hive categories to OpenAI-compatible scores
const HIVE_SEXUAL_CATEGORIES = [
  'general_nsfw',
  'general_suggestive', 
  'yes_sexual_activity',
  'female_underwear',
  'male_underwear',
  'bra',
  'panties',
  'sex_toys',
  'nudity_female',
  'nudity_male',
  'cleavage',
  'swimwear'
];

const HIVE_VIOLENCE_CATEGORIES = [
  'gun_in_hand',
  'gun_not_in_hand',
  'animated_gun',
  'knife_in_hand',
  'knife_not_in_hand',
  'culinary_knife_not_in_hand',
  'culinary_knife_in_hand',
  'very_bloody',
  'a_little_bloody',
  'other_blood',
  'hanging',
  'noose',
  'human_corpse',
  'animated_corpse',
  'emaciated_body',
  'self_harm',
  'animal_abuse',
  'fights',
  'garm_death_injury_or_military_conflict'
];

// Generates thumbnail URLs at regular intervals based on video duration
function getThumbnailUrls(playbackId: string, duration: number, options: { interval?: number; width?: number } = {}): string[] {
  const { interval = 10, width = 640 } = options;
  const timestamps: number[] = [];

  if (duration <= 50) {
    // Short videos: 5 evenly spaced thumbnails
    const spacing = duration / 6;
    for (let i = 1; i <= 5; i++) {
      timestamps.push(Math.round(i * spacing));
    }
  } else {
    // Longer videos: one thumbnail every interval seconds
    for (let time = 0; time < duration; time += interval) {
      timestamps.push(time);
    }
  }

  return timestamps.map(
    (time) => `https://image.mux.com/${playbackId}/thumbnail.png?time=${time}&width=${width}`
  );
}

// Sends thumbnail URLs to OpenAI moderation API with concurrency limiting
async function requestOpenAIModeration(
  imageUrls: string[], 
  openaiClient: OpenAI, 
  model: string, 
  maxConcurrent: number = 5,
  submissionMode: 'url' | 'base64' = 'url',
  downloadOptions?: ImageDownloadOptions
): Promise<ThumbnailModerationScore[]> {
  
  // If using base64 mode, download all images first
  if (submissionMode === 'base64') {
    console.log(`Downloading ${imageUrls.length} images for base64 submission...`);
    
    try {
      const downloadResults = await downloadImagesAsBase64(imageUrls, downloadOptions, maxConcurrent);
      
      // Process each downloaded image through OpenAI moderation
      const processor = async (downloadResult: typeof downloadResults[0]): Promise<ThumbnailModerationScore> => {
        try {
          const moderation = await openaiClient.moderations.create({
            model,
            input: [
              {
                type: "image_url",
                image_url: {
                  url: downloadResult.base64Data, // Use base64 data URI
                },
              },
            ],
          });

          const categoryScores = moderation.results[0].category_scores;

          return {
            url: downloadResult.url, // Return original URL for tracking
            sexual: categoryScores.sexual || 0,
            violence: categoryScores.violence || 0,
            error: false
          };

        } catch (error) {
          console.error(`Failed to moderate downloaded image ${downloadResult.url}:`, error);
          return {
            url: downloadResult.url,
            sexual: 0,
            violence: 0,
            error: true,
          };
        }
      };

      return processConcurrently(downloadResults, processor, maxConcurrent);
      
    } catch (error) {
      console.error('Failed to download images for base64 submission:', error);
      // Return error results for all URLs
      return imageUrls.map(url => ({
        url,
        sexual: 0,
        violence: 0,
        error: true,
      }));
    }
  }
  
  // Original URL-based submission mode
  const processor = async (url: string): Promise<ThumbnailModerationScore> => {
    try {
      const moderation = await openaiClient.moderations.create({
        model,
        input: [
          {
            type: "image_url",
            image_url: {
              url: url,
            },
          },
        ],
      });

      const categoryScores = moderation.results[0].category_scores;

      return {
        url,
        sexual: categoryScores.sexual || 0,
        violence: categoryScores.violence || 0,
        error: false
      };

    } catch (error) {
      console.error("Failed to moderate image:", error);
      return {
        url,
        sexual: 0,
        violence: 0,
        error: true,
      };
    }
  };

  return processConcurrently(imageUrls, processor, maxConcurrent);
}

// Sends thumbnail URLs to Hive moderation API with concurrency limiting
async function requestHiveModeration(
  imageUrls: string[], 
  hiveApiKey: string, 
  maxConcurrent: number = 5,
  submissionMode: 'url' | 'base64' = 'url',
  downloadOptions?: ImageDownloadOptions
): Promise<ThumbnailModerationScore[]> {
  
  // If using base64 mode, download all images first and upload via multipart/form-data
  if (submissionMode === 'base64') {
    console.log(`Downloading ${imageUrls.length} images for Hive multipart upload...`);
    
    try {
      const downloadResults = await downloadImagesAsBase64(imageUrls, downloadOptions, maxConcurrent);
      
      // Process each downloaded image through Hive moderation via file upload
      const processor = async (downloadResult: typeof downloadResults[0]): Promise<ThumbnailModerationScore> => {
        try {
          // Create form data with image buffer
          const formData = new FormData();
          
          // Create a Blob from the buffer for form data
          const imageBlob = new Blob([downloadResult.buffer], { 
            type: downloadResult.contentType 
          });
          
          // Get file extension from content type
          const extension = downloadResult.contentType.split('/')[1] || 'png';
          formData.append('media', imageBlob, `image.${extension}`);

          const response = await fetch('https://api.thehive.ai/api/v2/task/sync', {
            method: 'POST',
            headers: {
              'Authorization': `Token ${hiveApiKey}`,
              // Don't set Content-Type header - let fetch set it with boundary for multipart
            },
            body: formData
          });

          if (!response.ok) {
            throw new Error(`Hive API error: ${response.statusText}`);
          }

          const hiveResult = await response.json() as any;
          
          // Extract scores from Hive response and map to OpenAI format
          const classes = hiveResult.status?.[0]?.response?.output?.[0]?.classes || [];
          const scoreMap = Object.fromEntries(classes.map((c: any) => [c.class, c.score]));
          
          const sexualScores = HIVE_SEXUAL_CATEGORIES.map(category => 
            scoreMap[category] || 0
          );
          const violenceScores = HIVE_VIOLENCE_CATEGORIES.map(category => 
            scoreMap[category] || 0
          );

          return {
            url: downloadResult.url, // Return original URL for tracking
            sexual: Math.max(...sexualScores, 0),
            violence: Math.max(...violenceScores, 0),
            error: false
          };

        } catch (error) {
          console.error(`Failed to moderate uploaded image ${downloadResult.url}:`, error);
          return {
            url: downloadResult.url,
            sexual: 0,
            violence: 0,
            error: true,
          };
        }
      };

      return processConcurrently(downloadResults, processor, maxConcurrent);
      
    } catch (error) {
      console.error('Failed to download images for Hive multipart upload:', error);
      // Return error results for all URLs
      return imageUrls.map(url => ({
        url,
        sexual: 0,
        violence: 0,
        error: true,
      }));
    }
  }
  
  // Original URL-based submission mode
  const processor = async (url: string): Promise<ThumbnailModerationScore> => {
    try {
      const response = await fetch('https://api.thehive.ai/api/v2/task/sync', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${hiveApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url })
      });

      if (!response.ok) {
        throw new Error(`Hive API error: ${response.statusText}`);
      }

      const hiveResult = await response.json() as any;
      
      // Extract scores from Hive response and map to OpenAI format
      // Hive returns scores in status[0].response.output[0].classes as array of {class, score}
      const classes = hiveResult.status?.[0]?.response?.output?.[0]?.classes || [];
      const scoreMap = Object.fromEntries(classes.map((c: any) => [c.class, c.score]));
      
      const sexualScores = HIVE_SEXUAL_CATEGORIES.map(category => 
        scoreMap[category] || 0
      );
      const violenceScores = HIVE_VIOLENCE_CATEGORIES.map(category => 
        scoreMap[category] || 0
      );

      return {
        url,
        sexual: Math.max(...sexualScores, 0),
        violence: Math.max(...violenceScores, 0),
        error: false
      };

    } catch (error) {
      console.error("Failed to moderate image with Hive:", error);
      return {
        url,
        sexual: 0,
        violence: 0,
        error: true,
      };
    }
  };

  return processConcurrently(imageUrls, processor, maxConcurrent);
}

export async function getModerationScores(
  assetId: string,
  options: ModerationOptions = {}
): Promise<ModerationResult> {
  const {
    provider = 'openai',
    model = 'omni-moderation-latest',
    thresholds = DEFAULT_THRESHOLDS,
    thumbnailInterval = 10,
    thumbnailWidth = 640,
    maxConcurrent = 5,
    imageSubmissionMode = 'url',
    imageDownloadOptions,
    muxTokenId,
    muxTokenSecret,
    openaiApiKey,
    ...config
  } = options;

  if (provider !== 'openai' && provider !== 'hive') {
    throw new Error('Only OpenAI and Hive providers are currently supported');
  }

  // Validate required credentials
  const muxId = muxTokenId || process.env.MUX_TOKEN_ID;
  const muxSecret = muxTokenSecret || process.env.MUX_TOKEN_SECRET;
  const openaiKey = openaiApiKey || process.env.OPENAI_API_KEY;
  const hiveKey = options.hiveApiKey || process.env.HIVE_API_KEY;

  if (!muxId || !muxSecret) {
    throw new Error('Mux credentials are required. Provide muxTokenId and muxTokenSecret in options or set MUX_TOKEN_ID and MUX_TOKEN_SECRET environment variables.');
  }

  if (provider === 'openai' && !openaiKey) {
    throw new Error('OpenAI API key is required for OpenAI provider. Provide openaiApiKey in options or set OPENAI_API_KEY environment variable.');
  }

  if (provider === 'hive' && !hiveKey) {
    throw new Error('Hive API key is required for Hive provider. Provide hiveApiKey in options or set HIVE_API_KEY environment variable.');
  }

  // Initialize clients
  const mux = new Mux({
    tokenId: muxId,
    tokenSecret: muxSecret,
  });

  let openaiClient: OpenAI | undefined;
  if (provider === 'openai') {
    openaiClient = new OpenAI({
      apiKey: openaiKey!,
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

  // Get playback ID - prefer public playback IDs
  const publicPlaybackIds = assetData.playback_ids?.filter(pid => pid.policy === 'public') || [];
  
  if (publicPlaybackIds.length === 0) {
    throw new Error('No public playback IDs found for this asset. Moderation requires public playback access.');
  }

  const playbackId = publicPlaybackIds[0].id;
  const duration = assetData.duration || 0;

  // Generate thumbnail URLs
  const thumbnailUrls = getThumbnailUrls(playbackId, duration, {
    interval: thumbnailInterval,
    width: thumbnailWidth
  });

  // Request moderation for all thumbnails
  let thumbnailScores: ThumbnailModerationScore[];
  
  if (provider === 'openai') {
    thumbnailScores = await requestOpenAIModeration(
      thumbnailUrls, 
      openaiClient!, 
      model, 
      maxConcurrent, 
      imageSubmissionMode, 
      imageDownloadOptions
    );
  } else if (provider === 'hive') {
    thumbnailScores = await requestHiveModeration(
      thumbnailUrls, 
      hiveKey!, 
      maxConcurrent, 
      imageSubmissionMode, 
      imageDownloadOptions
    );
  } else {
    throw new Error('Unsupported provider');
  }
  
  // Find highest scores across all thumbnails
  const maxSexual = Math.max(...thumbnailScores.map(s => s.sexual));
  const maxViolence = Math.max(...thumbnailScores.map(s => s.violence));
  
  const finalThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  
  return {
    assetId,
    thumbnailScores,
    maxScores: {
      sexual: maxSexual,
      violence: maxViolence
    },
    exceedsThreshold: maxSexual > finalThresholds.sexual || maxViolence > finalThresholds.violence,
    thresholds: finalThresholds
  };
}