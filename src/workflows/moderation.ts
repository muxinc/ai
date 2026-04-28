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
import { getMuxThumbnailBaseUrl } from "@mux/ai/lib/mux-url";
import { withRetry } from "@mux/ai/lib/retry";
import { planSamplingTimestamps } from "@mux/ai/lib/sampling-plan";
import { signUrl } from "@mux/ai/lib/url-signing";
import { resolveMuxSigningContext } from "@mux/ai/lib/workflow-credentials";
import { getThumbnailUrls } from "@mux/ai/primitives/thumbnails";
import { fetchTranscriptForAsset } from "@mux/ai/primitives/transcripts";
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
  /** Time in seconds of the thumbnail within the video. Absent for transcript moderation entries. */
  time?: number;
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
  /** Coverage metadata describing how many requested moderation samples actually succeeded. */
  coverage: {
    requestedSampleCount: number;
    successfulSampleCount: number;
    failedSampleCount: number;
    /** Fraction of requested samples that produced a usable moderation result. */
    sampleCoverage: number;
    /** True when at least one sample failed but the workflow still returned a result. */
    isPartial: boolean;
    /**
     * True when threshold interpretation should be treated cautiously.
     * For thumbnail moderation, this means we either covered less than half of planned samples
     * or ended up with fewer than 3 successful thumbnails.
     */
    isLowConfidence: boolean;
  };
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
export type ModerationProvider = "openai" | "hive" | "google-vision-api";

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
  /** Maximum number of thumbnails to sample (defaults to unlimited). Acts as a cap: if `thumbnailInterval` produces fewer samples than this limit the interval is respected; otherwise samples are evenly distributed with first and last frames pinned. */
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
const OPENAI_MODERATION_RETRIABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const OPENAI_MODERATION_MAX_RETRIES = 2;
const OPENAI_MODERATION_BASE_DELAY_MS = 750;
const OPENAI_MODERATION_MAX_DELAY_MS = 3000;
const MIN_SAMPLE_COVERAGE_FOR_CONFIDENT_THRESHOLDING = 0.5;
const MIN_SUCCESSFUL_THUMBNAILS_FOR_CONFIDENT_THRESHOLDING = 3;

const GOOGLE_VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";

/**
 * Linear mapping of Google Vision SafeSearch `Likelihood` enum (UNKNOWN..VERY_LIKELY)
 * onto a 0..1 score. This mapping may change in future versions of `@mux/ai`.
 */
export const GOOGLE_VISION_LIKELIHOOD_TO_SCORE: Record<string, number> = {
  UNKNOWN: 0,
  VERY_UNLIKELY: 0.2,
  UNLIKELY: 0.4,
  POSSIBLE: 0.6,
  LIKELY: 0.8,
  VERY_LIKELY: 1,
};

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

class OpenAIModerationRequestError extends Error {
  readonly status?: number;
  readonly retriable: boolean;

  constructor(
    message: string,
    {
      status,
      retriable,
    }: {
      status?: number;
      retriable: boolean;
    },
  ) {
    super(message);
    this.name = "OpenAIModerationRequestError";
    this.status = status;
    this.retriable = retriable;
  }
}

function isRetriableOpenAIModerationStatus(status: number): boolean {
  return OPENAI_MODERATION_RETRIABLE_STATUS_CODES.has(status);
}

function compactBodySnippet(body: string, maxLength: number = 180): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "(empty response body)";
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function parseOpenAIModerationResponse(
  bodyText: string,
  status: number,
  statusText: string,
): any {
  if (!bodyText.trim()) {
    throw new OpenAIModerationRequestError(
      `OpenAI moderation returned an empty response (${status} ${statusText}).`,
      { status, retriable: isRetriableOpenAIModerationStatus(status) },
    );
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    throw new OpenAIModerationRequestError(
      `OpenAI moderation returned non-JSON response (${status} ${statusText}): ${compactBodySnippet(bodyText)}`,
      { status, retriable: true },
    );
  }
}

