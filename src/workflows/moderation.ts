import { getApiKeyFromEnv } from "@mux/ai/lib/client-factory";
import type { ImageDownloadOptions } from "@mux/ai/lib/image-download";
import { downloadImagesAsBase64 } from "@mux/ai/lib/image-download";
import {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  getVideoTrackDurationSecondsFromAsset,
  getVideoTrackMaxFrameRateFromAsset,
  isAudioOnlyAsset,
} from "@mux/ai/lib/mux-assets";
import { getMuxThumbnailBaseUrl } from "@mux/ai/lib/mux-image-url";
import { planSamplingTimestamps } from "@mux/ai/lib/sampling-plan";
import { signUrl } from "@mux/ai/lib/url-signing";
import { resolveMuxSigningContext } from "@mux/ai/lib/workflow-credentials";
import { getThumbnailUrls } from "@mux/ai/primitives/thumbnails";
import { fetchTranscriptForAsset, getReadyTextTracks } from "@mux/ai/primitives/transcripts";
import type {
  ImageSubmissionMode,
  MuxAIOptions,
  TokenUsage,
  WorkflowCredentialsInput,
} from "@mux/ai/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Per-thumbnail moderation result returned from `getModerationScores`. */
export interface ThumbnailModerationScore {
  url: string;
  sexual: number;
  violence: number;
  error: boolean;
  errorMessage?: string;
}

/** Aggregated moderation payload returned from `getModerationScores`. */
export interface ModerationResult {
  assetId: string;
  /** Whether moderation ran on thumbnails (video) or transcript text (audio-only). */
  mode: "thumbnails" | "transcript";
  /** Convenience flag so callers can understand why `thumbnailScores` may contain a transcript entry. */
  isAudioOnly: boolean;
  thumbnailScores: ThumbnailModerationScore[];
  /** Workflow usage metadata (asset duration, thumbnails, etc.). */
  usage?: TokenUsage;
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
  /** Maximum number of thumbnails to sample (defaults to unlimited). When set, samples are evenly distributed with first and last frames pinned. */
  maxSamples?: number;
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
  sexual: 0.8,
  violence: 0.8,
};

const DEFAULT_PROVIDER = "openai";

const HIVE_ENDPOINT = "https://api.thehive.ai/api/v2/task/sync";
export const HIVE_SEXUAL_CATEGORIES = [
  "general_nsfw",
  "yes_sexual_activity",
  "yes_sex_toy",
  "yes_female_nudity",
  "yes_male_nudity",
];

