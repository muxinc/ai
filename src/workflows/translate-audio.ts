import { sleep } from "workflow";

import env from "../env.ts";
import { getApiKeyFromEnv } from "../lib/client-factory.ts";
import { getLanguageCodePair, toISO639_1, toISO639_3 } from "../lib/language-codes.ts";
import type { LanguageCodePair, SupportedISO639_1 } from "../lib/language-codes.ts";
import { MuxAiError, wrapError } from "../lib/mux-ai-error.ts";
import { getAssetDurationSecondsFromAsset, getPlaybackIdForAsset } from "../lib/mux-assets.ts";
import { createTextTrackOnMux } from "../lib/mux-tracks.ts";
import { getMuxStreamOrigin } from "../lib/mux-url.ts";
import {
  createPresignedGetUrlWithStorageAdapter,
  putObjectWithStorageAdapter,
} from "../lib/storage-adapter.ts";
import { signUrl } from "../lib/url-signing.ts";
import { resolveMuxClient } from "../lib/workflow-credentials.ts";
import type {
  MuxAIOptions,
  StorageAdapter,
  TokenUsage,
  WorkflowCredentialsInput,
} from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Output returned from `translateAudio`. */
export interface AudioTranslationResult {
  assetId: string;
  /** Target language code (ISO 639-1 two-letter format). */
  targetLanguageCode: SupportedISO639_1;
  /**
   * Target language codes in both ISO 639-1 (2-letter) and ISO 639-3 (3-letter) formats.
   * Use `iso639_1` for browser players (BCP-47 compliant) and `iso639_3` for ElevenLabs API.
   */
  targetLanguage: LanguageCodePair;
  dubbingId: string;
  uploadedTrackId?: string;
  presignedUrl?: string;
  /** Mux text track ID for the dubbed captions, present when `uploadCaptionsToMux` is true and the upload succeeded. */
  captionsTrackId?: string;
  /** Presigned URL for the dub's translated transcript (WebVTT) staged to S3. */
  captionsPresignedUrl?: string;
  /** Workflow usage metadata (asset duration, thumbnails, etc.). */
  usage?: TokenUsage;
}

/** Configuration accepted by `translateAudio`. */
export interface AudioTranslationOptions extends MuxAIOptions {
  /** Audio dubbing provider (currently ElevenLabs only). */
  provider?: "elevenlabs";
  /**
   * Optional source language code for ElevenLabs `source_lang`.
   * Accepts ISO 639-1 (e.g. "en") or ISO 639-3 (e.g. "eng").
   * Defaults to auto-detect when omitted.
   */
  fromLanguageCode?: string;
  /** Number of speakers supplied to ElevenLabs (0 = auto-detect, default). */
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
   * `uploadToS3: true`. Defaults to false. The SDK does not check for existing
   * text tracks — callers decide conflict semantics before enabling this.
   */
  uploadCaptionsToMux?: boolean;
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

const STATIC_RENDITION_POLL_INTERVAL_MS = 5000;
const STATIC_RENDITION_MAX_ATTEMPTS = 36; // ~3 minutes

const DUBBING_POLL_INTERVAL_MS = 10_000;
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

async function requestStaticRenditionCreation(
  assetId: string,
  credentials?: WorkflowCredentialsInput,
) {
  "use step";
  const muxClient = await resolveMuxClient(credentials);
  const mux = await muxClient.createClient();
  try {
    await mux.video.assets.createStaticRendition(assetId, {
      resolution: "audio-only",
    });
  } catch (error: any) {
    const statusCode = error?.status ?? error?.statusCode;
    const messages: string[] | undefined = error?.error?.messages;
    const alreadyDefined =
      messages?.some(message => message.toLowerCase().includes("already defined")) ??
      error?.message?.toLowerCase().includes("already defined");

    if (statusCode === 409 || alreadyDefined) {
      return;
    }

    wrapError(error, "Failed to request static rendition from Mux");
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

  const status = currentAsset.static_renditions?.status ?? "not_requested";

  if (status === "not_requested" || status === undefined) {
    await requestStaticRenditionCreation(assetId, credentials);
  } else if (status === "errored") {
    await requestStaticRenditionCreation(assetId, credentials);
  } else {
    console.warn(`ℹ️ Static rendition already ${status}. Waiting for it to finish...`);
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
      );
    }
  }

