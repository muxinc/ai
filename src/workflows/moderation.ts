import { getApiKeyFromEnv } from "../lib/client-factory.ts";
import type { ImageDownloadOptions } from "../lib/image-download.ts";
import { downloadImagesAsBase64 } from "../lib/image-download.ts";
import {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  getVideoTrackDurationSecondsFromAsset,
  getVideoTrackMaxFrameRateFromAsset,
  isAudioOnlyAsset,
} from "../lib/mux-assets.ts";
import { getMuxThumbnailBaseUrl } from "../lib/mux-url.ts";
import { withRetry } from "../lib/retry.ts";
import { planSamplingTimestamps } from "../lib/sampling-plan.ts";
import { signUrl } from "../lib/url-signing.ts";
import { resolveMuxSigningContext } from "../lib/workflow-credentials.ts";
import { getThumbnailUrls } from "../primitives/thumbnails.ts";
import type { VTTCue } from "../primitives/transcripts.ts";
import { fetchTranscriptForAsset, parseVTTCues } from "../primitives/transcripts.ts";
import type {
  ImageSubmissionMode,
  MuxAIOptions,
  TokenUsage,
  WorkflowCredentialsInput,
} from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Per-thumbnail (image) moderation result returned from `getModerationScores`. */
export interface ThumbnailModerationScore {
  url: string;
  /** Time in seconds of the thumbnail within the video. */
  time?: number;
  sexual: number;
  violence: number;
  error: boolean;
  errorMessage?: string;
}

/** Per-time-window transcript moderation result returned from `getModerationScores`. */
export interface TranscriptModerationScore {
  /** Seconds — start of the moderated time window (first cue's start time). */
  startTime: number;
  /** Seconds — end of the moderated time window (last cue's end time). */
  endTime: number;
  sexual: number;
  violence: number;
  error: boolean;
  errorMessage?: string;
}

