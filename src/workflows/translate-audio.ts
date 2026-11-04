import { sleep } from "workflow";

import env from "../env.ts";
import { getApiKeyFromEnv } from "../lib/client-factory.ts";
import { elevenLabsResponseFailure, elevenLabsSdkFailure } from "../lib/elevenlabs-errors.ts";
import type { ElevenLabsFailure } from "../lib/elevenlabs-errors.ts";
import { getLanguageCodePair, getLanguageName, toISO639_1 } from "../lib/language-codes.ts";
import type { LanguageCodePair } from "../lib/language-codes.ts";
import { MUX_AI_ERROR_CODES, MUX_AI_ERROR_DEPENDENCY_VALUES, MUX_AI_ERROR_SOURCE_VALUES, MUX_AI_ERROR_TYPE_VALUES, MuxAiError, wrapError } from "../lib/mux-ai-error.ts";
import { getAssetDurationSecondsFromAsset, getPlaybackIdForAsset, isAudioOnlyAsset, isVideoOnlyAsset } from "../lib/mux-assets.ts";
import {
  getLegacyMp4SupportRenditionSizeError,
  resolveLegacyMp4SupportRendition,
  usesLegacyMp4Support,
} from "../lib/mux-static-renditions.ts";
import {
  buildMuxAiTrackPassthrough,
  planTextTrackReplacement,
  replaceAndCreateTrack,
  validateTrackPassthrough,
} from "../lib/mux-tracks.ts";
import type { ReplaceExistingTracksPolicy, TextTrackSummary, TextTrackTarget } from "../lib/mux-tracks.ts";
import { getMuxStreamOrigin } from "../lib/mux-url.ts";
import {
  createPresignedGetUrlWithStorageAdapter,
  putObjectWithStorageAdapter,
} from "../lib/storage-adapter.ts";
import { signUrl } from "../lib/url-signing.ts";
import { resolveMuxClient } from "../lib/workflow-credentials.ts";
import type {
  MuxAIOptions,
  MuxAsset,
  StorageAdapter,
  TokenUsage,
  WorkflowCredentialsInput,
} from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** What happened to the audio-only static rendition `translateAudio` created as dubbing input. */
export type StaticRenditionCleanupOutcome = "deleted" | "delete_failed" | "kept" | "not_created";

/** Output returned from `translateAudio`. */
export interface AudioTranslationResult {
  assetId: string;
  /** Normalized target language tag, including region or script subtags when supplied. */
  targetLanguageCode: string;
  /**
   * Legacy language-code pair. `iso639_1` retains the normalized requested tag,
   * including qualifiers or three-letter languages without an ISO 639-1 code.
   */
  targetLanguage: LanguageCodePair;
  /** ElevenLabs project ID; legacy callers retain the `dubbingId` field. */
  dubbingId: string;
  uploadedTrackId?: string;
  presignedUrl?: string;
  /**
   * Existing tracks deleted before the dubbed audio track and, when enabled, the
   * captions track were created. Each entry's `type` says which group it came from.
   */
  replacedTracks?: TextTrackSummary[];
  /** Mux text track ID for the dubbed captions, present when `uploadCaptionsToMux` is true and the upload succeeded. */
  captionsTrackId?: string;
  /** Presigned URL for the dub's translated transcript (WebVTT) staged to S3. */
  captionsPresignedUrl?: string;
  /** ID of the audio-only static rendition this run created, `undefined` when a usable rendition already existed. */
  createdStaticRenditionId?: string;
  /** Outcome of cleaning up the static rendition this run created (`not_created` when it reused an existing one). */
  staticRenditionCleanup: StaticRenditionCleanupOutcome;
  /** Workflow usage metadata (asset duration, thumbnails, etc.). */
  usage?: TokenUsage;
}