export const HIVE_VIOLENCE_CATEGORIES = [
  "gun_in_hand",
  "gun_not_in_hand",
  "knife_in_hand",
  "very_bloody",
  "other_blood",
  "hanging",
  "noose",
  "human_corpse",
  "yes_emaciated_body",
  "yes_self_harm",
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
      errorMessage: error instanceof Error ? error.message : String(error),
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
      errorMessage: error instanceof Error ? error.message : String(error),
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
      { url: "transcript:0", sexual: 0, violence: 0, error: true, errorMessage: "No transcript chunks to moderate" },
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
  const missingCategories = categoryNames.filter(category => !(category in scoreMap));
  if (missingCategories.length > 0) {
    console.warn(
      `Hive response missing expected categories: ${missingCategories.join(", ")}`,
    );
  }
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(HIVE_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Token ${apiKey}`,
        },
        body: formData,
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new Error("Hive request timed out after 15s");
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    const json: any = await res.json().catch(() => undefined);

    if (!res.ok) {
      throw new Error(
        `Hive moderation error: ${res.status} ${res.statusText} - ${JSON.stringify(json)}`,
      );
    }

    if (json?.return_code != null && json.return_code !== 0) {
      throw new Error(
        `Hive API error (return_code ${json.return_code}): ${json.message || "Unknown error"}`,
      );
    }

    // Extract scores from Hive response
    // Hive returns scores in status[0].response.output[0].classes as array of {class, score}
    const classes = json?.status?.[0]?.response?.output?.[0]?.classes;
    if (!Array.isArray(classes)) {
      throw new TypeError(
        `Unexpected Hive response structure: ${JSON.stringify(json)}`,
      );
    }

    const sexual = getHiveCategoryScores(classes, HIVE_SEXUAL_CATEGORIES);
    const violence = getHiveCategoryScores(classes, HIVE_VIOLENCE_CATEGORIES);

    return {
      url: entry.url,
      sexual,
      violence,
      error: false,
    };
  } catch (error) {
    return {
      url: entry.url,
      sexual: 0,
      violence: 0,
      error: true,
      errorMessage: error instanceof Error ? error.message : String(error),
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

  return await processConcurrently(targets, moderateImageWithHive, maxConcurrent);
}

async function getThumbnailUrlsFromTimestamps(
  playbackId: string,
  timestampsMs: number[],
  options: {
    width: number;
    shouldSign: boolean;
    credentials?: WorkflowCredentialsInput;
  },
): Promise<string[]> {
  "use step";
  const { width, shouldSign, credentials } = options;
  const baseUrl = getMuxThumbnailBaseUrl(playbackId);

  const urlPromises = timestampsMs.map(async (tsMs) => {
    const time = Number((tsMs / 1000).toFixed(2));
    if (shouldSign) {
      return signUrl(baseUrl, playbackId, "thumbnail", { time, width }, credentials);
    }

    return `${baseUrl}?time=${time}&width=${width}`;
  });

  return Promise.all(urlPromises);
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
    maxSamples,
    maxConcurrent = 5,
    imageSubmissionMode = "url",
    imageDownloadOptions,
    credentials: providedCredentials,
  } = options;
  const credentials = providedCredentials;
  // Fetch asset data and playback ID from Mux via helper
  const { asset, playbackId, policy } = await getPlaybackIdForAsset(assetId, credentials);
  const videoTrackDurationSeconds = getVideoTrackDurationSecondsFromAsset(asset);
  const videoTrackFps = getVideoTrackMaxFrameRateFromAsset(asset);
  const assetDurationSeconds = getAssetDurationSecondsFromAsset(asset);
  // Use the shorter of video-track and asset duration so thumbnail timestamps never
  // exceed the renderable range reported by the Mux thumbnail service.
  const candidateDurations = [videoTrackDurationSeconds, assetDurationSeconds].filter(
    (d): d is number => d != null,
  );
  const duration = candidateDurations.length > 0 ? Math.min(...candidateDurations) : 0;
  const isAudioOnly = isAudioOnlyAsset(asset);

  // Resolve signing context for signed playback IDs
  const signingContext = await resolveMuxSigningContext(credentials);
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. " +
      "Set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  let thumbnailScores: ThumbnailModerationScore[];
  let mode: ModerationResult["mode"] = "thumbnails";
  let thumbnailCount: number | undefined;

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
    const thumbnailUrls = maxSamples === undefined ?
        // Generate thumbnail URLs (signed if needed) using existing interval-based logic.
        await getThumbnailUrls(playbackId, duration, {
          interval: thumbnailInterval,
          width: thumbnailWidth,
          shouldSign: policy === "signed",
          credentials,
        }) :
        // In maxSamples mode, sample valid timestamps over the trimmed usable span.
        // Use proportional trims (≈ duration/6, capped at 5s) to stay well inside the
        // renderable range — Mux can't always serve thumbnails at the very edges.
        await getThumbnailUrlsFromTimestamps(
          playbackId,
          planSamplingTimestamps({
            duration_sec: duration,
            max_candidates: maxSamples,
            trim_start_sec: duration > 2 ? Math.min(5, Math.max(1, duration / 6)) : 0,
            trim_end_sec: duration > 2 ? Math.min(5, Math.max(1, duration / 6)) : 0,
            fps: videoTrackFps,
            base_cadence_hz: thumbnailInterval > 0 ? 1 / thumbnailInterval : undefined,
          }),
          {
            width: thumbnailWidth,
            shouldSign: policy === "signed",
            credentials,
          },
        );
    thumbnailCount = thumbnailUrls.length;

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

  const failed = thumbnailScores.filter(s => s.error);
  if (failed.length > 0) {
    const details = failed.map(s => `${s.url}: ${s.errorMessage || "Unknown error"}`).join("; ");
    throw new Error(
      `Moderation failed for ${failed.length}/${thumbnailScores.length} thumbnail(s): ${details}`,
    );
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
    usage: {
      metadata: {
        assetDurationSeconds: duration,
        ...(thumbnailCount === undefined ? {} : { thumbnailCount }),
      },
    },
    maxScores: {
      sexual: maxSexual,
      violence: maxViolence,
    },
    exceedsThreshold: maxSexual > finalThresholds.sexual || maxViolence > finalThresholds.violence,
    thresholds: finalThresholds,
  };
}