  throw new MuxAiError(
    "Timed out waiting for the static rendition to become ready. Please try again in a moment.",
    { type: "timeout_error", retryable: true },
  );
}

async function createElevenLabsDubbingJob({
  sourceUrl,
  assetId,
  elevenLabsLangCode,
  elevenLabsSourceLangCode,
  numSpeakers,
  credentials,
}: {
  sourceUrl: string;
  assetId: string;
  elevenLabsLangCode: string;
  elevenLabsSourceLangCode?: string;
  numSpeakers: number;
  credentials?: WorkflowCredentialsInput;
}): Promise<string> {
  "use step";
  const elevenLabsApiKey = await getApiKeyFromEnv("elevenlabs", credentials);

  // Hand ElevenLabs the Mux audio URL directly so it fetches the source itself,
  // instead of downloading the bytes onto the workflow runner and re-uploading them.
  const formData = new FormData();
  formData.append("source_url", sourceUrl);
  formData.append("target_lang", elevenLabsLangCode);
  if (elevenLabsSourceLangCode) {
    formData.append("source_lang", elevenLabsSourceLangCode);
  }
  formData.append("num_speakers", numSpeakers.toString());
  formData.append(
    "name",
    `Mux Asset ${assetId} - ${elevenLabsSourceLangCode ?? "auto"} to ${elevenLabsLangCode}`,
  );

  const dubbingResponse = await fetch("https://api.elevenlabs.io/v1/dubbing", {
    method: "POST",
    headers: {
      "xi-api-key": elevenLabsApiKey,
    },
    body: formData,
  });

  if (!dubbingResponse.ok) {
    throw new Error(`ElevenLabs API error: ${dubbingResponse.statusText}`);
  }

  const dubbingData = await dubbingResponse.json() as any;
  return dubbingData.dubbing_id;
}

async function checkElevenLabsDubbingStatus({
  dubbingId,
  credentials,
}: {
  dubbingId: string;
  credentials?: WorkflowCredentialsInput;
}): Promise<{ status: string; targetLanguages: string[] }> {
  "use step";
  const elevenLabsApiKey = await getApiKeyFromEnv("elevenlabs", credentials);

  const statusResponse = await fetch(`https://api.elevenlabs.io/v1/dubbing/${dubbingId}`, {
    headers: {
      "xi-api-key": elevenLabsApiKey,
    },
  });

  if (!statusResponse.ok) {
    throw new Error(`Status check failed: ${statusResponse.statusText}`);
  }

  const statusData = await statusResponse.json() as any;
  return {
    status: statusData.status,
    targetLanguages: statusData.target_languages ?? [],
  };
}

/**
 * Download dubbed audio from ElevenLabs and upload to S3 in a single step so the audio
 * bytes never cross a workflow step boundary. Step inputs/outputs are persisted
 * to the durable event log, which has a payload size cap, so the single step prevents errors.
 */