/** Configuration accepted by `translateAudio`. */
export interface AudioTranslationOptions extends MuxAIOptions {
  /** Audio dubbing provider (currently ElevenLabs only). */
  provider?: "elevenlabs";
  /**
   * Optional source language code for ElevenLabs `source_language`.
   * Accepts language tags (e.g. "en-US") or known ISO 639-3 aliases (e.g. "eng").
   * Region and script subtags are dropped for ElevenLabs.
   * Defaults to auto-detect when omitted.
   */
  fromLanguageCode?: string;
  /** Only 0 (auto-detect) is supported by the project API. Nonzero overrides are rejected before billing. */
  numSpeakers?: number;
  /** Optional override for the S3-compatible endpoint used for uploads. */
  s3Endpoint?: string;
  /** S3 region (defaults to env.S3_REGION or 'auto'). */
  s3Region?: string;
  /** Bucket that will store dubbed audio files. */
  s3Bucket?: string;
  /**
   * When `true` the dubbed audio is uploaded to the configured
   * S3-compatible bucket and a `presignedUrl` is returned.
   * Defaults to the value of `uploadToMux` when omitted.
   * Ignored (treated as `true`) when `uploadToMux` is `true`,
   * since Mux track creation requires a presigned URL.
   */
  uploadToS3?: boolean;
  /**
   * When true (default) the dubbed audio is attached as a track on the
   * Mux asset. Implies `uploadToS3: true` because a presigned URL is
   * required for track creation.
   */
  uploadToMux?: boolean;
  /**
   * When true the dub's translated transcript (the same translation that was
   * voiced) is attached as a subtitles text track on the Mux asset. Implies
   * `uploadToS3: true`. Defaults to false. Existing text tracks are handled
   * according to `replaceExistingTracks`, checked before dubbing starts.
   */
  uploadCaptionsToMux?: boolean;
  /**
   * What to do when the asset already has an audio track (or, with
   * `uploadCaptionsToMux`, a text track) in the target language or with the
   * target name. Defaults to `"fail"`, which rejects before dubbing starts.
   * The asset's primary audio track is never deleted under any policy.
   */
  replaceExistingTracks?: ReplaceExistingTracksPolicy;
  /**
   * Name for the created Mux tracks. Audio and text tracks are separate name
   * groups, so the same name is used for both. Defaults to
   * "<Language> (Auto-dubbed)", e.g. "Spanish (Auto-dubbed)".
   */
  trackName?: string;
  /**
   * `passthrough` written on the created Mux tracks. Defaults to a JSON audit
   * tag identifying this workflow. Max 255 characters.
   */
  trackPassthrough?: string;
  /**
   * Cleanup for the audio-only static rendition this run created as dubbing
   * input: `"delete"` (default) removes it when the workflow finishes, success
   * or failure; `"keep"` leaves it. A pre-existing rendition is never deleted.
   * Concurrent dubs of one asset share a rendition, so create it up front or
   * pass `"keep"` — one run's delete can race a peer's source fetch.
   */
  staticRenditionCleanup?: "delete" | "keep";
  /** Optional storage adapter override for upload + presign operations. */
  storageAdapter?: StorageAdapter;
  /** Expiry duration in seconds for S3 presigned GET URLs. Defaults to 86400 (24 hours). */
  s3SignedUrlExpirySeconds?: number;
  /** Maximum time in seconds to wait before timing out. Defaults to 7200 (2 hours). */
  dubbingPollTimeoutSeconds?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

const STATIC_RENDITION_POLL_INTERVAL_MS = 10_000;
const STATIC_RENDITION_MAX_ATTEMPTS = 180; // 30 minutes

// Conservative ElevenLabs dubbing source cap. Only checked for `mp4_support`
// assets, the one case where the dubbing source can be a video MP4.
const MAX_DUBBING_SOURCE_BYTES = 1_000_000_000;

const DUBBING_POLL_INTERVAL_MS = 10_000;
// A transient status check failure skips one poll; this many in a row fail the run.
const MAX_CONSECUTIVE_STATUS_CHECK_FAILURES = 6;
// Attempts at downloading the dubbed audio when a failure is transient.
const DUBBED_AUDIO_DOWNLOAD_ATTEMPTS = 3;
const DUBBED_AUDIO_DOWNLOAD_RETRY_DELAY_MS = 10_000;
const DEFAULT_DUBBING_POLL_TIMEOUT_SECONDS = 7200; // 2 hours; override via options.dubbingPollTimeoutSeconds

function getReadyAudioStaticRendition(asset: any) {
  const files = asset.static_renditions?.files as any[] | undefined;
  if (!files || files.length === 0) {
    return undefined;
  }

  return files.find(
    rendition => rendition.name === "audio.m4a" && rendition.status === "ready",
  );
}

const hasReadyAudioStaticRendition = (asset: any) => Boolean(getReadyAudioStaticRendition(asset));

function getAudioStaticRenditionStatus(asset: any): string {
  const files = asset.static_renditions?.files as any[] | undefined;
  const audioRendition = files?.find(rendition => rendition.name === "audio.m4a");

  if (typeof audioRendition?.status === "string" && audioRendition.status.length > 0) {
    return audioRendition.status;
  }

  const aggregateStatus = asset.static_renditions?.status;
  if (typeof aggregateStatus === "string" && aggregateStatus.length > 0) {
    return aggregateStatus;
  }

  return asset.static_renditions ? "requested" : "not_requested";
}

/**
 * Requests an audio-only static rendition and returns its ID when this call
 * created it. Returns `undefined` when the rendition was already defined on
 * the asset (409/"already defined"), so callers know not to clean it up.
 */
async function requestStaticRenditionCreation(
  assetId: string,
  credentials?: WorkflowCredentialsInput,
): Promise<string | undefined> {
  "use step";
  const muxClient = await resolveMuxClient(credentials);
  const mux = await muxClient.createClient();
  try {
    const rendition = await mux.video.assets.createStaticRendition(assetId, {
      resolution: "audio-only",
    });
    return rendition.id;
  } catch (error: any) {
    const statusCode = error?.status ?? error?.statusCode;
    const messages: string[] | undefined = error?.error?.messages;
    const alreadyDefined =
      messages?.some(message => message.toLowerCase().includes("already defined")) ??
      error?.message?.toLowerCase().includes("already defined");

    if (statusCode === 409 || alreadyDefined) {
      return undefined;
    }

    wrapError(error, "Failed to request static rendition from Mux");
  }
}

/**
 * Deletes the static rendition this run created. Never throws: a failed
 * cleanup must not mask the workflow's real outcome, and a throwing step
 * would trigger Workflow DevKit retries. Every outcome is logged.
 */
async function deleteCreatedStaticRendition(
  assetId: string,
  staticRenditionId: string,
  credentials?: WorkflowCredentialsInput,
): Promise<"deleted" | "delete_failed"> {
  "use step";
  try {
    const muxClient = await resolveMuxClient(credentials);
    const mux = await muxClient.createClient();
    await mux.video.assets.deleteStaticRendition(assetId, staticRenditionId);
    console.warn(`🧹 Deleted static rendition ${staticRenditionId} created on asset ${assetId}`);
    return "deleted";
  } catch (error: any) {
    const statusCode = error?.status ?? error?.statusCode;
    if (statusCode === 404) {
      console.warn(`🧹 Static rendition ${staticRenditionId} on asset ${assetId} was already deleted`);
      return "deleted";
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `⚠️ Failed to delete static rendition ${staticRenditionId} on asset ${assetId} (status: ${statusCode ?? "unknown"}): ${message}`,
    );
    return "delete_failed";
  }
}

async function retrieveAsset(
  assetId: string,
  credentials?: WorkflowCredentialsInput,
): Promise<any> {
  "use step";
  const muxClient = await resolveMuxClient(credentials);
  const mux = await muxClient.createClient();
  return mux.video.assets.retrieve(assetId);
}

// Orchestration-level (not a step): the poll loop must call the durable `sleep`,
// which suspends the workflow between retries without holding the function open.
// Requesting creation happens in the workflow body before this is called, so the
// created rendition's ID is known (and can be cleaned up) even if this times out.
async function waitForAudioStaticRendition({
  assetId,
  initialAsset,
  credentials,
}: {
  assetId: string;
  initialAsset: any;
  credentials?: WorkflowCredentialsInput;
}): Promise<any> {
  let currentAsset = initialAsset;

  if (hasReadyAudioStaticRendition(currentAsset)) {
    return currentAsset;
  }

  for (let attempt = 1; attempt <= STATIC_RENDITION_MAX_ATTEMPTS; attempt++) {
    await sleep(STATIC_RENDITION_POLL_INTERVAL_MS);
    currentAsset = await retrieveAsset(assetId, credentials);

    if (hasReadyAudioStaticRendition(currentAsset)) {
      return currentAsset;
    }

    const currentStatus = getAudioStaticRenditionStatus(currentAsset);
    console.warn(
      `⌛ Waiting for static rendition (attempt ${attempt}/${STATIC_RENDITION_MAX_ATTEMPTS}) → ${currentStatus}`,
    );

    if (currentStatus === "errored") {
      throw new MuxAiError(
        "Mux failed to create the static rendition for this asset. Please check the asset in the Mux dashboard.",
        {
          type: MUX_AI_ERROR_TYPE_VALUES.processing_error,
          source: MUX_AI_ERROR_SOURCE_VALUES.upstream,
          dependency: MUX_AI_ERROR_DEPENDENCY_VALUES.mux_video,
          // Mux answered (200) with the rendition errored.
          facts: { status: 200 },
          // As before (pre-classification).
          retryable: false,
        },
      );
    }
  }

  throw new MuxAiError(
    "Timed out waiting for the static rendition to become ready. Please try again in a moment.",
    {
      type: MUX_AI_ERROR_TYPE_VALUES.timeout_error,
      source: MUX_AI_ERROR_SOURCE_VALUES.upstream,
      dependency: MUX_AI_ERROR_DEPENDENCY_VALUES.mux_video,
      // As before (pre-classification): not transient, this already polled for the whole budget.
      transient: false,
    },
  );
}

// Assets on the deprecated `mp4_support` option reject the Static Renditions
// API, so this only waits for and reads their existing files, never modifying them.
async function waitForLegacyMp4SupportRendition({
  assetId,
  initialAsset,
  credentials,
}: {
  assetId: string;
  initialAsset: any;
  credentials?: WorkflowCredentialsInput;
}): Promise<string> {
  let rendition = resolveLegacyMp4SupportRendition(initialAsset);

  for (let attempt = 1; rendition?.kind === "preparing" && attempt <= STATIC_RENDITION_MAX_ATTEMPTS; attempt++) {
    console.warn(
      `⌛ Waiting for mp4_support static renditions (attempt ${attempt}/${STATIC_RENDITION_MAX_ATTEMPTS})`,
    );
    await sleep(STATIC_RENDITION_POLL_INTERVAL_MS);
    rendition = resolveLegacyMp4SupportRendition(await retrieveAsset(assetId, credentials));
  }

  if (!rendition) {
    throw new MuxAiError(
      "The asset's static rendition settings changed while waiting for them. Please try again.",
      {
        type: MUX_AI_ERROR_TYPE_VALUES.processing_error,
        source: MUX_AI_ERROR_SOURCE_VALUES.asset,
        // Retryable although asset-sourced: the asset changed mid-run, and a new job uses the new settings.
        retryable: true,
      },
    );
  }
  if (rendition.kind === "preparing") {
    throw new MuxAiError(
      "Timed out waiting for the static rendition to become ready. Please try again in a moment.",
      {
        type: MUX_AI_ERROR_TYPE_VALUES.timeout_error,
        source: MUX_AI_ERROR_SOURCE_VALUES.upstream,
        dependency: MUX_AI_ERROR_DEPENDENCY_VALUES.mux_video,
        // As before (pre-classification): not transient, this already polled for the whole budget.
        transient: false,
      },
    );
  }
  if (rendition.kind === "unusable") {
    throw new MuxAiError(rendition.reason, { type: MUX_AI_ERROR_TYPE_VALUES.validation_error, source: MUX_AI_ERROR_SOURCE_VALUES.asset });
  }

  const sizeError = getLegacyMp4SupportRenditionSizeError(rendition, MAX_DUBBING_SOURCE_BYTES);
  if (sizeError) {
    throw new MuxAiError(sizeError, { type: MUX_AI_ERROR_TYPE_VALUES.validation_error, source: MUX_AI_ERROR_SOURCE_VALUES.asset });
  }

  return rendition.name;
}

/** Drop region and script subtags for ElevenLabs Dubbing v1 while retaining them on Mux tracks. */
function toBaseLanguageCode(code: string): string {
  return code.trim().split(/[-_]/)[0];
}

/**
 * Why Mux would refuse to add an audio track to this asset, or `undefined`
 * when it would accept one. Mirrors Mux's own audio track validation.
 */
function audioTrackUnsupportedReason(asset: MuxAsset): string | undefined {
  const useDubbedFile = "skip uploading to Mux and use the dubbed audio file directly.";
  if (asset.ingest_type === "on_demand_clip" || asset.source_asset_id) {
    return `is a clip, and Mux does not support adding audio tracks to clipped assets. Dub the source asset instead, or ${useDubbedFile}`;
  }
  if (asset.is_live || asset.live_stream_id) {
    return `comes from a live stream, and Mux does not support adding audio tracks to live stream assets. Instead, ${useDubbedFile}`;
  }
  if (isAudioOnlyAsset(asset)) {
    return `is audio-only, and Mux does not support adding audio tracks to audio-only assets. Instead, ${useDubbedFile}`;
  }
  return undefined;
}

/**
 * The customer-facing error for a failed ElevenLabs call. Keeps the failure's
 * retryability but none of its provider detail, which callers log instead.
 */
function dubbingProviderError(message: string, failure: ElevenLabsFailure): MuxAiError {
  const classification = {
    source: MUX_AI_ERROR_SOURCE_VALUES.upstream,
    dependency: MUX_AI_ERROR_DEPENDENCY_VALUES.ai_provider,
    facts: { ...(failure.httpStatus === undefined ? {} : { status: failure.httpStatus }), ...(failure.reason ? { reason: failure.reason } : {}) },
    // As before (pre-classification): not transient, the caller already retried the call.
    transient: false,
    retryable: failure.retryable,
  };
  if (failure.reason === "timeout") {
    return new MuxAiError(`${message} The dubbing service timed out. Please try again.`, { ...classification, type: MUX_AI_ERROR_TYPE_VALUES.timeout_error });
  }
  if (failure.retryable) {
    return new MuxAiError(`${message} The dubbing service is temporarily unavailable. Please try again.`, { ...classification, type: MUX_AI_ERROR_TYPE_VALUES.processing_error });
  }
  return new MuxAiError(message, { ...classification, type: MUX_AI_ERROR_TYPE_VALUES.processing_error });
}

/** The customer-facing error for a dubbing project ElevenLabs would not create. */
function dubbingStartError(failure: ElevenLabsFailure, languages: { target: string; source?: string }): MuxAiError {
  if (failure.reason === "unsupported_target_language") {
    return new MuxAiError(`Audio dubbing does not support the target language "${languages.target}".`, { type: MUX_AI_ERROR_TYPE_VALUES.validation_error, source: MUX_AI_ERROR_SOURCE_VALUES.request });
  }
  if (failure.reason === "unsupported_source_language" && languages.source) {
    return new MuxAiError(`Audio dubbing does not support the source language "${languages.source}".`, { type: MUX_AI_ERROR_TYPE_VALUES.validation_error, source: MUX_AI_ERROR_SOURCE_VALUES.request });
  }
  return dubbingProviderError("Audio dubbing could not be started.", failure);
}

async function createElevenLabsDubbingJob({
  sourceUrl,
  assetId,
  elevenLabsLangCode,
  elevenLabsSourceLangCode,
  credentials,
}: {
  sourceUrl: string;
  assetId: string;
  elevenLabsLangCode: string;
  elevenLabsSourceLangCode?: string;
  credentials?: WorkflowCredentialsInput;
}): Promise<{ kind: "created"; projectId: string; languageId: string } | { kind: "failed"; failure: ElevenLabsFailure }> {
  "use step";
  const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js");
  const client = new ElevenLabsClient({ apiKey: await getApiKeyFromEnv("elevenlabs", credentials), maxRetries: 0 });
  try {
    const project = await client.dubbing.project.create({
      sourceUrl,
      sourceLanguage: elevenLabsSourceLangCode,
      targetLanguage: elevenLabsLangCode,
      modelId: "dubbing_v1",
      reference: `Mux Asset ${assetId} - ${elevenLabsSourceLangCode ?? "auto"} to ${elevenLabsLangCode}`,
    });
    const languageId = project.languageIds?.[0];
    if (!languageId) {
      return {
        kind: "failed",
        failure: { retryable: false, detail: `ElevenLabs project ${project.projectId} returned no language target. Check the project before retrying.` },
      };
    }
    return { kind: "created", projectId: project.projectId, languageId };
  } catch (error) {
    // A create may already have been billed even when its response is lost. Return
    // the failure so neither SDK nor WDK retries this paid mutation automatically.
    return { kind: "failed", failure: elevenLabsSdkFailure(error) };
  }
}

/** Why ElevenLabs failed a dubbing project or language target. */
interface ElevenLabsDubbingError {
  code: string;
  message: string;
  retryable: boolean;
}

async function checkElevenLabsDubbingStatus({
  dubbingId,
  languageId,
  credentials,
}: {
  dubbingId: string;
  languageId: string;
  credentials?: WorkflowCredentialsInput;
}): Promise<{ kind: "status"; status: string; error?: ElevenLabsDubbingError } | { kind: "failed"; failure: ElevenLabsFailure }> {
  "use step";
  const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js");
  const client = new ElevenLabsClient({ apiKey: await getApiKeyFromEnv("elevenlabs", credentials), maxRetries: 0 });
  try {
    const [project, language] = await Promise.all([
      client.dubbing.project.get(dubbingId),
      client.dubbing.project.language.get(dubbingId, languageId),
    ]);
    return {
      kind: "status",
      status: project.status === "failed" ? "failed" : language.status,
      // A language error of `project_failed` only points at the project, so prefer the project's.
      error: project.error ?? language.error,
    };
  } catch (error) {
    // Returned, not thrown: a thrown error loses its status at the step boundary,
    // and the poll loop decides whether to keep polling.
    return { kind: "failed", failure: elevenLabsSdkFailure(error) };
  }
}

async function fetchDubbingOutput(
  dubbingId: string,
  languageId: string,
  output: "losslessAudio" | "subtitles",
  credentials?: WorkflowCredentialsInput,
): Promise<{ kind: "fetched"; response: Response; url: string } | { kind: "failed"; failure: ElevenLabsFailure }> {
  const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js");
  const client = new ElevenLabsClient({ apiKey: await getApiKeyFromEnv("elevenlabs", credentials), maxRetries: 0 });
  // Re-read inside the download step so a retry gets a fresh signed URL.
  for (let attempt = 0; attempt < 2; attempt++) {
    let url: string | undefined;
    try {
      const target = await client.dubbing.project.language.get(dubbingId, languageId);
      url = target.outputs?.[output];
    } catch (error) {
      return { kind: "failed", failure: elevenLabsSdkFailure(error) };
    }
    if (!url) {
      // A completed target should list every output, so treat a missing one as not ready yet.
      return {
        kind: "failed",
        failure: { reason: "output_missing", retryable: true, detail: `ElevenLabs language ${languageId} of project ${dubbingId} has no ${output} output` },
      };
    }
    // Signed storage URLs do not receive the ElevenLabs API key.
    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      return { kind: "failed", failure: { reason: "network_error", retryable: true, detail: `Failed to fetch dubbed ${output}: ${error instanceof Error ? error.message : String(error)}` } };
    }
    if (response.ok) {
      return { kind: "fetched", response, url };
    }
    // An expired signed URL returns 403; re-read the target once for a fresh one.
    if (response.status !== 403 || attempt === 1) {
      return { kind: "failed", failure: await elevenLabsResponseFailure(response) };
    }
  }
  return { kind: "failed", failure: { retryable: false, detail: `Failed to fetch dubbed ${output}` } };
}

