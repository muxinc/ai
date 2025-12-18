import Mux from "@mux/mux-node";

import env from "@mux/ai/env";
import { getApiKeyFromEnv, getMuxCredentialsFromEnv } from "@mux/ai/lib/client-factory";
import { getLanguageCodePair, toISO639_1, toISO639_3 } from "@mux/ai/lib/language-codes";
import type { LanguageCodePair, SupportedISO639_1 } from "@mux/ai/lib/language-codes";
import { getPlaybackIdForAsset } from "@mux/ai/lib/mux-assets";
import { getMuxSigningContextFromEnv, signUrl } from "@mux/ai/lib/url-signing";
import type { MuxAIOptions } from "@mux/ai/types";

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
}

/** Configuration accepted by `translateAudio`. */
export interface AudioTranslationOptions extends MuxAIOptions {
  /** Audio dubbing provider (currently ElevenLabs only). */
  provider?: "elevenlabs";
  /** Number of speakers supplied to ElevenLabs (0 = auto-detect, default). */
  numSpeakers?: number;
  /** Optional override for the S3-compatible endpoint used for uploads. */
  s3Endpoint?: string;
  /** S3 region (defaults to env.S3_REGION or 'auto'). */
  s3Region?: string;
  /** Bucket that will store dubbed audio files. */
  s3Bucket?: string;
  /**
   * When true (default) the dubbed audio file is uploaded to the configured
   * bucket and attached to the Mux asset.
   */
  uploadToMux?: boolean;
  /** Override for env.ELEVENLABS_API_KEY. */
  elevenLabsApiKey?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

const STATIC_RENDITION_POLL_INTERVAL_MS = 5000;
const STATIC_RENDITION_MAX_ATTEMPTS = 36; // ~3 minutes

async function sleep(ms: number): Promise<void> {
  "use step";
  await new Promise(resolve => setTimeout(resolve, ms));
}

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

async function requestStaticRenditionCreation(assetId: string) {
  "use step";
  const { muxTokenId, muxTokenSecret } = getMuxCredentialsFromEnv();
  const mux = new Mux({
    tokenId: muxTokenId,
    tokenSecret: muxTokenSecret,
  });
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

    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to request static rendition from Mux: ${message}`);
  }
}

async function waitForAudioStaticRendition({
  assetId,
  initialAsset,
}: {
  assetId: string;
  initialAsset: any;
}): Promise<any> {
  "use step";
  const { muxTokenId, muxTokenSecret } = getMuxCredentialsFromEnv();
  const mux = new Mux({
    tokenId: muxTokenId,
    tokenSecret: muxTokenSecret,
  });
  let currentAsset = initialAsset;

  if (hasReadyAudioStaticRendition(currentAsset)) {
    return currentAsset;
  }

  const status = currentAsset.static_renditions?.status ?? "not_requested";

  if (status === "not_requested" || status === undefined) {
    await requestStaticRenditionCreation(assetId);
  } else if (status === "errored") {
    await requestStaticRenditionCreation(assetId);
  } else {
    console.warn(`ℹ️ Static rendition already ${status}. Waiting for it to finish...`);
  }

  for (let attempt = 1; attempt <= STATIC_RENDITION_MAX_ATTEMPTS; attempt++) {
    await sleep(STATIC_RENDITION_POLL_INTERVAL_MS);
    currentAsset = await mux.video.assets.retrieve(assetId);

    if (hasReadyAudioStaticRendition(currentAsset)) {
      return currentAsset;
    }

    const currentStatus = currentAsset.static_renditions?.status || "unknown";
    console.warn(
      `⌛ Waiting for static rendition (attempt ${attempt}/${STATIC_RENDITION_MAX_ATTEMPTS}) → ${currentStatus}`,
    );

    if (currentStatus === "errored") {
      throw new Error(
        "Mux failed to create the static rendition for this asset. Please check the asset in the Mux dashboard.",
      );
    }
  }

  throw new Error(
    "Timed out waiting for the static rendition to become ready. Please try again in a moment.",
  );
}

async function fetchAudioFromMux(audioUrl: string): Promise<ArrayBuffer> {
  "use step";

  const audioResponse = await fetch(audioUrl);
  if (!audioResponse.ok) {
    throw new Error(`Failed to fetch audio file: ${audioResponse.statusText}`);
  }

  return audioResponse.arrayBuffer();
}

async function createElevenLabsDubbingJob({
  audioBuffer,
  assetId,
  elevenLabsLangCode,
  numSpeakers,
}: {
  audioBuffer: ArrayBuffer;
  assetId: string;
  elevenLabsLangCode: string;
  numSpeakers: number;
}): Promise<string> {
  "use step";
  const elevenLabsApiKey = getApiKeyFromEnv("elevenlabs");

  const audioBlob = new Blob([audioBuffer], { type: "audio/mp4" });

  const formData = new FormData();
  formData.append("file", audioBlob);
  formData.append("target_lang", elevenLabsLangCode);
  formData.append("num_speakers", numSpeakers.toString());
  formData.append("name", `Mux Asset ${assetId} - auto to ${elevenLabsLangCode}`);

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
}: {
  dubbingId: string;
}): Promise<{ status: string; targetLanguages: string[] }> {
  "use step";
  const elevenLabsApiKey = getApiKeyFromEnv("elevenlabs");

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

async function downloadDubbedAudioFromElevenLabs({
  dubbingId,
  languageCode,
}: {
  dubbingId: string;
  languageCode: string;
}): Promise<ArrayBuffer> {
  "use step";
  const elevenLabsApiKey = getApiKeyFromEnv("elevenlabs");

  const audioUrl = `https://api.elevenlabs.io/v1/dubbing/${dubbingId}/audio/${languageCode}`;
  const audioResponse = await fetch(audioUrl, {
    headers: {
      "xi-api-key": elevenLabsApiKey,
    },
  });

  if (!audioResponse.ok) {
    throw new Error(`Failed to fetch dubbed audio: ${audioResponse.statusText}`);
  }

  return audioResponse.arrayBuffer();
}

async function uploadDubbedAudioToS3({
  dubbedAudioBuffer,
  assetId,
  toLanguageCode,
  s3Endpoint,
  s3Region,
  s3Bucket,
}: {
  dubbedAudioBuffer: ArrayBuffer;
  assetId: string;
  toLanguageCode: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
}): Promise<string> {
  "use step";

  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { Upload } = await import("@aws-sdk/lib-storage");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

  // asserting exists. already validated (See: translateAudio())
  const s3AccessKeyId = env.S3_ACCESS_KEY_ID!;
  const s3SecretAccessKey = env.S3_SECRET_ACCESS_KEY!;

  const s3Client = new S3Client({
    region: s3Region,
    endpoint: s3Endpoint,
    credentials: {
      accessKeyId: s3AccessKeyId,
      secretAccessKey: s3SecretAccessKey,
    },
    forcePathStyle: true,
  });

  // Create unique key for the audio file
  const audioKey = `audio-translations/${assetId}/auto-to-${toLanguageCode}-${Date.now()}.m4a`;

  // Upload audio to S3
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: s3Bucket,
      Key: audioKey,
      Body: new Uint8Array(dubbedAudioBuffer),
      ContentType: "audio/mp4",
    },
  });

  await upload.done();

  // Generate presigned URL (valid for 1 hour)
  const getObjectCommand = new GetObjectCommand({
    Bucket: s3Bucket,
    Key: audioKey,
  });

  const presignedUrl = await getSignedUrl(s3Client, getObjectCommand, {
    expiresIn: 3600, // 1 hour
  });

  console.warn(`✅ Audio uploaded successfully to: ${audioKey}`);
  console.warn(`🔗 Generated presigned URL (expires in 1 hour)`);

  return presignedUrl;
}

