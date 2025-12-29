import { getApiKeyFromEnv } from "@mux/ai/lib/client-factory";
import type { ImageDownloadOptions } from "@mux/ai/lib/image-download";
import { downloadImagesAsBase64 } from "@mux/ai/lib/image-download";
import { getPlaybackIdForAsset, isAudioOnlyAsset } from "@mux/ai/lib/mux-assets";
import { resolveMuxSigningContext } from "@mux/ai/lib/workflow-credentials";
import { getThumbnailUrls } from "@mux/ai/primitives/thumbnails";
import { fetchTranscriptForAsset, getReadyTextTracks } from "@mux/ai/primitives/transcripts";
import type { ImageSubmissionMode, MuxAIOptions, WorkflowCredentialsInput } from "@mux/ai/types";

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
  /** Whether moderation ran on thumbnails (video) or transcript text (audio-only). */
  mode: "thumbnails" | "transcript";
  /** Convenience flag so callers can understand why `thumbnailScores` may contain a transcript entry. */
  isAudioOnly: boolean;
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

export type HiveModerationSource =
  | { kind: "url"; value: string } |
  { kind: "file"; buffer: Uint8Array; contentType: string };

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
  /**
   * Optional transcript language code used when moderating audio-only assets.
   * If omitted, the first ready text track will be used.
   */
  languageCode?: string;
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
  "use step";
  const results: T[] = [];

  for (let i = 0; i < items.length; i += maxConcurrent) {
    const batch = items.slice(i, i + maxConcurrent);
    const batchPromises = batch.map(processor);
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }

  return results;
}

async function moderateImageWithOpenAI(entry: {
  url: string;
  image: string;
  model: string;
  credentials?: WorkflowCredentialsInput;
}): Promise<ThumbnailModerationScore> {
  "use step";
  const apiKey = await getApiKeyFromEnv("openai", entry.credentials);
  try {
    const res = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: entry.model,
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
  } catch (error) {
    console.error("OpenAI moderation failed:", error);
    return {
      url: entry.url,
      sexual: 0,
      violence: 0,
      error: true,
    };
  }
}

async function requestOpenAIModeration(
  imageUrls: string[],
  model: string,
  maxConcurrent: number = 5,
  submissionMode: "url" | "base64" = "url",
  downloadOptions?: ImageDownloadOptions,
  credentials?: WorkflowCredentialsInput,
): Promise<ThumbnailModerationScore[]> {
  "use step";
  const targetUrls =
    submissionMode === "base64" ?
        (await downloadImagesAsBase64(imageUrls, downloadOptions, maxConcurrent)).map(
          img => ({ url: img.url, image: img.base64Data, model, credentials }),
        ) :
        imageUrls.map(url => ({ url, image: url, model, credentials }));

  return processConcurrently(targetUrls, moderateImageWithOpenAI, maxConcurrent);
}

async function requestOpenAITextModeration(
  text: string,
  model: string,
  url: string,
  credentials?: WorkflowCredentialsInput,
): Promise<ThumbnailModerationScore> {
  "use step";
  const apiKey = await getApiKeyFromEnv("openai", credentials);
  try {
    const res = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text,
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
      url,
      sexual: categoryScores.sexual || 0,
      violence: categoryScores.violence || 0,
      error: false,
    };
  } catch (error) {
    console.error("OpenAI text moderation failed:", error);
    return {
      url,
      sexual: 0,
      violence: 0,
      error: true,
    };
  }
}

function chunkTextByUtf16CodeUnits(text: string, maxUnits: number): string[] {
  if (!text.trim()) {
    return [];
  }
  if (text.length <= maxUnits) {
    return [text];
  }
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxUnits) {
    const chunk = text.slice(i, i + maxUnits).trim();
    if (chunk) {
      chunks.push(chunk);
    }
  }
  return chunks;
}