/**
 * Download dubbed audio from ElevenLabs and upload to S3 in a single step so the audio
 * bytes never cross a workflow step boundary. Step inputs/outputs are persisted
 * to the durable event log, which has a payload size cap, so the single step prevents errors.
 */
async function downloadAndUploadDubbedAudio({
  dubbingId,
  languageId,
  assetId,
  toLanguageCode,
  s3Endpoint,
  s3Region,
  s3Bucket,
  storageAdapter,
  s3SignedUrlExpirySeconds,
  credentials,
}: {
  dubbingId: string;
  languageId: string;
  assetId: string;
  toLanguageCode: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  storageAdapter?: StorageAdapter;
  s3SignedUrlExpirySeconds?: number;
  credentials?: WorkflowCredentialsInput;
}): Promise<{ kind: "staged"; presignedUrl: string } | { kind: "failed"; failure: ElevenLabsFailure }> {
  "use step";
  const fetched = await fetchDubbingOutput(dubbingId, languageId, "losslessAudio", credentials);
  if (fetched.kind === "failed") {
    return fetched;
  }
  const { response: audioResponse, url } = fetched;
  const mime = audioResponse.headers.get("content-type")?.split(";")[0].trim();
  const formats: Record<string, string> = {
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
  };
  const pathExtension = new URL(url).pathname.split(".").pop()?.toLowerCase();
  const extension = (mime ? formats[mime] : undefined) ??
    Object.values(formats).find(format => format === pathExtension);
  if (!extension) {
    return {
      kind: "failed",
      failure: { reason: "unsupported_output_format", retryable: false, detail: `Unsupported dubbed audio content type: ${mime ?? "missing"}` },
    };
  }

  const dubbedAudio = new Uint8Array(await audioResponse.arrayBuffer());

  const s3AccessKeyId = env.S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = env.S3_SECRET_ACCESS_KEY;

  // Create unique key for the audio file
  const audioKey = `audio-translations/${assetId}/auto-to-${toLanguageCode}-${Date.now()}.${extension}`;

  await putObjectWithStorageAdapter({
    accessKeyId: s3AccessKeyId,
    secretAccessKey: s3SecretAccessKey,
    endpoint: s3Endpoint,
    region: s3Region,
    bucket: s3Bucket,
    key: audioKey,
    body: dubbedAudio,
    contentType: Object.keys(formats).find(type => formats[type] === extension)!,
  }, storageAdapter);

  const presignedUrl = await createPresignedGetUrlWithStorageAdapter({
    accessKeyId: s3AccessKeyId,
    secretAccessKey: s3SecretAccessKey,
    endpoint: s3Endpoint,
    region: s3Region,
    bucket: s3Bucket,
    key: audioKey,
    expiresInSeconds: s3SignedUrlExpirySeconds ?? 86400,
  }, storageAdapter);

  const expiryHours = Math.round((s3SignedUrlExpirySeconds ?? 86400) / 3600);
  console.warn(`✅ Audio uploaded successfully to: ${audioKey}`);
  console.warn(`🔗 Generated presigned URL (expires in ${expiryHours} hour${expiryHours === 1 ? "" : "s"})`);

  return { kind: "staged", presignedUrl };
}

