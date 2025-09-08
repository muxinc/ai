import Mux from '@mux/mux-node';
import OpenAI from 'openai';
import { MuxAIOptions } from './types';

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
  provider?: 'openai';
  model?: string;
  thresholds?: {
    sexual?: number;
    violence?: number;
  };
  thumbnailInterval?: number;
  thumbnailWidth?: number;
}

const DEFAULT_THRESHOLDS = {
  sexual: 0.7,
  violence: 0.8
};

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

// Sends thumbnail URLs to OpenAI moderation API concurrently
async function requestModeration(imageUrls: string[], openaiClient: OpenAI, model: string): Promise<ThumbnailModerationScore[]> {
  const moderationPromises = imageUrls.map(async (url): Promise<ThumbnailModerationScore> => {
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
  });

  return Promise.all(moderationPromises);
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
    muxTokenId,
    muxTokenSecret,
    openaiApiKey,
    ...config
  } = options;

  if (provider !== 'openai') {
    throw new Error('Only OpenAI provider is currently supported');
  }

  // Validate required credentials
  const muxId = muxTokenId || process.env.MUX_TOKEN_ID;
  const muxSecret = muxTokenSecret || process.env.MUX_TOKEN_SECRET;
  const openaiKey = openaiApiKey || process.env.OPENAI_API_KEY;

  if (!muxId || !muxSecret) {
    throw new Error('Mux credentials are required. Provide muxTokenId and muxTokenSecret in options or set MUX_TOKEN_ID and MUX_TOKEN_SECRET environment variables.');
  }

  if (!openaiKey) {
    throw new Error('OpenAI API key is required. Provide openaiApiKey in options or set OPENAI_API_KEY environment variable.');
  }

  // Initialize clients
  const mux = new Mux({
    tokenId: muxId,
    tokenSecret: muxSecret,
  });

  const openaiClient = new OpenAI({
    apiKey: openaiKey,
  });

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
  const thumbnailScores = await requestModeration(thumbnailUrls, openaiClient, model);
  
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