async function requestOpenAITranscriptModeration(
  transcriptText: string,
  model: string,
  maxConcurrent: number = 5,
  credentials?: WorkflowCredentialsInput,
): Promise<ThumbnailModerationScore[]> {
  "use step";
  // OpenAI supports larger inputs, but chunking avoids pathological single-request sizes and
  // mirrors our "max over segments" behavior used for thumbnail moderation.
  const chunks = chunkTextByUtf16CodeUnits(transcriptText, 10_000);
  if (!chunks.length) {
    return [
      { url: "transcript:0", sexual: 0, violence: 0, error: true },
    ];
  }
  const targets = chunks.map((chunk, idx) => ({
    chunk,
    url: `transcript:${idx}`,
  }));
  return processConcurrently(
    targets,
    async entry => requestOpenAITextModeration(entry.chunk, model, entry.url, credentials),
    maxConcurrent,
  );
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

async function moderateImageWithHive(entry: {
  url: string;
  source: HiveModerationSource;
  credentials?: WorkflowCredentialsInput;
}): Promise<ThumbnailModerationScore> {
  "use step";
  const apiKey = await getApiKeyFromEnv("hive", entry.credentials);
  try {
    const formData = new FormData();

    if (entry.source.kind === "url") {
      formData.append("url", entry.source.value);
    } else {
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
  } catch (error) {
    console.error("Hive moderation failed:", error);
    return {
      url: entry.url,
      sexual: 0,
      violence: 0,
      error: true,
    };
  }
}

async function requestHiveModeration(
  imageUrls: string[],
  maxConcurrent: number = 5,
  submissionMode: "url" | "base64" = "url",
  downloadOptions?: ImageDownloadOptions,
  credentials?: WorkflowCredentialsInput,
): Promise<ThumbnailModerationScore[]> {
  "use step";
  const targets: Array<{ url: string; source: HiveModerationSource; credentials?: WorkflowCredentialsInput }> =
    submissionMode === "base64" ?
        (await downloadImagesAsBase64(imageUrls, downloadOptions, maxConcurrent)).map(img => ({
          url: img.url,
          source: {
            kind: "file",
            buffer: img.buffer,
            contentType: img.contentType,
          },
          credentials,
        })) :
        imageUrls.map(url => ({
          url,
          source: { kind: "url", value: url },
          credentials,
        }));

  return processConcurrently(targets, moderateImageWithHive, maxConcurrent);
}

/**
 * Moderate a Mux asset.
 * - Video assets: moderates storyboard thumbnails (image moderation)
 * - Audio-only assets: moderates transcript text (text moderation)
 *
 * Provider notes:
 * - provider 'openai' uses OpenAI's hosted moderation endpoint (requires OPENAI_API_KEY)
 *   Ref: https://platform.openai.com/docs/guides/moderation
 * - provider 'hive' uses Hive's moderation API for thumbnails only (requires HIVE_API_KEY)
 */
export async function getModerationScores(
  assetId: string,
  options: ModerationOptions = {},
): Promise<ModerationResult> {
  "use workflow";
  const {
    provider = DEFAULT_PROVIDER,
    model = provider === "openai" ? "omni-moderation-latest" : undefined,
    languageCode,
    thresholds = DEFAULT_THRESHOLDS,
    thumbnailInterval = 10,
    thumbnailWidth = 640,
    maxConcurrent = 5,
    imageSubmissionMode = "url",
    imageDownloadOptions,
    credentials,
  } = options;

  // Fetch asset data and playback ID from Mux via helper
  const { asset, playbackId, policy } = await getPlaybackIdForAsset(assetId, credentials);
  const duration = asset.duration || 0;
  const isAudioOnly = isAudioOnlyAsset(asset);

  // Resolve signing context for signed playback IDs
  const signingContext = await resolveMuxSigningContext(credentials);
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. " +
      "Provide muxSigningKey and muxPrivateKey in options or set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  let thumbnailScores: ThumbnailModerationScore[];
  let mode: ModerationResult["mode"] = "thumbnails";

  if (isAudioOnly) {
    mode = "transcript";
    const readyTextTracks = getReadyTextTracks(asset);
    let transcriptResult = await fetchTranscriptForAsset(asset, playbackId, {
      languageCode,
      cleanTranscript: true,
      shouldSign: policy === "signed",
      credentials,
      required: true,
    });

    // Audio-only assets may have a single ready text track that isn't "subtitles" (e.g. transcripts).
    // If a language-specific subtitle wasn't found but there's exactly one track, fall back to it.
    if (!transcriptResult.track && readyTextTracks.length === 1) {
      transcriptResult = await fetchTranscriptForAsset(asset, playbackId, {
        cleanTranscript: true,
        shouldSign: policy === "signed",
        credentials,
        required: true,
      });
    }

    if (provider === "openai") {
      thumbnailScores = await requestOpenAITranscriptModeration(
        transcriptResult.transcriptText,
        model || "omni-moderation-latest",
        maxConcurrent,
        credentials,
      );
    } else if (provider === "hive") {
      throw new Error("Hive does not support transcript moderation in this workflow. Use provider: 'openai' for audio-only assets.");
    } else {
      throw new Error(`Unsupported moderation provider: ${provider}`);
    }
  } else {
    // Generate thumbnail URLs (signed if needed)
    const thumbnailUrls = await getThumbnailUrls(playbackId, duration, {
      interval: thumbnailInterval,
      width: thumbnailWidth,
      shouldSign: policy === "signed",
      credentials,
    });

    if (provider === "openai") {
      thumbnailScores = await requestOpenAIModeration(
        thumbnailUrls,
        model || "omni-moderation-latest",
        maxConcurrent,
        imageSubmissionMode,
        imageDownloadOptions,
        credentials,
      );
    } else if (provider === "hive") {
      thumbnailScores = await requestHiveModeration(
        thumbnailUrls,
        maxConcurrent,
        imageSubmissionMode,
        imageDownloadOptions,
        credentials,
      );
    } else {
      throw new Error(`Unsupported moderation provider: ${provider}`);
    }
  }

  // Find highest scores across all thumbnails
  const maxSexual = Math.max(...thumbnailScores.map(s => s.sexual));
  const maxViolence = Math.max(...thumbnailScores.map(s => s.violence));

  const finalThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };

  return {
    assetId,
    mode,
    isAudioOnly,
    thumbnailScores,
    maxScores: {
      sexual: maxSexual,
      violence: maxViolence,
    },
    exceedsThreshold: maxSexual > finalThresholds.sexual || maxViolence > finalThresholds.violence,
    thresholds: finalThresholds,
  };
}