/**
 * Download the dub's translated transcript (WebVTT) from ElevenLabs and stage it to S3,
 * returning a presigned URL. Single step for the same event-log payload reason as
 * `downloadAndUploadDubbedAudio`.
 */
async function downloadAndUploadDubTranscript({
  dubbingId,
  languageId,
  assetId,
  toLanguageCode,
  s3Endpoint,
  s3Region,
  s3Bucket,
  storageAdapter,
  s3SignedUrlExpirySeconds,
  credentials,
}: {
  dubbingId: string;
  languageId: string;
  assetId: string;
  toLanguageCode: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  storageAdapter?: StorageAdapter;
  s3SignedUrlExpirySeconds?: number;
  credentials?: WorkflowCredentialsInput;
}): Promise<{ kind: "staged"; presignedUrl: string } | { kind: "failed"; failure: ElevenLabsFailure }> {
  "use step";
  const fetched = await fetchDubbingOutput(dubbingId, languageId, "subtitles", credentials);
  if (fetched.kind === "failed") {
    return fetched;
  }
  const transcriptVtt = await fetched.response.text();
  if (!transcriptVtt.trim()) {
    return { kind: "failed", failure: { retryable: false, detail: "Dub transcript response did not include webvtt content" } };
  }

  const s3AccessKeyId = env.S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = env.S3_SECRET_ACCESS_KEY;

  const vttKey = `audio-translations/${assetId}/auto-to-${toLanguageCode}-${Date.now()}.vtt`;

  await putObjectWithStorageAdapter({
    accessKeyId: s3AccessKeyId,
    secretAccessKey: s3SecretAccessKey,
    endpoint: s3Endpoint,
    region: s3Region,
    bucket: s3Bucket,
    key: vttKey,
    body: transcriptVtt,
    contentType: "text/vtt",
  }, storageAdapter);

  const presignedUrl = await createPresignedGetUrlWithStorageAdapter({
    accessKeyId: s3AccessKeyId,
    secretAccessKey: s3SecretAccessKey,
    endpoint: s3Endpoint,
    region: s3Region,
    bucket: s3Bucket,
    key: vttKey,
    expiresInSeconds: s3SignedUrlExpirySeconds ?? 86400,
  }, storageAdapter);

  console.warn(`✅ Dub transcript uploaded successfully to: ${vttKey}`);

  return { kind: "staged", presignedUrl };
}