/** Aggregated moderation payload returned from `getModerationScores`. */
export interface ModerationResult {
  assetId: string;
  /**
   * What was moderated:
   * - `"thumbnails"`: only image thumbnails (video without transcript moderation).
   * - `"transcript"`: only transcript text (audio-only assets).
   * - `"combined"`: both thumbnails and transcript text (video with `includeTranscript`).
   */
  mode: "thumbnails" | "transcript" | "combined";
  /** Convenience flag indicating the asset has no video track (transcript-only moderation). */
  isAudioOnly: boolean;
  /** Image (thumbnail) moderation results. Empty for audio-only assets. */
  thumbnailScores: ThumbnailModerationScore[];
  /**
   * Transcript moderation results, one entry per moderated time window
   * (each carries `startTime`/`endTime`). Empty unless audio-only or
   * `includeTranscript` produced scores.
   */
  transcriptScores: TranscriptModerationScore[];
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
  /**
   * When true, also moderate transcript text for video assets, in addition to thumbnails.
   * No effect on audio-only assets, which always moderate transcript text.
   * If set but no ready text track exists, transcript moderation is skipped silently;
   * transcription is never triggered. Only supported with provider 'openai'.
   * @default false
   */
  includeTranscript?: boolean;
  /**
   * Tuning for transcript time-windowing. All optional; sensible defaults applied.
   *
   * Transcript moderation splits the caption track into overlapping time windows
   * whose size scales with the asset's duration:
   *   `windowSeconds = clamp(duration / targetWindowCount, minWindowSeconds, maxWindowSeconds)`
   * and consecutive windows overlap by `max(minOverlapSeconds, windowSeconds * overlapFraction)`
   * so content straddling a window boundary is still scored intact in at least one window.
   */
  transcriptWindowing?: {
    /** Divisor used to derive the base window size from duration. @default 40 */
    targetWindowCount?: number;
    /** Lower clamp on window size, in seconds. @default 20 */
    minWindowSeconds?: number;
    /** Upper clamp on window size, in seconds. @default 120 */
    maxWindowSeconds?: number;
    /** Fraction (0..1) of the window size used as overlap. @default 0.15 */
    overlapFraction?: number;
    /** Lower clamp on the overlap, in seconds. @default 5 */
    minOverlapSeconds?: number;
  };
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

/**
 * Default tuning for transcript time-windowing. Window SIZE scales with the
 * asset's duration and consecutive windows OVERLAP so abuse straddling a
 * boundary is still scored intact in at least one window:
 *
 *   windowSeconds  = clamp(duration / targetWindowCount, minWindowSeconds, maxWindowSeconds)
 *   overlapSeconds = max(minOverlapSeconds, windowSeconds * overlapFraction)
 *   stride         = max(windowSeconds - overlapSeconds, 1)
 *
 * Callers may override any of these via `ModerationOptions.transcriptWindowing`.
 */
const DEFAULT_TRANSCRIPT_WINDOWING = {
  targetWindowCount: 40,
  minWindowSeconds: 20,
  maxWindowSeconds: 120,
  overlapFraction: 0.15,
  minOverlapSeconds: 5,
} as const;

/** Fully-resolved transcript windowing parameters (no optionals). */
interface ResolvedTranscriptWindowingParams {
  targetWindowCount: number;
  minWindowSeconds: number;
  maxWindowSeconds: number;
  overlapFraction: number;
  minOverlapSeconds: number;
}

/**
 * Maximum number of UTF-16 code units of concatenated cue text we send to
 * OpenAI's moderation endpoint per BATCH request. OpenAI's moderation API
 * accepts an array `input` and returns one `results[]` entry per element with
 * no documented array-length cap — the real bound is the model's context
 * window — so we batch multiple windows per request and cap the combined
 * character budget conservatively.
 */
const TRANSCRIPT_BATCH_MAX_UTF16_CODE_UNITS = 100_000;

/** Maximum number of window texts packed into a single batched moderation request. */
const TRANSCRIPT_BATCH_MAX_ITEMS = 100;

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
  input:
    | string |
    string[] |
    Array<{ type: "image_url"; image_url: { url: string } }>;
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

/**
 * Hard ceiling on the UTF-16 code units of a SINGLE window's concatenated cue
 * text. The dynamic, duration-driven windowing below is the primary driver of
 * window size; this constant is only a rare safety guard so a single window
 * built over a very dense stretch of speech can never exceed the moderation
 * input budget. Such a window is split into sub-windows under the cap (cues
 * stay atomic), each carrying its own cue span as `[startTime, endTime]`.
 */
const TRANSCRIPT_WINDOW_MAX_UTF16_CODE_UNITS = 10_000;

/** A time-bounded window of transcript text built from caption cues. */
interface TranscriptWindow {
  startTime: number;
  endTime: number;
  text: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Split a window's cues into sub-windows whose joined text stays under
 * {@link TRANSCRIPT_WINDOW_MAX_UTF16_CODE_UNITS}. Cues are never split; each
 * emitted sub-window carries its own cue span as `[startTime, endTime]`.
 *
 * A single cue whose text alone already exceeds the cap is emitted as its own
 * sub-window (its text is sent as-is — OpenAI truncation is acceptable — so the
 * timecodes stay accurate).
 */
function splitCuesUnderCharCeiling(
  cues: VTTCue[],
  maxUnits: number = TRANSCRIPT_WINDOW_MAX_UTF16_CODE_UNITS,
): TranscriptWindow[] {
  const windows: TranscriptWindow[] = [];
  let current: VTTCue[] = [];
  let currentLength = 0;

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    windows.push({
      startTime: Math.min(...current.map(cue => cue.startTime)),
      endTime: Math.max(...current.map(cue => cue.endTime)),
      text: current.map(cue => cue.text).join(" "),
    });
    current = [];
    currentLength = 0;
  };

  for (const cue of cues) {
    const cueText = cue.text;
    // +1 accounts for the space joiner between cues.
    const addedLength = currentLength === 0 ? cueText.length : currentLength + 1 + cueText.length;
    if (current.length > 0 && addedLength > maxUnits) {
      flush();
    }
    current.push(cue);
    currentLength = current.length === 1 ? cueText.length : currentLength + 1 + cueText.length;
  }
  flush();