async function createAudioTrackOnMux(
  assetId: string,
  languageCode: string,
  presignedUrl: string,
): Promise<string> {
  "use step";
  const { muxTokenId, muxTokenSecret } = getMuxCredentialsFromEnv();
  const mux = new Mux({
    tokenId: muxTokenId,
    tokenSecret: muxTokenSecret,
  });
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
  // Uses the default audio track on your asset, language is auto-detected by ElevenLabs
  const {
    provider = "elevenlabs",
    numSpeakers = 0, // 0 = auto-detect
    elevenLabsApiKey,
    uploadToMux = true,
  } = options;

  if (provider !== "elevenlabs") {
    throw new Error("Only ElevenLabs provider is currently supported for audio translation");
  }

  const elevenLabsKey = elevenLabsApiKey ?? env.ELEVENLABS_API_KEY;

  // S3 configuration
  const s3Endpoint = options.s3Endpoint ?? env.S3_ENDPOINT;
  const s3Region = options.s3Region ?? env.S3_REGION ?? "auto";
  const s3Bucket = options.s3Bucket ?? env.S3_BUCKET;
  const s3AccessKeyId = env.S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = env.S3_SECRET_ACCESS_KEY;

  if (!elevenLabsKey) {
    throw new Error("ElevenLabs API key is required. Provide elevenLabsApiKey in options or set ELEVENLABS_API_KEY environment variable.");
  }

  if (uploadToMux && (!s3Endpoint || !s3Bucket || !s3AccessKeyId || !s3SecretAccessKey)) {
    throw new Error("S3 configuration is required for uploading to Mux. Provide s3Endpoint, s3Bucket, s3AccessKeyId, and s3SecretAccessKey in options or set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY environment variables.");
  }

  // Fetch asset data and playback ID from Mux
  const { asset: initialAsset, playbackId, policy } = await getPlaybackIdForAsset(assetId);

  // Resolve signing context for signed playback IDs
  const signingContext = getMuxSigningContextFromEnv();
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. " +
      "Provide muxSigningKey and muxPrivateKey in options or set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  // Check for audio-only static rendition

  let currentAsset = initialAsset;
  if (!hasReadyAudioStaticRendition(currentAsset)) {
    console.warn("❌ No ready audio static rendition found. Requesting one now...");
    currentAsset = await waitForAudioStaticRendition({
      assetId,
      initialAsset: currentAsset,
    });
  }

  const audioRendition = getReadyAudioStaticRendition(currentAsset);

  if (!audioRendition) {
    throw new Error(
      "Unable to obtain an audio-only static rendition for this asset. Please verify static renditions are enabled in Mux.",
    );
  }

  // Build audio URL (signed if needed)
  let audioUrl = `https://stream.mux.com/${playbackId}/audio.m4a`;
  if (policy === "signed" && signingContext) {
    audioUrl = await signUrl(audioUrl, playbackId, signingContext, "video");
  }

  // Fetch audio from Mux
  console.warn("🎙️ Fetching audio from Mux...");

  let audioBuffer: ArrayBuffer;
  try {
    audioBuffer = await fetchAudioFromMux(audioUrl);
  } catch (error) {
    throw new Error(`Failed to fetch audio from Mux: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  // Create dubbing job in ElevenLabs
  console.warn("🎙️ Creating dubbing job in ElevenLabs...");

  // ElevenLabs uses ISO 639-3 (3-letter) codes, so normalize the input
  const elevenLabsLangCode = toISO639_3(toLanguageCode);
  console.warn(`🔍 Creating dubbing job for asset ${assetId} with language code: ${elevenLabsLangCode}`);

  let dubbingId: string;
  try {
    dubbingId = await createElevenLabsDubbingJob({
      audioBuffer,
      assetId,
      elevenLabsLangCode,
      numSpeakers,
    });
    console.warn(`✅ Dubbing job created with ID: ${dubbingId}`);
  } catch (error) {
    throw new Error(`Failed to create ElevenLabs dubbing job: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  // Poll for completion
  console.warn("⏳ Waiting for dubbing to complete...");

  let dubbingStatus: string = "dubbing";
  let pollAttempts = 0;
  const maxPollAttempts = 180; // 30 minutes at 10s intervals
  let targetLanguages: string[] = [];

  while (dubbingStatus === "dubbing" && pollAttempts < maxPollAttempts) {
    await sleep(10000); // Wait 10 seconds
    pollAttempts++;

    try {
      const statusResult = await checkElevenLabsDubbingStatus({
        dubbingId,
      });
      dubbingStatus = statusResult.status;
      targetLanguages = statusResult.targetLanguages;

      if (dubbingStatus === "failed") {
        throw new Error("ElevenLabs dubbing job failed");
      }
    } catch (error) {
      throw new Error(`Failed to check dubbing status: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  if (dubbingStatus !== "dubbed") {
    throw new Error(`Dubbing job timed out or failed. Final status: ${dubbingStatus}`);
  }

  console.warn("✅ Dubbing completed successfully!");

  // If uploadToMux is false, just return the dubbing info
  // Return ISO 639-1 (2-letter) code for consistency with Mux/player expectations
  if (!uploadToMux) {
    const targetLanguage = getLanguageCodePair(toLanguageCode);
    return {
      assetId,
      targetLanguageCode: targetLanguage.iso639_1 as SupportedISO639_1,
      targetLanguage,
      dubbingId,
    };
  }

  // Download dubbed audio from ElevenLabs
  console.warn("📥 Downloading dubbed audio from ElevenLabs...");

  let dubbedAudioBuffer: ArrayBuffer;

  try {
    // Use the language code from the ElevenLabs status response
    // ElevenLabs returns target_languages array with the exact codes available for download
    const requestedLangCode = toISO639_3(toLanguageCode);

    // Find the matching language code from ElevenLabs response
    // First try exact match, then try case-insensitive match
    let downloadLangCode = targetLanguages.find(
      lang => lang === requestedLangCode,
    ) ?? targetLanguages.find(
      lang => lang.toLowerCase() === requestedLangCode.toLowerCase(),
    );

    // Fallback to first available target language if no match found
    if (!downloadLangCode && targetLanguages.length > 0) {
      downloadLangCode = targetLanguages[0];
      console.warn(`⚠️ Requested language "${requestedLangCode}" not found in target_languages. Using "${downloadLangCode}" instead.`);
    }

    // If still no language code, fall back to the original behavior
    if (!downloadLangCode) {
      downloadLangCode = requestedLangCode;
      console.warn(`⚠️ No target_languages available from ElevenLabs status. Using requested language code: ${requestedLangCode}`);
    }

    dubbedAudioBuffer = await downloadDubbedAudioFromElevenLabs({
      dubbingId,
      languageCode: downloadLangCode,
    });
    console.warn("✅ Dubbed audio downloaded successfully!");
  } catch (error) {
    throw new Error(`Failed to download dubbed audio: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  // Upload to S3-compatible storage
  console.warn("📤 Uploading dubbed audio to S3-compatible storage...");

  let presignedUrl: string;

  try {
    presignedUrl = await uploadDubbedAudioToS3({
      dubbedAudioBuffer,
      assetId,
      toLanguageCode,
      s3Endpoint: s3Endpoint!,
      s3Region,
      s3Bucket: s3Bucket!,
    });
  } catch (error) {
    throw new Error(`Failed to upload audio to S3: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  // Add translated audio track to Mux asset
  console.warn("📹 Adding dubbed audio track to Mux asset...");

  let uploadedTrackId: string | undefined;
  // Mux uses ISO 639-1 (2-letter) codes for track language_code
  const muxLangCode = toISO639_1(toLanguageCode);

  try {
    uploadedTrackId = await createAudioTrackOnMux(assetId, muxLangCode, presignedUrl);
    const languageName = new Intl.DisplayNames(["en"], { type: "language" }).of(muxLangCode) || muxLangCode.toUpperCase();
    const trackName = `${languageName} (auto-dubbed)`;
    console.warn(`✅ Track added to Mux asset with ID: ${uploadedTrackId}`);
    console.warn(`📋 Track name: "${trackName}"`);
  } catch (error) {
    console.warn(`⚠️ Failed to add audio track to Mux asset: ${error instanceof Error ? error.message : "Unknown error"}`);
    console.warn("🔗 You can manually add the track using this presigned URL:");
    console.warn(presignedUrl);
  }

  const targetLanguage = getLanguageCodePair(toLanguageCode);
  return {
    assetId,
    targetLanguageCode: targetLanguage.iso639_1 as SupportedISO639_1,
    targetLanguage,
    dubbingId,
    uploadedTrackId,
    presignedUrl,
  };
}
