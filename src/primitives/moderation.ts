import { generateObject } from 'ai';
import { z } from 'zod';
import { createWorkflowClients } from '../lib/client-factory';
import { ModerationOptions, ModerationResult, ThumbnailModerationScore } from '../types';
import { getThumbnailUrls } from './thumbnails';
import { downloadImagesAsBase64, ImageDownloadOptions } from '../lib/image-download';

const DEFAULT_THRESHOLDS = {
  sexual: 0.7,
  violence: 0.8,
};

const thumbnailScoreSchema = z.object({
  sexual: z.number().min(0).max(1),
  violence: z.number().min(0).max(1),
});

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

async function requestOpenAIModeration(
  imageUrls: string[],
  apiKey: string,
  model: string,
  maxConcurrent: number = 5,
  submissionMode: 'url' | 'base64' = 'url',
  downloadOptions?: ImageDownloadOptions
): Promise<ThumbnailModerationScore[]> {
  const targetUrls =
    submissionMode === 'base64'
      ? (await downloadImagesAsBase64(imageUrls, downloadOptions, maxConcurrent)).map(
          (img) => ({ url: img.url, image: img.base64Data })
        )
      : imageUrls.map((url) => ({ url, image: url }));

  const moderate = async (entry: { url: string; image: string }): Promise<ThumbnailModerationScore> => {
    try {
      const res = await fetch('https://api.openai.com/v1/moderations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: [
            {
              type: 'image_url',
              image_url: {
                url: entry.image,
              },
            },
          ],
        }),
      });

      const json: any = await res.json();
      if (!res.ok) {
        throw new Error(
          `OpenAI moderation error: ${res.status} ${res.statusText} - ${JSON.stringify(json)}`
        );
      }

      const categoryScores = json.results?.[0]?.category_scores || {};

      return {
        url: entry.url,
        sexual: categoryScores.sexual || 0,
        violence: categoryScores.violence || 0,
        error: false,
      };
    } catch (error) {
      console.error('OpenAI moderation failed:', error);
      return {
        url: entry.url,
        sexual: 0,
        violence: 0,
        error: true,
      };
    }
  };

  return processConcurrently(targetUrls, moderate, maxConcurrent);
}

async function requestGenerativeModeration(
  imageUrls: string[],
  model: ReturnType<typeof createWorkflowClients>['languageModel']['model'],
  maxConcurrent: number = 5,
  submissionMode: 'url' | 'base64' = 'url',
  downloadOptions?: ImageDownloadOptions
): Promise<ThumbnailModerationScore[]> {
  const targetUrls =
    submissionMode === 'base64'
      ? (await downloadImagesAsBase64(imageUrls, downloadOptions, maxConcurrent)).map(
          (img) => ({ url: img.url, image: img.base64Data })
        )
      : imageUrls.map((url) => ({ url, image: url }));

  const prompt = `You are a content safety system. Analyze the provided image and return JSON with two numeric scores between 0 and 1: "sexual" and "violence". Higher = more risky.`;

  const moderate = async (entry: { url: string; image: string }): Promise<ThumbnailModerationScore> => {
    try {
      const response = await generateObject({
        model,
        schema: thumbnailScoreSchema,
        messages: [
          { role: 'system', content: prompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Score this image for sexual and violence risk.' },
              { type: 'image', image: entry.image },
            ],
          },
        ],
      });

      return {
        url: entry.url,
        ...response.object,
        error: false,
      };
    } catch (error) {
      console.error('Generative moderation failed:', error);
      return {
        url: entry.url,
        sexual: 0,
        violence: 0,
        error: true,
      };
    }
  };

  return processConcurrently(targetUrls, moderate, maxConcurrent);
}

/**
 * Moderate a Mux asset's thumbnails.
 * - provider 'openai' uses OpenAI's hosted moderation endpoint (requires OPENAI_API_KEY)
 * - provider 'google' or 'anthropic' uses the resolved language model via Vercel AI SDK to produce comparable scores
 */
export async function getModerationScores(
  assetId: string,
  options: ModerationOptions = {}
): Promise<ModerationResult> {
  const {
    provider = 'openai',
    model = provider === 'openai' ? 'omni-moderation-latest' : undefined,
    thresholds = DEFAULT_THRESHOLDS,
    thumbnailInterval = 10,
    thumbnailWidth = 640,
    maxConcurrent = 5,
    imageSubmissionMode = 'url',
    imageDownloadOptions,
  } = options;

  const { provider: _ignoredProvider, ...clientOpts } = options;
  const clients = createWorkflowClients(
    { ...clientOpts, model },
    provider as 'openai' | 'anthropic' | 'google'
  );

  // Fetch asset data from Mux
  const asset = await clients.mux.video.assets.retrieve(assetId);

  // Get playback ID - prefer public playback IDs
  const publicPlaybackIds = asset.playback_ids?.filter((pid) => pid.policy === 'public') || [];
  if (publicPlaybackIds.length === 0) {
    throw new Error('No public playback IDs found for this asset. Moderation requires public playback access.');
  }

  const playbackId = publicPlaybackIds[0].id;
  const duration = asset.duration || 0;

  // Generate thumbnail URLs
  const thumbnailUrls = getThumbnailUrls(playbackId, duration, {
    interval: thumbnailInterval,
    width: thumbnailWidth,
  });

  let thumbnailScores: ThumbnailModerationScore[];

  if (provider === 'openai') {
    const apiKey = clients.credentials.openaiApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI API key is required for moderation. Set OPENAI_API_KEY or pass openaiApiKey.');
    }

    thumbnailScores = await requestOpenAIModeration(
      thumbnailUrls,
      apiKey,
      model || 'omni-moderation-latest',
      maxConcurrent,
      imageSubmissionMode,
      imageDownloadOptions
    );
  } else {
    thumbnailScores = await requestGenerativeModeration(
      thumbnailUrls,
      clients.languageModel.model,
      maxConcurrent,
      imageSubmissionMode,
      imageDownloadOptions
    );
  }

  // Find highest scores across all thumbnails
  const maxSexual = Math.max(...thumbnailScores.map((s) => s.sexual));
  const maxViolence = Math.max(...thumbnailScores.map((s) => s.violence));

  const finalThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };

  return {
    assetId,
    thumbnailScores,
    maxScores: {
      sexual: maxSexual,
      violence: maxViolence,
    },
    exceedsThreshold: maxSexual > finalThresholds.sexual || maxViolence > finalThresholds.violence,
    thresholds: finalThresholds,
  };
}
