import type { Buffer } from "node:buffer";

import type { ImageDownloadOptions } from "../lib/image-download";
import type { ImageSubmissionMode, MuxAIOptions } from "../types";

import env from "../env";
import { createMuxClient, validateCredentials } from "../lib/client-factory";
import { downloadImagesAsBase64 } from "../lib/image-download";
import { getPlaybackIdForAsset } from "../lib/mux-assets";
import { resolveSigningContext } from "../lib/url-signing";
import { getThumbnailUrls } from "../primitives/thumbnails";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Per-thumbnail moderation result returned from `getModerationScores`. */
export interface ThumbnailModerationScore {
  url: string;
  sexual: number;
  violence: number;
  error: boolean;
}

/** Aggregated moderation payload returned from `getModerationScores`. */
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

/** Provider list accepted by `getModerationScores`. */
export type ModerationProvider = "openai" | "hive";

export type HiveModerationSource
  = | { kind: "url"; value: string }
    | { kind: "file"; buffer: Buffer; contentType: string };

export interface HiveModerationOutput {
  classes?: Array<{
    class: string;
    score: number;
  }>;
}

/** Configuration accepted by `getModerationScores`. */
export interface ModerationOptions extends MuxAIOptions {
  /** Provider used for moderation (defaults to 'openai'). */
  provider?: ModerationProvider;
  /** OpenAI moderation model identifier (defaults to 'omni-moderation-latest'). */
  model?: string;
  /** Override the default sexual/violence thresholds (0-1). */
  thresholds?: {
    sexual?: number;
    violence?: number;
  };
  /** Interval between storyboard thumbnails in seconds (defaults to 10). */
  thumbnailInterval?: number;
  /** Width of storyboard thumbnails in pixels (defaults to 640). */
  thumbnailWidth?: number;
  /** Max concurrent moderation requests (defaults to 5). */
  maxConcurrent?: number;
  /** Transport used for thumbnails (defaults to 'url'). */
  imageSubmissionMode?: ImageSubmissionMode;
  /** Download tuning used when `imageSubmissionMode` === 'base64'. */
  imageDownloadOptions?: ImageDownloadOptions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = {
  sexual: 0.7,
  violence: 0.8,
};

const DEFAULT_PROVIDER = "openai";

const HIVE_ENDPOINT = "https://api.thehive.ai/api/v2/task/sync";
const HIVE_SEXUAL_CATEGORIES = [
  "general_nsfw",
  "general_suggestive",
  "yes_sexual_activity",
  "female_underwear",
  "male_underwear",
  "bra",
  "panties",
  "sex_toys",
  "nudity_female",
  "nudity_male",
  "cleavage",
  "swimwear",
];

const HIVE_VIOLENCE_CATEGORIES = [
  "gun_in_hand",
  "gun_not_in_hand",
  "animated_gun",
  "knife_in_hand",
  "knife_not_in_hand",
  "culinary_knife_not_in_hand",
  "culinary_knife_in_hand",
  "very_bloody",
  "a_little_bloody",
  "other_blood",
  "hanging",
  "noose",
  "human_corpse",
  "animated_corpse",
  "emaciated_body",
  "self_harm",
  "animal_abuse",
  "fights",
  "garm_death_injury_or_military_conflict",
];

async function processConcurrently<T>(
  items: any[],
  processor: (item: any) => Promise<T>,
  maxConcurrent: number = 5,
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
  submissionMode: "url" | "base64" = "url",
  downloadOptions?: ImageDownloadOptions,
): Promise<ThumbnailModerationScore[]> {
  const targetUrls
    = submissionMode === "base64"
      ? (await downloadImagesAsBase64(imageUrls, downloadOptions, maxConcurrent)).map(
          img => ({ url: img.url, image: img.base64Data }),
        )
      : imageUrls.map(url => ({ url, image: url }));

  const moderate = async (entry: { url: string; image: string }): Promise<ThumbnailModerationScore> => {
    try {
      const res = await fetch("https://api.openai.com/v1/moderations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: [
            {
              type: "image_url",
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
          `OpenAI moderation error: ${res.status} ${res.statusText} - ${JSON.stringify(json)}`,
        );
      }

      const categoryScores = json.results?.[0]?.category_scores || {};

      return {
        url: entry.url,
        sexual: categoryScores.sexual || 0,
        violence: categoryScores.violence || 0,
        error: false,
      };
    }
    catch (error) {
      console.error("OpenAI moderation failed:", error);
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

function getHiveCategoryScores(
  classes: NonNullable<HiveModerationOutput["classes"]>,
  categoryNames: string[],
): number {
  const scoreMap = Object.fromEntries(
    classes.map(c => [c.class, c.score]),
  );
  const scores = categoryNames.map(category => scoreMap[category] || 0);
  return Math.max(...scores, 0);
}

async function requestHiveModeration(
  imageUrls: string[],
  apiKey: string,
  maxConcurrent: number = 5,
  submissionMode: "url" | "base64" = "url",
  downloadOptions?: ImageDownloadOptions,
): Promise<ThumbnailModerationScore[]> {
  const targets: Array<{ url: string; source: HiveModerationSource }>
    = submissionMode === "base64"
      ? (await downloadImagesAsBase64(imageUrls, downloadOptions, maxConcurrent)).map(img => ({
          url: img.url,
          source: {
            kind: "file",
            buffer: img.buffer,
            contentType: img.contentType,
          },
        }))
      : imageUrls.map(url => ({
          url,
          source: { kind: "url", value: url },
        }));

  const moderate = async (entry: { url: string; source: HiveModerationSource }): Promise<ThumbnailModerationScore> => {
    try {
      const formData = new FormData();

      if (entry.source.kind === "url") {
        formData.append("url", entry.source.value);
      }
      else {
        const extension = entry.source.contentType.split("/")[1] || "jpg";
        const blob = new Blob([entry.source.buffer], {
          type: entry.source.contentType,
        });
        formData.append("media", blob, `thumbnail.${extension}`);
      }

      const res = await fetch(HIVE_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Token ${apiKey}`,
        },
        body: formData,
      });

      const json: any = await res.json().catch(() => undefined);
      if (!res.ok) {
        throw new Error(
          `Hive moderation error: ${res.status} ${res.statusText} - ${JSON.stringify(json)}`,
        );
      }

      // Extract scores from Hive response
      // Hive returns scores in status[0].response.output[0].classes as array of {class, score}
      const classes = json?.status?.[0]?.response?.output?.[0]?.classes || [];

      return {
        url: entry.url,
        sexual: getHiveCategoryScores(classes, HIVE_SEXUAL_CATEGORIES),
        violence: getHiveCategoryScores(classes, HIVE_VIOLENCE_CATEGORIES),
        error: false,
      };
    }
    catch (error) {
      console.error("Hive moderation failed:", error);
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
 */
export async function getModerationScores(
  assetId: string,
  options: ModerationOptions = {},
): Promise<ModerationResult> {
  const {
    provider = DEFAULT_PROVIDER,
    model = provider === "openai" ? "omni-moderation-latest" : undefined,
    thresholds = DEFAULT_THRESHOLDS,
    thumbnailInterval = 10,
    thumbnailWidth = 640,
    maxConcurrent = 5,
    imageSubmissionMode = "url",
    imageDownloadOptions,
  } = options;

  const credentials = validateCredentials(options, provider === "openai" ? "openai" : undefined);
  const muxClient = createMuxClient(credentials);

  // Fetch asset data and playback ID from Mux via helper
  const { asset, playbackId, policy } = await getPlaybackIdForAsset(muxClient, assetId);
  const duration = asset.duration || 0;

  // Resolve signing context for signed playback IDs
  const signingContext = resolveSigningContext(options);
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. "
      + "Provide muxSigningKey and muxPrivateKey in options or set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  // Generate thumbnail URLs (signed if needed)
  const thumbnailUrls = await getThumbnailUrls(playbackId, duration, {
    interval: thumbnailInterval,
    width: thumbnailWidth,
    signingContext: policy === "signed" ? signingContext : undefined,
  });

  let thumbnailScores: ThumbnailModerationScore[];

  if (provider === "openai") {
    const apiKey = credentials.openaiApiKey;
    if (!apiKey) {
      throw new Error("OpenAI API key is required for moderation. Set OPENAI_API_KEY or pass openaiApiKey.");
    }

    thumbnailScores = await requestOpenAIModeration(
      thumbnailUrls,
      apiKey,
      model || "omni-moderation-latest",
      maxConcurrent,
      imageSubmissionMode,
      imageDownloadOptions,
    );
  }
  else if (provider === "hive") {
    const hiveApiKey = options.hiveApiKey || env.HIVE_API_KEY;
    if (!hiveApiKey) {
      throw new Error("Hive API key is required for moderation. Set HIVE_API_KEY or pass hiveApiKey.");
    }

    thumbnailScores = await requestHiveModeration(
      thumbnailUrls,
      hiveApiKey,
      maxConcurrent,
      imageSubmissionMode,
      imageDownloadOptions,
    );
  }
  else {
    throw new Error(`Unsupported moderation provider: ${provider}`);
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
      violence: maxViolence,
    },
    exceedsThreshold: maxSexual > finalThresholds.sexual || maxViolence > finalThresholds.violence,
    thresholds: finalThresholds,
  };
}
