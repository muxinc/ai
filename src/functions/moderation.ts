import { generateObject } from 'ai';
import { z } from 'zod';
import { createWorkflowClients, createMuxClient, validateCredentials } from '../lib/client-factory';
import {
  HiveModerationOutput,
  HiveModerationSource,
  ModerationOptions,
  ModerationProvider,
  ModerationResult,
  ThumbnailModerationScore,
} from '../types';
import type { SupportedProvider } from '../lib/providers';
import { getThumbnailUrls } from '../primitives/thumbnails';
import { downloadImagesAsBase64, ImageDownloadOptions } from '../lib/image-download';
import { fetchPlaybackAsset } from '../lib/mux-assets';

const DEFAULT_THRESHOLDS = {
  sexual: 0.7,
  violence: 0.8,
};

const HIVE_ENDPOINT = 'https://api.thehive.ai/api/v2/task/sync';
const HIVE_SEXUAL_KEYWORDS = [
  /nsfw/i,
  /suggestive/i,
  /sexual/i,
  /genital/i,
  /nipple/i,
  /cleavage/i,
  /underboob/i,
  /lingerie/i,
  /underwear/i,
  /bikini/i,
  /thong/i,
  /butt/i,
];

const HIVE_VIOLENCE_KEYWORDS = [
  /gun/i,
  /knife/i,
  /blood/i,
  /hanging/i,
  /corpse/i,
  /self[_-]?harm/i,
  /abuse/i,
  /fight/i,
  /violence/i,
  /weapon/i,
  /gore/i,
  /kill/i,
];

const LANGUAGE_MODEL_PROVIDERS: SupportedProvider[] = ['openai', 'anthropic', 'google'];

function isLanguageModelProvider(provider: ModerationProvider): provider is SupportedProvider {
  return (LANGUAGE_MODEL_PROVIDERS as string[]).includes(provider);
}

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
  downloadOptions?: ImageDownloadOptions,
  abortSignal?: AbortSignal
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
        abortSignal,
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

function getHiveCategoryScore(
  classes: NonNullable<HiveModerationOutput['classes']>,
  patterns: RegExp[]
): number {
  return classes.reduce((max, entry) => {
    if (!entry?.class) {
      return max;
    }
    const matchesCategory = patterns.some((pattern) => pattern.test(entry.class));
    return matchesCategory ? Math.max(max, entry.score ?? 0) : max;
  }, 0);
}

async function requestHiveModeration(
  imageUrls: string[],
  apiKey: string,
  maxConcurrent: number = 5,
  submissionMode: 'url' | 'base64' = 'url',
  downloadOptions?: ImageDownloadOptions
): Promise<ThumbnailModerationScore[]> {
  const targets: Array<{ url: string; source: HiveModerationSource }> =
    submissionMode === 'base64'
      ? (await downloadImagesAsBase64(imageUrls, downloadOptions, maxConcurrent)).map((img) => ({
          url: img.url,
          source: {
            kind: 'file',
            buffer: img.buffer,
            contentType: img.contentType,
          },
        }))
      : imageUrls.map((url) => ({
          url,
          source: { kind: 'url', value: url },
        }));

  const moderate = async (entry: { url: string; source: HiveModerationSource }): Promise<ThumbnailModerationScore> => {
    try {
      const formData = new FormData();

      if (entry.source.kind === 'url') {
        formData.append('url', entry.source.value);
      } else {
        const extension = entry.source.contentType.split('/')[1] || 'jpg';
        const blob = new Blob([entry.source.buffer], {
          type: entry.source.contentType,
        });
        formData.append('media', blob, `thumbnail.${extension}`);
      }

      const res = await fetch(HIVE_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Token ${apiKey}`,
        },
        body: formData,
      });

      const json: any = await res.json().catch(() => undefined);
      if (!res.ok) {
        throw new Error(
          `Hive moderation error: ${res.status} ${res.statusText} - ${JSON.stringify(json)}`
        );
      }

      // Hive API response structure: status[0].response.output or direct output/response.output
      const outputs: HiveModerationOutput[] | undefined =
        json?.status?.[0]?.response?.output ||
        json?.output ||
        json?.response?.output;
      if (!outputs) {
        throw new Error(`Hive moderation response missing output array. Response: ${JSON.stringify(json)}`);
      }

      const aggregated = outputs.reduce(
        (acc, output) => {
          const classes = output?.classes || [];
          return {
            sexual: Math.max(acc.sexual, getHiveCategoryScore(classes, HIVE_SEXUAL_KEYWORDS)),
            violence: Math.max(acc.violence, getHiveCategoryScore(classes, HIVE_VIOLENCE_KEYWORDS)),
          };
        },
        { sexual: 0, violence: 0 }
      );

      return {
        url: entry.url,
        sexual: aggregated.sexual,
        violence: aggregated.violence,
        error: false,
      };
    } catch (error) {
      console.error('Hive moderation failed:', error);
      return {
        url: entry.url,
        sexual: 0,
        violence: 0,
        error: true,
      };
    }
  };

  return processConcurrently(targets, moderate, maxConcurrent);
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
    abortSignal,
  } = options;

  const { provider: _ignoredProvider, ...clientOpts } = options;
  const isLLMProvider = isLanguageModelProvider(provider);

  const workflowClients = isLLMProvider
    ? createWorkflowClients(
        { ...clientOpts, model },
        provider as SupportedProvider
      )
    : null;

  const muxClient = workflowClients?.mux || createMuxClient(validateCredentials(options));

  // Fetch asset data and a public playback ID from Mux via helper
  const { asset, playbackId } = await fetchPlaybackAsset(muxClient, assetId, {
    requirePublic: true,
  });
  const duration = asset.duration || 0;

  // Generate thumbnail URLs
  const thumbnailUrls = getThumbnailUrls(playbackId, duration, {
    interval: thumbnailInterval,
    width: thumbnailWidth,
  });

  let thumbnailScores: ThumbnailModerationScore[];

  if (provider === 'openai') {
    const apiKey =
      workflowClients?.credentials.openaiApiKey || process.env.OPENAI_API_KEY;
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
  } else if (provider === 'hive') {
    const hiveApiKey = options.hiveApiKey || process.env.HIVE_API_KEY;
    if (!hiveApiKey) {
      throw new Error('Hive API key is required for moderation. Set HIVE_API_KEY or pass hiveApiKey.');
    }

    thumbnailScores = await requestHiveModeration(
      thumbnailUrls,
      hiveApiKey,
      maxConcurrent,
      imageSubmissionMode,
      imageDownloadOptions
    );
  } else if (workflowClients?.languageModel.model) {
    thumbnailScores = await requestGenerativeModeration(
      thumbnailUrls,
      workflowClients.languageModel.model,
      maxConcurrent,
      imageSubmissionMode,
      imageDownloadOptions,
      abortSignal
    );
  } else {
    throw new Error(`Unsupported moderation provider: ${provider}`);
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