async function downloadAndUploadDubbedAudio({
  dubbingId,
  languageCode,
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
  languageCode: string;
  assetId: string;
  toLanguageCode: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  storageAdapter?: StorageAdapter;
  s3SignedUrlExpirySeconds?: number;
  credentials?: WorkflowCredentialsInput;
}): Promise<string> {
  "use step";
  const elevenLabsApiKey = await getApiKeyFromEnv("elevenlabs", credentials);

  const audioUrl = `https://api.elevenlabs.io/v1/dubbing/${dubbingId}/audio/${languageCode}`;
  const audioResponse = await fetch(audioUrl, {
    headers: {
      "xi-api-key": elevenLabsApiKey,
    },
  });

  if (!audioResponse.ok) {
    throw new Error(`Failed to fetch dubbed audio: ${audioResponse.statusText}`);
  }

  const dubbedAudio = new Uint8Array(await audioResponse.arrayBuffer());

  const s3AccessKeyId = env.S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = env.S3_SECRET_ACCESS_KEY;

  // Create unique key for the audio file
  const audioKey = `audio-translations/${assetId}/auto-to-${toLanguageCode}-${Date.now()}.m4a`;

  await putObjectWithStorageAdapter({
    accessKeyId: s3AccessKeyId,
    secretAccessKey: s3SecretAccessKey,
    endpoint: s3Endpoint,
    region: s3Region,
    bucket: s3Bucket,
    key: audioKey,
    body: dubbedAudio,
    contentType: "audio/mp4",
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

  return presignedUrl;
}

/**
 * Download the dub's translated transcript (WebVTT) from ElevenLabs and stage it to S3,
 * returning a presigned URL. Single step for the same event-log payload reason as
 * `downloadAndUploadDubbedAudio`.
 */
async function downloadAndUploadDubTranscript({
  dubbingId,
  languageCode,
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
  languageCode: string;
  assetId: string;
  toLanguageCode: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  storageAdapter?: StorageAdapter;
  s3SignedUrlExpirySeconds?: number;
  credentials?: WorkflowCredentialsInput;
}): Promise<string> {
  "use step";
  const elevenLabsApiKey = await getApiKeyFromEnv("elevenlabs", credentials);

  const transcriptUrl = `https://api.elevenlabs.io/v1/dubbing/${dubbingId}/transcripts/${languageCode}/format/webvtt`;
  const transcriptResponse = await fetch(transcriptUrl, {
    headers: {
      "xi-api-key": elevenLabsApiKey,
    },
  });

  if (!transcriptResponse.ok) {
    throw new Error(`Failed to fetch dub transcript: ${transcriptResponse.statusText}`);
  }

  const transcriptVtt = await transcriptResponse.text();

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

  return presignedUrl;
}

async function createAudioTrackOnMux(
  assetId: string,
  languageCode: string,
  presignedUrl: string,
  credentials?: WorkflowCredentialsInput,
): Promise<string> {
  "use step";
  const muxClient = await resolveMuxClient(credentials);
  const mux = await muxClient.createClient();
  const languageName = new Intl.DisplayNames(["en"], { type: "language" }).of(languageCode) || languageCode.toUpperCase();
  const trackName = `${languageName} (auto-dubbed)`;

  const trackResponse = await mux.video.assets.createTrack(assetId, {
    type: "audio",
    language_code: languageCode,
    name: trackName,
    url: presignedUrl,
  });

  if (!trackResponse.id) {
    throw new Error("Failed to create audio track: no track ID returned from Mux");
  }

  return trackResponse.id;
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
    storageAdapter,
    credentials: providedCredentials,
  } = options;

  if (provider !== "elevenlabs") {
    throw new MuxAiError("Only ElevenLabs provider is currently supported for audio translation.", { type: "validation_error" });
  }

  const credentials = providedCredentials;
  const effectiveStorageAdapter = storageAdapter;

  const uploadToMux = uploadToMuxOption !== false; // Default to true
  const uploadToS3 = uploadToS3Option || uploadToMux || uploadCaptionsToMux; // Defaults to uploadToMux; Mux uploads force S3 staging

  // S3 configuration
  const s3Endpoint = options.s3Endpoint ?? env.S3_ENDPOINT;
  const s3Region = options.s3Region ?? env.S3_REGION ?? "auto";
  const s3Bucket = options.s3Bucket ?? env.S3_BUCKET;
  const s3AccessKeyId = env.S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = env.S3_SECRET_ACCESS_KEY;

  if (uploadToS3 && (!s3Endpoint || !s3Bucket || (!effectiveStorageAdapter && (!s3AccessKeyId || !s3SecretAccessKey)))) {
    throw new MuxAiError("Storage configuration is required for uploading. Provide s3Endpoint and s3Bucket. If no storageAdapter is supplied, also provide s3AccessKeyId and s3SecretAccessKey in options or set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY environment variables.", { type: "validation_error" });
  }

  // Fetch asset data and playback ID from Mux
  const { asset: initialAsset, playbackId, policy } = await getPlaybackIdForAsset(assetId, credentials);
  const assetDurationSeconds = getAssetDurationSecondsFromAsset(initialAsset);

  // Check for audio-only static rendition

  let currentAsset = initialAsset;
  if (!hasReadyAudioStaticRendition(currentAsset)) {
    console.warn("❌ No ready audio static rendition found. Requesting one now...");
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
      { type: "validation_error" },
    );
  }

  // Build audio URL (signed if needed)
  let audioUrl = `${getMuxStreamOrigin()}/${playbackId}/audio.m4a`;
  if (policy === "signed") {
    audioUrl = await signUrl(audioUrl, playbackId, "video", undefined, credentials);
  }

  // Create dubbing job in ElevenLabs
  console.warn("🎙️ Creating dubbing job in ElevenLabs...");

  // ElevenLabs uses ISO 639-3 (3-letter) codes, so normalize the input
  const elevenLabsLangCode = toISO639_3(toLanguageCode);
  const normalizedFromLanguageCode = fromLanguageCode?.trim();
  const elevenLabsSourceLangCode = normalizedFromLanguageCode ? toISO639_3(normalizedFromLanguageCode) : undefined;
  console.warn(
    `🔍 Creating dubbing job for asset ${assetId}: ${elevenLabsSourceLangCode ?? "auto"} -> ${elevenLabsLangCode}`,
  );

  let dubbingId: string;
  try {
    dubbingId = await createElevenLabsDubbingJob({
      sourceUrl: audioUrl,
      assetId,
      elevenLabsLangCode,
      elevenLabsSourceLangCode,
      numSpeakers,
      credentials,
    });
    console.warn(`✅ Dubbing job created with ID: ${dubbingId}`);
  } catch (error) {
    wrapError(error, "Failed to create ElevenLabs dubbing job");
  }

  // Poll for completion. ElevenLabs added intermediate dubbing states
  console.warn("⏳ Waiting for dubbing to complete...");

  const dubbingPollTimeoutSeconds = options.dubbingPollTimeoutSeconds ?? DEFAULT_DUBBING_POLL_TIMEOUT_SECONDS;
  const maxPollAttempts = Math.max(1, Math.ceil((dubbingPollTimeoutSeconds * 1000) / DUBBING_POLL_INTERVAL_MS));

  let dubbingStatus = "dubbing";
  let pollAttempts = 0;
  let targetLanguages: string[] = [];

  while (dubbingStatus !== "dubbed" && pollAttempts < maxPollAttempts) {
    await sleep(DUBBING_POLL_INTERVAL_MS);
    pollAttempts++;

    try {
      const statusResult = await checkElevenLabsDubbingStatus({
        dubbingId,
        credentials,
      });
      dubbingStatus = statusResult.status;
      targetLanguages = statusResult.targetLanguages;
    } catch (error) {
      wrapError(error, "Failed to check dubbing status");
    }

    if (dubbingStatus === "failed") {
      throw new MuxAiError("ElevenLabs reported that the dubbing job failed.", { type: "processing_error" });
    }
  }

  if (dubbingStatus !== "dubbed") {
    throw new MuxAiError("Audio translation timed out or failed. Please try again.", { type: "timeout_error", retryable: true });
  }

  console.warn("✅ Dubbing completed successfully!");

  let presignedUrl: string | undefined;
  let uploadedTrackId: string | undefined;
  let captionsPresignedUrl: string | undefined;
  let captionsTrackId: string | undefined;

  if (uploadToS3) {
    console.warn("📥 Downloading dubbed audio from ElevenLabs and staging to S3...");

    // ElevenLabs reports target_languages in ISO 639-1 and the download
    // endpoint expects one of those codes. A single-target dub yields exactly
    // one entry, so use it directly; fall back to the ISO 639-1 form of the
    // requested language if the array is unexpectedly empty.
    const downloadLangCode = targetLanguages[0] ?? toISO639_1(toLanguageCode);

    try {
      presignedUrl = await downloadAndUploadDubbedAudio({
        dubbingId,
        languageCode: downloadLangCode,
        assetId,
        toLanguageCode,
        s3Endpoint: s3Endpoint!,
        s3Region,
        s3Bucket: s3Bucket!,
        storageAdapter: effectiveStorageAdapter,
        s3SignedUrlExpirySeconds: options.s3SignedUrlExpirySeconds,
        credentials,
      });
      console.warn("✅ Dubbed audio staged to S3 successfully!");
    } catch (error) {
      wrapError(error, "Failed to download and upload dubbed audio");
    }

    // Add translated audio track to Mux asset (only when uploadToMux is true)
    if (uploadToMux) {
      console.warn("📹 Adding dubbed audio track to Mux asset...");
      // Mux uses ISO 639-1 (2-letter) codes for track language_code
      const muxLangCode = toISO639_1(toLanguageCode);

      try {
        uploadedTrackId = await createAudioTrackOnMux(assetId, muxLangCode, presignedUrl!, credentials);
        const languageName = new Intl.DisplayNames(["en"], { type: "language" }).of(muxLangCode) || muxLangCode.toUpperCase();
        const trackName = `${languageName} (auto-dubbed)`;
        console.warn(`✅ Track added to Mux asset with ID: ${uploadedTrackId}`);
        console.warn(`📋 Track name: "${trackName}"`);
      } catch (error) {
        console.warn(`⚠️ Failed to add audio track to Mux asset: ${error instanceof Error ? error.message : "Unknown error"}`);
        console.warn("🔗 You can manually add the track using this presigned URL:");
        console.warn(presignedUrl);
      }
    }

    // The dub's translated transcript is the same translation that was voiced, and
    // fetching it costs nothing extra. Soft-fail everything here: a transcript problem
    // must never fail a completed, paid-for dub.
    try {
      console.warn("📥 Downloading dub transcript from ElevenLabs and staging to S3...");
      captionsPresignedUrl = await downloadAndUploadDubTranscript({
        dubbingId,
        languageCode: downloadLangCode,
        assetId,
        toLanguageCode,
        s3Endpoint: s3Endpoint!,
        s3Region,
        s3Bucket: s3Bucket!,
        storageAdapter: effectiveStorageAdapter,
        s3SignedUrlExpirySeconds: options.s3SignedUrlExpirySeconds,
        credentials,
      });

      if (uploadCaptionsToMux) {
        console.warn("📹 Adding dubbed captions track to Mux asset...");
        const muxLangCode = toISO639_1(toLanguageCode);
        const languageName = new Intl.DisplayNames(["en"], { type: "language" }).of(muxLangCode) || muxLangCode.toUpperCase();
        captionsTrackId = await createTextTrackOnMux(
          assetId,
          muxLangCode,
          `${languageName} (auto-dubbed)`,
          captionsPresignedUrl,
          credentials,
        );
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

  const targetLanguage = getLanguageCodePair(toLanguageCode);
  return {
    assetId,
    targetLanguageCode: targetLanguage.iso639_1 as SupportedISO639_1,
    targetLanguage,
    dubbingId,
    uploadedTrackId,
    presignedUrl,
    captionsTrackId,
    captionsPresignedUrl,
    usage: {
      metadata: {
        assetDurationSeconds,
      },
    },
  };
}