  return windows;
}

/**
 * Build DYNAMIC, OVERLAPPING transcript windows from timestamped caption cues.
 *
 * Window SIZE scales with the asset's `duration` and consecutive windows
 * OVERLAP so abuse straddling a window boundary is still scored intact in at
 * least one window:
 *
 *   windowSeconds  = clamp(duration / targetWindowCount, minWindowSeconds, maxWindowSeconds)
 *   overlapSeconds = max(minOverlapSeconds, windowSeconds * overlapFraction)
 *   stride         = max(windowSeconds - overlapSeconds, 1)   // never <= 0
 *
 * Window k covers the time interval `[k*stride, k*stride + windowSeconds]`. A
 * cue belongs to window k when it intersects that interval, so boundary cues
 * appear in both neighbouring windows. Empty windows (gaps of silence) are
 * skipped, and two consecutive windows containing the exact same cue set are
 * deduped to avoid a redundant request. A window whose joined text would exceed
 * {@link TRANSCRIPT_WINDOW_MAX_UTF16_CODE_UNITS} is split into sub-windows under
 * the cap as a rare safety guard.
 *
 * NOTE: because windows overlap by design, consecutive windows' reported
 * `[startTime, endTime]` ranges may overlap by ~`overlapSeconds`.
 *
 * Exported for direct unit testing without network access.
 */
export function buildTranscriptWindows(
  cues: VTTCue[],
  duration: number,
  params: ResolvedTranscriptWindowingParams = DEFAULT_TRANSCRIPT_WINDOWING,
): TranscriptWindow[] {
  const usableCues = cues
    .filter(cue => cue.text.trim().length > 0)
    .slice()
    .sort((a, b) => a.startTime - b.startTime);
  if (usableCues.length === 0) {
    return [];
  }

  const lastCueEnd = Math.max(...usableCues.map(cue => cue.endTime));
  // Fall back to the last cue's end time when the asset duration is missing/0.
  const effectiveDuration = duration && duration > 0 ? duration : lastCueEnd;

  const windowSeconds = clamp(
    effectiveDuration / params.targetWindowCount,
    params.minWindowSeconds,
    params.maxWindowSeconds,
  );
  const overlapSeconds = Math.max(
    params.minOverlapSeconds,
    windowSeconds * params.overlapFraction,
  );
  const stride = Math.max(windowSeconds - overlapSeconds, 1);

  const rawWindows: VTTCue[][] = [];
  for (let k = 0; ; k++) {
    const windowStart = k * stride;
    if (windowStart > lastCueEnd) {
      break;
    }
    const windowEnd = windowStart + windowSeconds;
    // A cue intersects window k when it overlaps `[windowStart, windowEnd]`.
    const windowCues = usableCues.filter(
      cue => cue.startTime < windowEnd && cue.endTime > windowStart,
    );
    if (windowCues.length > 0) {
      rawWindows.push(windowCues);
    }
    // Guard against pathological non-advancing loops (stride is >= 1, so this
    // is belt-and-suspenders only).
    if (stride <= 0) {
      break;
    }
  }

  // Dedupe consecutive windows that contain the exact same cue set (possible
  // with sparse speech + overlap) to avoid a redundant API call.
  const dedupedCueGroups: VTTCue[][] = [];
  const cueGroupKey = (group: VTTCue[]) =>
    group.map(cue => `${cue.startTime}:${cue.endTime}`).join("|");
  let previousKey: string | undefined;
  for (const group of rawWindows) {
    const key = cueGroupKey(group);
    if (key === previousKey) {
      continue;
    }
    dedupedCueGroups.push(group);
    previousKey = key;
  }

  // Materialise windows, applying the rare hard-char-ceiling safety split.
  const windows: TranscriptWindow[] = [];
  for (const group of dedupedCueGroups) {
    const joinedLength = group.reduce(
      (sum, cue, index) => sum + cue.text.length + (index === 0 ? 0 : 1),
      0,
    );
    if (joinedLength > TRANSCRIPT_WINDOW_MAX_UTF16_CODE_UNITS) {
      windows.push(...splitCuesUnderCharCeiling(group));
    } else {
      windows.push({
        startTime: Math.min(...group.map(cue => cue.startTime)),
        endTime: Math.max(...group.map(cue => cue.endTime)),
        text: group.map(cue => cue.text).join(" "),
      });
    }
  }

  return windows;
}

/** A batch of transcript windows sent in a single array-`input` request. */
interface TranscriptModerationBatch {
  windows: TranscriptWindow[];
  model: string;
  credentials?: WorkflowCredentialsInput;
}

/**
 * Pack windows into batches whose combined text stays under
 * {@link TRANSCRIPT_BATCH_MAX_UTF16_CODE_UNITS} and whose item count stays
 * under {@link TRANSCRIPT_BATCH_MAX_ITEMS}. A single window larger than the
 * batch budget still occupies its own batch.
 */
function packWindowsIntoBatches(windows: TranscriptWindow[]): TranscriptWindow[][] {
  const batches: TranscriptWindow[][] = [];
  let current: TranscriptWindow[] = [];
  let currentLength = 0;

  for (const window of windows) {
    const wouldExceedChars =
      current.length > 0 && currentLength + window.text.length > TRANSCRIPT_BATCH_MAX_UTF16_CODE_UNITS;
    const wouldExceedItems = current.length >= TRANSCRIPT_BATCH_MAX_ITEMS;
    if (wouldExceedChars || wouldExceedItems) {
      batches.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(window);
    currentLength += window.text.length;
  }
  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

function transcriptErrorScore(
  window: TranscriptWindow,
  error: unknown,
): TranscriptModerationScore {
  return {
    startTime: window.startTime,
    endTime: window.endTime,
    sexual: 0,
    violence: 0,
    error: true,
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Moderate a batch of transcript windows in a single array-`input` request,
 * mapping each `results[i]` back to window `i`.
 *
 * Fallback: if the request fails with a 400 (too large) and the batch holds
 * more than one window, split the batch in half and retry each half
 * recursively (down to a single window). 429/5xx are handled by the existing
 * retry/backoff inside {@link callOpenAIModerationApi}. A window that still
 * fails yields an error `TranscriptModerationScore` carrying its timecodes.
 */
async function moderateTranscriptBatchWithOpenAI(
  batch: TranscriptModerationBatch,
): Promise<TranscriptModerationScore[]> {
  "use step";
  const { windows, model, credentials } = batch;
  if (windows.length === 0) {
    return [];
  }

  try {
    const json: any = await callOpenAIModerationApi({
      model,
      input: windows.map(window => window.text),
      credentials,
    });
    const results: any[] = Array.isArray(json.results) ? json.results : [];
    return windows.map((window, index) => {
      const categoryScores = results[index]?.category_scores || {};
      return {
        startTime: window.startTime,
        endTime: window.endTime,
        sexual: categoryScores.sexual || 0,
        violence: categoryScores.violence || 0,
        error: false,
      };
    });
  } catch (error) {
    const status =
      error instanceof OpenAIModerationRequestError ? error.status : undefined;
    // 400 typically means the batched input was too large: split and retry.
    if (status === 400 && windows.length > 1) {
      const mid = Math.ceil(windows.length / 2);
      const [left, right] = await Promise.all([
        moderateTranscriptBatchWithOpenAI({ windows: windows.slice(0, mid), model, credentials }),
        moderateTranscriptBatchWithOpenAI({ windows: windows.slice(mid), model, credentials }),
      ]);
      return [...left, ...right];
    }
    console.error("OpenAI transcript moderation failed:", error);
    return windows.map(window => transcriptErrorScore(window, error));
  }
}

async function requestOpenAITranscriptModeration(
  cues: VTTCue[],
  duration: number,
  model: string,
  maxConcurrent: number = 5,
  credentials?: WorkflowCredentialsInput,
  windowingParams: ResolvedTranscriptWindowingParams = DEFAULT_TRANSCRIPT_WINDOWING,
): Promise<TranscriptModerationScore[]> {
  "use step";
  // Build dynamic, overlapping time windows whose size scales with the asset's
  // duration, then moderate them as array-batched requests. Each window maps to
  // a score carrying its timecodes, mirroring the "max over segments" behavior
  // used for thumbnail moderation. Consecutive windows' [startTime, endTime]
  // ranges may overlap by design.
  const windows = buildTranscriptWindows(cues, duration, windowingParams);
  if (!windows.length) {
    return [];
  }
  const batches: TranscriptModerationBatch[] = packWindowsIntoBatches(windows).map(
    windowBatch => ({ windows: windowBatch, model, credentials }),
  );
  // Keep using the existing concurrency across BATCHES.
  const batchResults = await processConcurrently(
    batches,
    moderateTranscriptBatchWithOpenAI,
    maxConcurrent,
  );
  return batchResults.flat();
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
    includeTranscript = false,
    transcriptWindowing,
    credentials: providedCredentials,
  } = options;
  const credentials = providedCredentials;
  // Merge any caller overrides over the module-level defaults.
  const windowingParams: ResolvedTranscriptWindowingParams = {
    ...DEFAULT_TRANSCRIPT_WINDOWING,
    ...transcriptWindowing,
  };
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

  let thumbnailScores: ThumbnailModerationScore[] = [];
  let transcriptScores: TranscriptModerationScore[] = [];
  let mode: ModerationResult["mode"] = "thumbnails";
  let thumbnailCount: number | undefined;

  if (isAudioOnly) {
    mode = "transcript";
    // Fetch the raw VTT (cleanTranscript: false) so we can parse per-cue
    // timecodes and segment moderation by time window. `required: true` still
    // throws when no usable caption track / VTT exists for an audio-only asset.
    const transcriptResult = await fetchTranscriptForAsset(asset, playbackId, {
      languageCode,
      cleanTranscript: false,
      shouldSign: policy === "signed",
      credentials,
      required: true,
    });

    if (provider === "openai") {
      transcriptScores = await requestOpenAITranscriptModeration(
        parseVTTCues(transcriptResult.transcriptText),
        duration,
        model || "omni-moderation-latest",
        maxConcurrent,
        credentials,
        windowingParams,
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

    if (includeTranscript) {
      if (provider !== "openai") {
        throw new Error("includeTranscript is only supported with provider 'openai'.");
      }
      const transcriptResult = await fetchTranscriptForAsset(asset, playbackId, {
        languageCode,
        cleanTranscript: false,
        shouldSign: policy === "signed",
        credentials,
        required: false,
      });
      // Skip silently when there is no caption track / no parseable cues.
      const cues = parseVTTCues(transcriptResult.transcriptText);
      if (cues.length > 0) {
        transcriptScores = await requestOpenAITranscriptModeration(
          cues,
          duration,
          model || "omni-moderation-latest",
          maxConcurrent,
          credentials,
          windowingParams,
        );
      }
    }
  }

  // A video asset that ran `includeTranscript` and produced transcript scores
  // moderated both surfaces; reflect that in `mode`.
  if (mode === "thumbnails" && transcriptScores.length > 0) {
    mode = "combined";
  }

  // Aggregate across both surfaces (thumbnails + transcript) for the all-failed
  // guard and for the max-score / threshold computation.
  const allScores: Array<{ sexual: number; violence: number; error: boolean; errorMessage?: string; label: string }> = [
    ...thumbnailScores.map(s => ({ ...s, label: s.url })),
    ...transcriptScores.map(s => ({ ...s, error: s.error ?? false, label: `transcript window ${s.startTime}-${s.endTime}s` })),
  ];
  const failed = allScores.filter(s => s.error);
  const successful = allScores.filter(s => !s.error);
  if (successful.length === 0) {
    const details = failed.map(s => `${s.label}: ${s.errorMessage || "Unknown error"}`).join("; ");
    throw new Error(
      `Moderation failed for all ${allScores.length} sample(s): ${details}`,
    );
  }

  if (failed.length > 0) {
    console.warn(
      `Moderation had partial failures (${failed.length}/${allScores.length}); continuing with successful samples.`,
    );
  }

  // Find highest scores across both thumbnails and transcript time windows.
  const maxSexual = Math.max(...successful.map(s => s.sexual));
  const maxViolence = Math.max(...successful.map(s => s.violence));

  const finalThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  // Coverage describes how well the *thumbnails* were sampled; transcript scores
  // now live in their own array so they never enter this denominator.
  const coverageScores = thumbnailScores;
  const coverageFailed = coverageScores.filter(s => s.error);
  const coverageSuccessful = coverageScores.filter(s => !s.error);
  const requestedSampleCount = coverageScores.length;
  const successfulSampleCount = coverageSuccessful.length;
  const failedSampleCount = coverageFailed.length;
  const sampleCoverage = requestedSampleCount > 0 ? successfulSampleCount / requestedSampleCount : 0;
  // A transcript-only result (audio-only assets) has no thumbnails to sample, so
  // it must not be penalized for "too few thumbnails" / zero thumbnail coverage.
  // Treat it as confident as long as at least one transcript window succeeded.
  const hasThumbnails = requestedSampleCount > 0;
  const hasSuccessfulTranscript = transcriptScores.some(s => !s.error);
  let isLowConfidence: boolean;
  if (!hasThumbnails) {
    // Transcript-only (audio-only) path: confidence is driven by transcript success.
    isLowConfidence = !hasSuccessfulTranscript;
  } else {
    const hasEnoughSuccessfulSamples =
      successfulSampleCount >= MIN_SUCCESSFUL_THUMBNAILS_FOR_CONFIDENT_THRESHOLDING;
    isLowConfidence = sampleCoverage < MIN_SAMPLE_COVERAGE_FOR_CONFIDENT_THRESHOLDING ||
      !hasEnoughSuccessfulSamples;
  }

  return {
    assetId,
    mode,
    isAudioOnly,
    thumbnailScores,
    transcriptScores,
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