export async function translateAudio(
  assetId: string,
  toLanguageCode: string,
  options: AudioTranslationOptions = {},
): Promise<AudioTranslationResult> {
  "use workflow";
  // Uses the default audio track on your asset (source language auto-detected unless provided)
  const {
    provider = "elevenlabs",
    fromLanguageCode,
    numSpeakers = 0, // 0 = auto-detect
    uploadToS3: uploadToS3Option,
    uploadToMux: uploadToMuxOption,
    uploadCaptionsToMux = false,
    staticRenditionCleanup: staticRenditionCleanupOption = "delete",
    storageAdapter,
    credentials: providedCredentials,
    replaceExistingTracks = "fail",
    trackName: providedTrackName,
    trackPassthrough: providedTrackPassthrough,
  } = options;

  if (provider !== "elevenlabs") {
    throw new MuxAiError("Only ElevenLabs provider is currently supported for audio translation.", { type: MUX_AI_ERROR_TYPE_VALUES.validation_error, source: MUX_AI_ERROR_SOURCE_VALUES.request });
  }

  const targetLanguageCode = toISO639_1(toLanguageCode);
  if (numSpeakers !== 0) {
    throw new MuxAiError("The ElevenLabs project API does not support numSpeakers overrides. Omit it or use 0 for auto-detection.", { type: MUX_AI_ERROR_TYPE_VALUES.validation_error, source: MUX_AI_ERROR_SOURCE_VALUES.request });
  }

  const credentials = providedCredentials;
  const effectiveStorageAdapter = storageAdapter;
  const trackPassthrough = validateTrackPassthrough(providedTrackPassthrough) ?? buildMuxAiTrackPassthrough("translate-audio");

  const uploadToMux = uploadToMuxOption !== false; // Default to true
  const uploadToS3 = uploadToS3Option || uploadToMux || uploadCaptionsToMux; // Defaults to uploadToMux; Mux uploads force S3 staging

  // Mux tracks retain the requested tag; ElevenLabs receives only the primary language subtag.
  const muxLangCode = targetLanguageCode;
  const trackName = providedTrackName ?? `${getLanguageName(muxLangCode) ?? muxLangCode.toUpperCase()} (Auto-dubbed)`;
  const audioTrackTarget: TextTrackTarget = { type: "audio", languageCode: muxLangCode, name: trackName };
  const captionsTrackTarget: TextTrackTarget = { type: "text", languageCode: muxLangCode, name: trackName };

  // S3 configuration
  const s3Endpoint = options.s3Endpoint ?? env.S3_ENDPOINT;
  const s3Region = options.s3Region ?? env.S3_REGION ?? "auto";
  const s3Bucket = options.s3Bucket ?? env.S3_BUCKET;
  const s3AccessKeyId = env.S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = env.S3_SECRET_ACCESS_KEY;

  if (uploadToS3 && (!s3Endpoint || !s3Bucket || (!effectiveStorageAdapter && (!s3AccessKeyId || !s3SecretAccessKey)))) {
    throw new MuxAiError("Storage configuration is required for uploading. Provide s3Endpoint and s3Bucket. If no storageAdapter is supplied, also provide s3AccessKeyId and s3SecretAccessKey in options or set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY environment variables.", { code: MUX_AI_ERROR_CODES.storage_not_configured });
  }

  // Fetch asset data and playback ID from Mux
  const { asset: initialAsset, playbackId, policy } = await getPlaybackIdForAsset(assetId, credentials, options.assetSnapshot);
  const assetDurationSeconds = getAssetDurationSecondsFromAsset(initialAsset);

  // With no audio there is nothing to dub. Mux marks the audio static
  // rendition "skipped" for these, so without this check the run would wait
  // out the full rendition timeout instead of failing.
  if (isVideoOnlyAsset(initialAsset)) {
    throw new MuxAiError(`Asset ${assetId} has no audio track, so there is no audio to dub.`, { type: MUX_AI_ERROR_TYPE_VALUES.validation_error, source: MUX_AI_ERROR_SOURCE_VALUES.asset });
  }

  // Mux refuses audio tracks on clips, live stream assets and audio-only
  // assets. Reject those now, before ElevenLabs bills for a dub that could
  // never be attached. Without uploadToMux they still dub: the caller gets
  // the staged audio file instead of a new track.
  const audioTrackUnsupported = uploadToMux ? audioTrackUnsupportedReason(initialAsset) : undefined;
  if (audioTrackUnsupported) {
    throw new MuxAiError(`Asset ${assetId} ${audioTrackUnsupported}`, { type: MUX_AI_ERROR_TYPE_VALUES.validation_error, source: MUX_AI_ERROR_SOURCE_VALUES.asset });
  }

  // Check both target tracks against the asset we already have so a blocked
  // policy rejects before ElevenLabs is asked to do anything. The create step
  // re-plans against a fresh asset.
  for (const target of [
    ...(uploadToMux ? [audioTrackTarget] : []),
    ...(uploadCaptionsToMux ? [captionsTrackTarget] : []),
  ]) {
    const plan = planTextTrackReplacement(initialAsset, target, replaceExistingTracks);
    if (plan.kind === "blocked") {
      throw new MuxAiError(plan.reason, { code: MUX_AI_ERROR_CODES.track_replacement_blocked });
    }
  }

  // Check for audio-only static rendition. Requesting creation happens here
  // (not inside the poll helper) so the created rendition's ID is captured
  // before any waiting begins and cleanup covers every exit path after this,
  // including poll timeouts.
  let currentAsset = initialAsset;
  let createdStaticRenditionId: string | undefined;
  const isLegacyMp4SupportAsset = usesLegacyMp4Support(initialAsset);
  if (!isLegacyMp4SupportAsset && !hasReadyAudioStaticRendition(currentAsset)) {
    console.warn("❌ No ready audio static rendition found. Requesting one now...");
    const renditionStatus = currentAsset.static_renditions?.status ?? "not_requested";
    if (renditionStatus === "not_requested" || renditionStatus === "errored") {
      // Re-requesting over an errored rendition counts as created by this run:
      // the resulting rendition only exists because we asked for it.
      createdStaticRenditionId = await requestStaticRenditionCreation(assetId, credentials);
    } else {
      console.warn(`ℹ️ Static rendition already ${renditionStatus}. Waiting for it to finish...`);
    }
  }

  let staticRenditionCleanup: StaticRenditionCleanupOutcome = "not_created";
  let dubbingId!: string;
  let languageId!: string;
  let presignedUrl: string | undefined;
  let uploadedTrackId: string | undefined;
  let replacedTracks: TextTrackSummary[] | undefined;
  let captionsPresignedUrl: string | undefined;
  let captionsTrackId: string | undefined;

  try {
    let sourceRenditionName = "audio.m4a";
    if (isLegacyMp4SupportAsset) {
      sourceRenditionName = await waitForLegacyMp4SupportRendition({
        assetId,
        initialAsset: currentAsset,
        credentials,
      });
    } else {
      if (!hasReadyAudioStaticRendition(currentAsset)) {
        currentAsset = await waitForAudioStaticRendition({
          assetId,
          initialAsset: currentAsset,
          credentials,
        });
      }

      const audioRendition = getReadyAudioStaticRendition(currentAsset);

      if (!audioRendition) {
        throw new MuxAiError(
          "Unable to obtain an audio-only static rendition for this asset. Please verify static renditions are enabled in Mux.",
          { type: MUX_AI_ERROR_TYPE_VALUES.validation_error, source: MUX_AI_ERROR_SOURCE_VALUES.asset },
        );
      }
    }

    // Build audio URL (signed if needed)
    let audioUrl = `${await getMuxStreamOrigin(credentials)}/${playbackId}/${sourceRenditionName}`;
    if (policy === "signed") {
      audioUrl = await signUrl(audioUrl, playbackId, "video", undefined, credentials);
    }

    // Create dubbing job in ElevenLabs
    console.warn("🎙️ Creating dubbing job in ElevenLabs...");

    const elevenLabsLangCode = toISO639_1(toBaseLanguageCode(toLanguageCode));
    const sourceLanguageCode = toISO639_1(toBaseLanguageCode(fromLanguageCode ?? "auto"));
    const elevenLabsSourceLangCode = sourceLanguageCode && sourceLanguageCode !== "auto" ? sourceLanguageCode : undefined;
    console.warn(
      `🔍 Creating dubbing job for asset ${assetId}: ${elevenLabsSourceLangCode ?? "auto"} -> ${elevenLabsLangCode}`,
    );

    let created!: Awaited<ReturnType<typeof createElevenLabsDubbingJob>>;
    try {
      created = await createElevenLabsDubbingJob({
        sourceUrl: audioUrl,
        assetId,
        elevenLabsLangCode,
        elevenLabsSourceLangCode,
        credentials,
      });
    } catch (error) {
      wrapError(error, "Failed to create ElevenLabs dubbing job");
    }
    if (created.kind === "failed") {
      const { failure } = created;
      // Without a readable response ElevenLabs may still have created, and billed, the project.
      const mayHaveCreated = failure.reason === "timeout" || failure.reason === "network_error" || failure.reason === "unexpected_response";
      console.warn(
        `Failed to create ElevenLabs dubbing project for asset ${assetId}: ${failure.detail}${mayHaveCreated ? " The project may have been created; check ElevenLabs before retrying." : ""}`,
      );
      throw dubbingStartError(failure, { target: elevenLabsLangCode, source: elevenLabsSourceLangCode });
    }
    dubbingId = created.projectId;
    languageId = created.languageId;
    console.warn(`✅ Dubbing job created with ID: ${dubbingId}`);

    // Poll for completion. ElevenLabs added intermediate dubbing states
    console.warn("⏳ Waiting for dubbing to complete...");

    const dubbingPollTimeoutSeconds = options.dubbingPollTimeoutSeconds ?? DEFAULT_DUBBING_POLL_TIMEOUT_SECONDS;
    const maxPollAttempts = Math.max(1, Math.ceil((dubbingPollTimeoutSeconds * 1000) / DUBBING_POLL_INTERVAL_MS));

    let dubbingStatus = "dubbing";
    let pollAttempts = 0;
    let dubbingError: ElevenLabsDubbingError | undefined;
    let consecutiveStatusCheckFailures = 0;

    while (dubbingStatus !== "completed" && pollAttempts < maxPollAttempts) {
      await sleep(DUBBING_POLL_INTERVAL_MS);
      pollAttempts++;

      let statusResult!: Awaited<ReturnType<typeof checkElevenLabsDubbingStatus>>;
      try {
        statusResult = await checkElevenLabsDubbingStatus({
          dubbingId,
          languageId,
          credentials,
        });
      } catch (error) {
        wrapError(error, "Failed to check dubbing status");
      }

      if (statusResult.kind === "failed") {
        const { failure } = statusResult;
        consecutiveStatusCheckFailures++;
        console.warn(`Status check for ElevenLabs dubbing project ${dubbingId} failed: ${failure.detail}`);
        // A transient failure only skips this poll; the next poll retries it.
        if (!failure.retryable || consecutiveStatusCheckFailures >= MAX_CONSECUTIVE_STATUS_CHECK_FAILURES) {
          throw dubbingProviderError("Could not check audio dubbing progress.", failure);
        }
        continue;
      }
      consecutiveStatusCheckFailures = 0;
      dubbingStatus = statusResult.status;
      dubbingError = statusResult.error;

      if (dubbingStatus === "failed") {
        console.warn(`❌ ElevenLabs dubbing project ${dubbingId} (language ${languageId}) failed: ${dubbingError ? `${dubbingError.code}: ${dubbingError.message}` : "no error reported"}`);
        // ElevenLabs documents `message` as display text and `retryable` as whether
        // resubmitting the same input could succeed.
        if (!dubbingError) {
          throw new MuxAiError("Audio dubbing failed.", {
            type: MUX_AI_ERROR_TYPE_VALUES.processing_error,
            source: MUX_AI_ERROR_SOURCE_VALUES.upstream,
            dependency: MUX_AI_ERROR_DEPENDENCY_VALUES.ai_provider,
            // ElevenLabs answered (200) with the dub failed.
            facts: { status: 200 },
            // As before (pre-classification).
            retryable: false,
          });
        }
        throw new MuxAiError(
          `Audio dubbing failed: ${dubbingError.message}${dubbingError.retryable ? " Please try again." : ""}`,
          {
            type: MUX_AI_ERROR_TYPE_VALUES.processing_error,
            source: MUX_AI_ERROR_SOURCE_VALUES.upstream,
            dependency: MUX_AI_ERROR_DEPENDENCY_VALUES.ai_provider,
            // ElevenLabs answered (200) with the dub failed, and says whether a new attempt may succeed.
            facts: { status: 200, reason: dubbingError.code },
            retryable: dubbingError.retryable,
          },
        );
      }
    }

    if (dubbingStatus !== "completed") {
      throw new MuxAiError("Audio translation timed out or failed. Please try again.", {
        type: MUX_AI_ERROR_TYPE_VALUES.timeout_error,
        source: MUX_AI_ERROR_SOURCE_VALUES.upstream,
        dependency: MUX_AI_ERROR_DEPENDENCY_VALUES.ai_provider,
        // As before (pre-classification): not transient, this already polled for the whole budget.
        transient: false,
      });
    }

    console.warn("✅ Dubbing completed successfully!");

    if (uploadToS3) {
      console.warn("📥 Downloading dubbed audio from ElevenLabs and staging to S3...");

      for (let attempt = 1; !presignedUrl; attempt++) {
        let staged!: Awaited<ReturnType<typeof downloadAndUploadDubbedAudio>>;
        try {
          staged = await downloadAndUploadDubbedAudio({
            dubbingId,
            languageId,
            assetId,
            toLanguageCode,
            s3Endpoint: s3Endpoint!,
            s3Region,
            s3Bucket: s3Bucket!,
            storageAdapter: effectiveStorageAdapter,
            s3SignedUrlExpirySeconds: options.s3SignedUrlExpirySeconds,
            credentials,
          });
        } catch (error) {
          wrapError(error, "Failed to download and upload dubbed audio");
        }
        if (staged.kind === "staged") {
          presignedUrl = staged.presignedUrl;
          break;
        }
        const { failure } = staged;
        console.warn(`Downloading dubbed audio for ElevenLabs dubbing project ${dubbingId} failed (attempt ${attempt}): ${failure.detail}`);
        if (!failure.retryable || attempt >= DUBBED_AUDIO_DOWNLOAD_ATTEMPTS) {
          throw dubbingProviderError("Could not download the dubbed audio.", failure);
        }
        await sleep(DUBBED_AUDIO_DOWNLOAD_RETRY_DELAY_MS);
      }
      console.warn("✅ Dubbed audio staged to S3 successfully!");

      // Add translated audio track to Mux asset (only when uploadToMux is true).
      // The audio track is the product, so a failure here fails the workflow; the
      // presigned URL is in the error so the caller can still attach it manually.
      if (uploadToMux) {
        console.warn("📹 Adding dubbed audio track to Mux asset...");
        let outcome: Awaited<ReturnType<typeof replaceAndCreateTrack>>;
        try {
          outcome = await replaceAndCreateTrack({
            assetId,
            target: audioTrackTarget,
            policy: replaceExistingTracks,
            presignedUrl: presignedUrl!,
            passthrough: trackPassthrough,
            credentials,
          });
        } catch (error) {
          wrapError(error, `Failed to add dubbed audio track to Mux asset (dubbed audio is staged at: ${presignedUrl})`);
        }
        if (outcome.kind === "blocked") {
          throw new MuxAiError(`${outcome.reason} Dubbed audio is staged at: ${presignedUrl}`, { code: MUX_AI_ERROR_CODES.track_replacement_blocked });
        }
        if (outcome.kind === "create_failed") {
          throw new Error(`Failed to add dubbed audio track to Mux asset: ${outcome.reason}. Dubbed audio is staged at: ${presignedUrl}`);
        }
        uploadedTrackId = outcome.trackId;
        replacedTracks = outcome.deleted;
        console.warn(`✅ Track added to Mux asset with ID: ${uploadedTrackId}`);
        console.warn(`📋 Track name: "${trackName}"`);
      }

      // The dub's translated transcript is the same translation that was voiced, and
      // fetching it costs nothing extra. Soft-fail everything here: a transcript problem
      // must never fail a completed, paid-for dub. Conflicts were checked before dubbing,
      // so a blocked result here is a race with another writer and is logged, not thrown.
      try {
        console.warn("📥 Downloading dub transcript from ElevenLabs and staging to S3...");
        const transcript = await downloadAndUploadDubTranscript({
          dubbingId,
          languageId,
          assetId,
          toLanguageCode,
          s3Endpoint: s3Endpoint!,
          s3Region,
          s3Bucket: s3Bucket!,
          storageAdapter: effectiveStorageAdapter,
          s3SignedUrlExpirySeconds: options.s3SignedUrlExpirySeconds,
          credentials,
        });
        if (transcript.kind === "failed") {
          throw new Error(transcript.failure.detail);
        }
        captionsPresignedUrl = transcript.presignedUrl;

        if (uploadCaptionsToMux) {
          console.warn("📹 Adding dubbed captions track to Mux asset...");
          const captionsOutcome = await replaceAndCreateTrack({
            assetId,
            target: captionsTrackTarget,
            policy: replaceExistingTracks,
            presignedUrl: captionsPresignedUrl,
            passthrough: trackPassthrough,
            credentials,
          });
          if (captionsOutcome.deleted.length > 0) {
            replacedTracks = [...(replacedTracks ?? []), ...captionsOutcome.deleted];
          }
          if (captionsOutcome.kind !== "created") {
            throw new Error(captionsOutcome.reason);
          }
          captionsTrackId = captionsOutcome.trackId;
          console.warn(`✅ Captions track added to Mux asset with ID: ${captionsTrackId}`);
        }
      } catch (error) {
        console.warn(`⚠️ Failed to attach dubbed captions: ${error instanceof Error ? error.message : "Unknown error"}`);
        if (captionsPresignedUrl) {
          console.warn("🔗 You can manually add the captions track using this presigned URL:");
          console.warn(captionsPresignedUrl);
        }
      }
    }
  } finally {
    // Reap the rendition this run created on both success and failure paths.
    // A pre-existing rendition (createdStaticRenditionId undefined) is never touched.
    if (createdStaticRenditionId) {
      if (staticRenditionCleanupOption === "keep") {
        console.warn(
          `ℹ️ Keeping static rendition ${createdStaticRenditionId} on asset ${assetId} (staticRenditionCleanup: "keep")`,
        );
        staticRenditionCleanup = "kept";
      } else {
        staticRenditionCleanup = await deleteCreatedStaticRendition(assetId, createdStaticRenditionId, credentials);
      }
    }
  }

  const targetLanguage = getLanguageCodePair(targetLanguageCode);
  return {
    assetId,
    targetLanguageCode,
    targetLanguage,
    dubbingId,
    uploadedTrackId,
    presignedUrl,
    replacedTracks,
    captionsTrackId,
    captionsPresignedUrl,
    createdStaticRenditionId,
    staticRenditionCleanup,
    usage: {
      metadata: {
        assetDurationSeconds,
      },
    },
  };
}