async function callOpenAIModerationApi({
  model,
  input,
  credentials,
}: {
  model: string;
  input: string | Array<{ type: "image_url"; image_url: { url: string } }>;
  credentials?: WorkflowCredentialsInput;
}): Promise<any> {
  "use step";
  const apiKey = await getApiKeyFromEnv("openai", credentials);

  return withRetry(
    async () => {
      let res: Response;

      try {
        res = await fetch("https://api.openai.com/v1/moderations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            input,
          }),
        });
      } catch (error) {
        throw new OpenAIModerationRequestError(
          `OpenAI moderation request failed: ${error instanceof Error ? error.message : String(error)}`,
          { retriable: true },
        );
      }

      const bodyText = await res.text();
      const json = parseOpenAIModerationResponse(bodyText, res.status, res.statusText);

      if (!res.ok) {
        throw new OpenAIModerationRequestError(
          `OpenAI moderation error: ${res.status} ${res.statusText} - ${JSON.stringify(json)}`,
          {
            status: res.status,
            retriable: isRetriableOpenAIModerationStatus(res.status),
          },
        );
      }

      return json;
    },
    {
      maxRetries: OPENAI_MODERATION_MAX_RETRIES,
      baseDelay: OPENAI_MODERATION_BASE_DELAY_MS,
      maxDelay: OPENAI_MODERATION_MAX_DELAY_MS,
      shouldRetry: error =>
        error instanceof OpenAIModerationRequestError ? error.retriable : true,
    },
  );
}

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
  time?: number;
  image: string;
  model: string;
  credentials?: WorkflowCredentialsInput;
}): Promise<ThumbnailModerationScore> {
  "use step";
  try {
    const json: any = await callOpenAIModerationApi({
      model: entry.model,
      input: [
        {
          type: "image_url",
          image_url: {
            url: entry.image,
          },
        },
      ],
      credentials: entry.credentials,
    });
    const categoryScores = json.results?.[0]?.category_scores || {};

    return {
      url: entry.url,
      time: entry.time,
      sexual: categoryScores.sexual || 0,
      violence: categoryScores.violence || 0,
      error: false,
    };
  } catch (error) {
    console.error("OpenAI moderation failed:", error);
    return {
      url: entry.url,
      time: entry.time,
      sexual: 0,
      violence: 0,
      error: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

async function requestOpenAIModeration(
  images: Array<{ url: string; time: number }>,
  model: string,
  maxConcurrent: number = 5,
  submissionMode: "url" | "base64" = "url",
  downloadOptions?: ImageDownloadOptions,
  credentials?: WorkflowCredentialsInput,
): Promise<ThumbnailModerationScore[]> {
  "use step";
  const imageUrls = images.map(img => img.url);
  const timeByUrl = new Map(images.map(img => [img.url, img.time]));

  const targetUrls =
    submissionMode === "base64" ?
        (await downloadImagesAsBase64(imageUrls, downloadOptions, maxConcurrent)).map(
          img => ({ url: img.url, time: timeByUrl.get(img.url), image: img.base64Data, model, credentials }),
        ) :
        images.map(img => ({ url: img.url, time: img.time, image: img.url, model, credentials }));

  return processConcurrently(targetUrls, moderateImageWithOpenAI, maxConcurrent);
}

async function requestOpenAITextModeration(
  text: string,
  model: string,
  url: string,
  credentials?: WorkflowCredentialsInput,
): Promise<ThumbnailModerationScore> {
  "use step";
  try {
    const json: any = await callOpenAIModerationApi({
      model,
      input: text,
      credentials,
    });
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
  time?: number;
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
      time: entry.time,
      sexual,
      violence,
      error: false,
    };
  } catch (error) {
    return {
      url: entry.url,
      time: entry.time,
      sexual: 0,
      violence: 0,
      error: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

async function requestHiveModeration(
  images: Array<{ url: string; time: number }>,
  maxConcurrent: number = 5,
  submissionMode: "url" | "base64" = "url",
  downloadOptions?: ImageDownloadOptions,
  credentials?: WorkflowCredentialsInput,
): Promise<ThumbnailModerationScore[]> {
  "use step";

  const imageUrls = images.map(img => img.url);
  const timeByUrl = new Map(images.map(img => [img.url, img.time]));

  const targets: Array<{ url: string; time?: number; source: HiveModerationSource; credentials?: WorkflowCredentialsInput }> =
    submissionMode === "base64" ?
        (await downloadImagesAsBase64(imageUrls, downloadOptions, maxConcurrent)).map(img => ({
          url: img.url,
          time: timeByUrl.get(img.url),
          source: {
            kind: "file",
            buffer: img.buffer,
            contentType: img.contentType,
          },
          credentials,
        })) :
        images.map(img => ({
          url: img.url,
          time: img.time,
          source: { kind: "url", value: img.url },
          credentials,
        }));

  return await processConcurrently(targets, moderateImageWithHive, maxConcurrent);
}

async function moderateImageWithGoogleVision(entry: {
  url: string;
  time?: number;
  image: string;
  isBase64: boolean;
  credentials?: WorkflowCredentialsInput;
}): Promise<ThumbnailModerationScore> {
  "use step";
  try {
    const apiKey = await getApiKeyFromEnv("google-vision-api", entry.credentials);

    const imageField =
      entry.isBase64 ?
          { content: entry.image } :
          { source: { imageUri: entry.image } };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(GOOGLE_VISION_ENDPOINT, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "X-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          requests: [
            {
              image: imageField,
              features: [{ type: "SAFE_SEARCH_DETECTION" }],
            },
          ],
        }),
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new Error("Google Vision request timed out after 15s");
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    const json: any = await res.json().catch(() => undefined);

    if (!res.ok) {
      throw new Error(
        `Google Vision moderation error: ${res.status} ${res.statusText} - ${JSON.stringify(json)}`,
      );
    }

    const perImage = json?.responses?.[0];
    if (perImage?.error) {
      throw new Error(
        `Google Vision per-image error: ${perImage.error.code} ${perImage.error.message || "Unknown error"}`,
      );
    }

    const annotation = perImage?.safeSearchAnnotation;
    if (!annotation) {
      throw new Error(`Google Vision response missing safeSearchAnnotation: ${JSON.stringify(json)}`);
    }

    const adultLikelihood = typeof annotation.adult === "string" ? annotation.adult : "UNKNOWN";
    const violenceLikelihood = typeof annotation.violence === "string" ? annotation.violence : "UNKNOWN";

    const sexual = GOOGLE_VISION_LIKELIHOOD_TO_SCORE[adultLikelihood] ?? 0;
    const violence = GOOGLE_VISION_LIKELIHOOD_TO_SCORE[violenceLikelihood] ?? 0;

    return {
      url: entry.url,
      time: entry.time,
      sexual,
      violence,
      error: false,
    };
  } catch (error) {
    return {
      url: entry.url,
      time: entry.time,
      sexual: 0,
      violence: 0,
      error: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

async function requestGoogleVisionModeration(
  images: Array<{ url: string; time: number }>,
  maxConcurrent: number = 5,
  submissionMode: "url" | "base64" = "url",
  downloadOptions?: ImageDownloadOptions,
  credentials?: WorkflowCredentialsInput,
): Promise<ThumbnailModerationScore[]> {
  "use step";

  const imageUrls = images.map(img => img.url);
  const timeByUrl = new Map(images.map(img => [img.url, img.time]));

  const targets =
    submissionMode === "base64" ?
        (await downloadImagesAsBase64(imageUrls, downloadOptions, maxConcurrent)).map(img => ({
          url: img.url,
          time: timeByUrl.get(img.url),
          // Vision REST wants raw base64; downloadImagesAsBase64 returns a data URI.
          image: img.base64Data.startsWith("data:") ? img.base64Data.split(",")[1] : img.base64Data,
          isBase64: true,
          credentials,
        })) :
        images.map(img => ({
          url: img.url,
          time: img.time,
          image: img.url,
          isBase64: false,
          credentials,
        }));

  return processConcurrently(targets, moderateImageWithGoogleVision, maxConcurrent);
}

async function getThumbnailUrlsFromTimestamps(
  playbackId: string,
  timestampsMs: number[],
  options: {
    width: number;
    shouldSign: boolean;
    credentials?: WorkflowCredentialsInput;
  },
): Promise<Array<{ url: string; time: number }>> {
  "use step";
  const { width, shouldSign, credentials } = options;
  const baseUrl = getMuxThumbnailBaseUrl(playbackId);

  const urlPromises = timestampsMs.map(async (tsMs) => {
    const time = Number((tsMs / 1000).toFixed(2));
    const url = shouldSign ?
        await signUrl(baseUrl, playbackId, "thumbnail", { time, width }, credentials) :
      `${baseUrl}?time=${time}&width=${width}`;

    return { url, time };
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
 * - provider 'google-vision-api' uses Google Cloud Vision SafeSearch for thumbnails only
 *   (requires GOOGLE_VISION_API_KEY).
 *   Ref: https://cloud.google.com/vision/docs/detecting-safe-search
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
    const transcriptResult = await fetchTranscriptForAsset(asset, playbackId, {
      languageCode,
      cleanTranscript: true,
      shouldSign: policy === "signed",
      credentials,
      required: true,
    });

    if (provider === "openai") {
      thumbnailScores = await requestOpenAITranscriptModeration(
        transcriptResult.transcriptText,
        model || "omni-moderation-latest",
        maxConcurrent,
        credentials,
      );
    } else if (provider === "hive") {
      throw new Error("Hive does not support transcript moderation in this workflow. Use provider: 'openai' for audio-only assets.");
    } else if (provider === "google-vision-api") {
      throw new Error("google-vision-api is image-only and does not support transcript moderation. Use provider: 'openai' for audio-only assets.");
    } else {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported moderation provider: ${exhaustiveCheck}`);
    }
  } else {
    // Cheaply estimate how many thumbnails the interval would produce so we
    // can skip generating (and potentially JWT-signing) URLs we'd discard.
    const estimatedIntervalCount = duration <= 50 ? 5 : Math.ceil(duration / thumbnailInterval);

    // maxSamples acts as a true cap: if the interval already fits within the
    // budget we use the interval-based path. Only when the interval would
    // produce more thumbnails than allowed do we switch to the sampling plan.
    const thumbnailUrls =
      maxSamples !== undefined && estimatedIntervalCount > maxSamples ?
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
          ) :
          await getThumbnailUrls(playbackId, duration, {
            interval: thumbnailInterval,
            width: thumbnailWidth,
            shouldSign: policy === "signed",
            credentials,
          });
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
    } else if (provider === "google-vision-api") {
      thumbnailScores = await requestGoogleVisionModeration(
        thumbnailUrls,
        maxConcurrent,
        imageSubmissionMode,
        imageDownloadOptions,
        credentials,
      );
    } else {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported moderation provider: ${exhaustiveCheck}`);
    }
  }

  const failed = thumbnailScores.filter(s => s.error);
  const successful = thumbnailScores.filter(s => !s.error);
  if (successful.length === 0) {
    const details = failed.map(s => `${s.url}: ${s.errorMessage || "Unknown error"}`).join("; ");
    throw new Error(
      `Moderation failed for all ${thumbnailScores.length} sample(s): ${details}`,
    );
  }

  if (failed.length > 0) {
    console.warn(
      `Moderation had partial failures (${failed.length}/${thumbnailScores.length}); continuing with successful samples.`,
    );
  }

  // Find highest scores across all thumbnails
  const maxSexual = Math.max(...successful.map(s => s.sexual));
  const maxViolence = Math.max(...successful.map(s => s.violence));

  const finalThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const requestedSampleCount = thumbnailScores.length;
  const successfulSampleCount = successful.length;
  const failedSampleCount = failed.length;
  const sampleCoverage = successfulSampleCount / requestedSampleCount;
  const hasEnoughSuccessfulSamples = mode === "transcript" ||
    successfulSampleCount >= MIN_SUCCESSFUL_THUMBNAILS_FOR_CONFIDENT_THRESHOLDING;
  const isLowConfidence = sampleCoverage < MIN_SAMPLE_COVERAGE_FOR_CONFIDENT_THRESHOLDING ||
    !hasEnoughSuccessfulSamples;

  return {
    assetId,
    mode,
    isAudioOnly,
    thumbnailScores,
    coverage: {
      requestedSampleCount,
      successfulSampleCount,
      failedSampleCount,
      sampleCoverage,
      isPartial: failedSampleCount > 0,
      isLowConfidence,
    },
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
