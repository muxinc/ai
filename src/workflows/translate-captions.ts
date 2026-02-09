import { generateText, Output } from "ai";
import { z } from "zod";

import env from "@mux/ai/env";
import { muxClient } from "@mux/ai/lib/client-factory";
import { getLanguageCodePair, getLanguageName } from "@mux/ai/lib/language-codes";
import type { LanguageCodePair, SupportedISO639_1 } from "@mux/ai/lib/language-codes";
import {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  isAudioOnlyAsset,
} from "@mux/ai/lib/mux-assets";
import { createLanguageModelFromConfig, resolveLanguageModelConfig } from "@mux/ai/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "@mux/ai/lib/providers";
import { resolveMuxSigningContext } from "@mux/ai/lib/workflow-credentials";
import { buildTranscriptUrl, getReadyTextTracks } from "@mux/ai/primitives/transcripts";
import type { MuxAIOptions, TokenUsage, WorkflowCredentialsInput } from "@mux/ai/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Output returned from `translateCaptions`. */
export interface TranslationResult {
  assetId: string;
  /** Source language code (ISO 639-1 two-letter format). */
  sourceLanguageCode: SupportedISO639_1;
  /** Target language code (ISO 639-1 two-letter format). */
  targetLanguageCode: SupportedISO639_1;
  /**
   * Source language codes in both ISO 639-1 (2-letter) and ISO 639-3 (3-letter) formats.
   * Use `iso639_1` for browser players (BCP-47 compliant) and `iso639_3` for APIs that require it.
   */
  sourceLanguage: LanguageCodePair;
  /**
   * Target language codes in both ISO 639-1 (2-letter) and ISO 639-3 (3-letter) formats.
   * Use `iso639_1` for browser players (BCP-47 compliant) and `iso639_3` for APIs that require it.
   */
  targetLanguage: LanguageCodePair;
  originalVtt: string;
  translatedVtt: string;
  uploadedTrackId?: string;
  presignedUrl?: string;
  /** Token usage from the AI provider (for efficiency/cost analysis). */
  usage?: TokenUsage;
}

/** Configuration accepted by `translateCaptions`. */
export interface TranslationOptions<P extends SupportedProvider = SupportedProvider> extends MuxAIOptions {
  /** Provider responsible for the translation. */
  provider: P;
  /** Provider-specific chat model identifier. */
  model?: ModelIdByProvider[P];
  /** Optional override for the S3-compatible endpoint used for uploads. */
  s3Endpoint?: string;
  /** S3 region (defaults to env.S3_REGION or 'auto'). */
  s3Region?: string;
  /** Bucket that will store translated VTT files. */
  s3Bucket?: string;
  /**
   * When true (default) the translated VTT is uploaded to the configured
   * bucket and attached to the Mux asset.
   */
  uploadToMux?: boolean;
}

/** Schema used when requesting caption translation from a language model. */
export const translationSchema = z.object({
  translation: z.string(),
});

/** Inferred shape returned by `translationSchema`. */
export type TranslationPayload = z.infer<typeof translationSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

async function fetchVttFromMux(vttUrl: string): Promise<string> {
  "use step";

  const vttResponse = await fetch(vttUrl);
  if (!vttResponse.ok) {
    throw new Error(`Failed to fetch VTT file: ${vttResponse.statusText}`);
  }

  return vttResponse.text();
}

async function translateVttWithAI({
  vttContent,
  fromLanguageCode,
  toLanguageCode,
  provider,
  modelId,
  credentials,
}: {
  vttContent: string;
  fromLanguageCode: string;
  toLanguageCode: string;
  provider: SupportedProvider;
  modelId: string;
  credentials?: WorkflowCredentialsInput;
}): Promise<{ translatedVtt: string; usage: TokenUsage }> {
  "use step";

  const model = await createLanguageModelFromConfig(provider, modelId, credentials);

  const response = await generateText({
    model,
    output: Output.object({ schema: translationSchema }),
    messages: [
      {
        role: "user",
        content: `Translate the following VTT subtitle file from ${fromLanguageCode} to ${toLanguageCode}. Preserve all timestamps and VTT formatting exactly as they appear. Return JSON with a single key "translation" containing the translated VTT.\n\n${vttContent}`,
      },
    ],
  });

  return {
    translatedVtt: response.output.translation,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      reasoningTokens: response.usage.reasoningTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
    },
  };
}

async function uploadVttToS3({
  translatedVtt,
  assetId,
  fromLanguageCode,
  toLanguageCode,
  s3Endpoint,
  s3Region,
  s3Bucket,
}: {
  translatedVtt: string;
  assetId: string;
  fromLanguageCode: string;
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

  // Create unique key for the VTT file
  const vttKey = `translations/${assetId}/${fromLanguageCode}-to-${toLanguageCode}-${Date.now()}.vtt`;

  // Upload VTT to S3
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: s3Bucket,
      Key: vttKey,
      Body: translatedVtt,
      ContentType: "text/vtt",
    },
  });

  await upload.done();

  // Generate presigned URL (valid for 1 hour)
  const getObjectCommand = new GetObjectCommand({
    Bucket: s3Bucket,
    Key: vttKey,
  });

  const presignedUrl = await getSignedUrl(s3Client, getObjectCommand, {
    expiresIn: 3600, // 1 hour
  });

  return presignedUrl;
}

async function createTextTrackOnMux(
  assetId: string,
  languageCode: string,
  trackName: string,
  presignedUrl: string,
  credentials?: WorkflowCredentialsInput,
): Promise<string> {
  "use step";
  const mux = await muxClient(credentials);

  const trackResponse = await mux.video.assets.createTrack(assetId, {
    type: "text",
    text_type: "subtitles",
    language_code: languageCode,
    name: trackName,
    url: presignedUrl,
  });

  if (!trackResponse.id) {
    throw new Error("Failed to create text track: no track ID returned from Mux");
  }

  return trackResponse.id;
}

export async function translateCaptions<P extends SupportedProvider = SupportedProvider>(
  assetId: string,
  fromLanguageCode: string,
  toLanguageCode: string,
  options: TranslationOptions<P>,
): Promise<TranslationResult> {
  "use workflow";
  const {
    provider = "openai",
    model,
    s3Endpoint: providedS3Endpoint,
    s3Region: providedS3Region,
    s3Bucket: providedS3Bucket,
    uploadToMux: uploadToMuxOption,
    credentials,
  } = options;

  // S3 configuration
  const s3Endpoint = providedS3Endpoint ?? env.S3_ENDPOINT;
  const s3Region = providedS3Region ?? env.S3_REGION ?? "auto";
  const s3Bucket = providedS3Bucket ?? env.S3_BUCKET;
  const s3AccessKeyId = env.S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = env.S3_SECRET_ACCESS_KEY;
  const uploadToMux = uploadToMuxOption !== false; // Default to true

  const modelConfig = resolveLanguageModelConfig({
    ...options,
    model,
    provider: provider as SupportedProvider,
  });

  if (uploadToMux && (!s3Endpoint || !s3Bucket || !s3AccessKeyId || !s3SecretAccessKey)) {
    throw new Error("S3 configuration is required for uploading to Mux. Provide s3Endpoint, s3Bucket, s3AccessKeyId, and s3SecretAccessKey in options or set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY environment variables.");
  }

  // Fetch asset data and playback ID from Mux
  const { asset: assetData, playbackId, policy } = await getPlaybackIdForAsset(
    assetId,
    credentials,
  );
  const assetDurationSeconds = getAssetDurationSecondsFromAsset(assetData);
  const isAudioOnly = isAudioOnlyAsset(assetData);

  // Resolve signing context for signed playback IDs
  const signingContext = await resolveMuxSigningContext(credentials);
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. " +
      "Set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  // Find text track with the source language
  const readyTextTracks = getReadyTextTracks(assetData);
  if (!readyTextTracks.length) {
    throw new Error("No ready text tracks found for this asset");
  }

  let sourceTextTrack = readyTextTracks.find(track =>
    track.text_type === "subtitles" &&
    track.language_code === fromLanguageCode,
  );

  if (!sourceTextTrack && isAudioOnly && readyTextTracks.length === 1) {
    sourceTextTrack = readyTextTracks[0];
  }

  if (!sourceTextTrack) {
    const availableLanguages = readyTextTracks
      .map(t => t.language_code)
      .filter(Boolean)
      .join(", ");
    if (isAudioOnly) {
      throw new Error(
        `No transcript track found with language code '${fromLanguageCode}' for this asset. ` +
        `Audio-only assets require a transcript. Available languages: ${availableLanguages || "none"}`,
      );
    }
    throw new Error(
      `No ready text track found with language code '${fromLanguageCode}' for this asset. ` +
      `Available languages: ${availableLanguages || "none"}`,
    );
  }

  if (!sourceTextTrack.id) {
    throw new Error("Transcript track is missing an id");
  }

  // Fetch the VTT file content (signed if needed)
  const vttUrl = await buildTranscriptUrl(playbackId, sourceTextTrack.id, policy === "signed", credentials);

  let vttContent: string;
  try {
    vttContent = await fetchVttFromMux(vttUrl);
  } catch (error) {
    throw new Error(`Failed to fetch VTT content: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  // Translate VTT content using configured provider via ai-sdk
  let translatedVtt: string;
  let usage: TokenUsage | undefined;

  try {
    const result = await translateVttWithAI({
      vttContent,
      fromLanguageCode,
      toLanguageCode,
      provider: modelConfig.provider,
      modelId: modelConfig.modelId,
      credentials,
    });
    translatedVtt = result.translatedVtt;
    usage = result.usage;
  } catch (error) {
    throw new Error(`Failed to translate VTT with ${modelConfig.provider}: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  const usageWithMetadata = usage ?
      {
        ...usage,
        metadata: {
          assetDurationSeconds,
        },
      } :
    undefined;

  // Resolve language code pairs for both source and target
  const sourceLanguage = getLanguageCodePair(fromLanguageCode);
  const targetLanguage = getLanguageCodePair(toLanguageCode);

  // If uploadToMux is false, just return the translation
  if (!uploadToMux) {
    return {
      assetId,
      sourceLanguageCode: fromLanguageCode as SupportedISO639_1,
      targetLanguageCode: toLanguageCode as SupportedISO639_1,
      sourceLanguage,
      targetLanguage,
      originalVtt: vttContent,
      translatedVtt,
      usage: usageWithMetadata,
    };
  }

  // Upload translated VTT to S3-compatible storage
  let presignedUrl: string;

  try {
    presignedUrl = await uploadVttToS3({
      translatedVtt,
      assetId,
      fromLanguageCode,
      toLanguageCode,
      s3Endpoint: s3Endpoint!,
      s3Region,
      s3Bucket: s3Bucket!,
    });
  } catch (error) {
    throw new Error(`Failed to upload VTT to S3: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  // Add translated track to Mux asset
  let uploadedTrackId: string | undefined;

  try {
    const languageName = getLanguageName(toLanguageCode);
    const trackName = `${languageName} (auto-translated)`;

    uploadedTrackId = await createTextTrackOnMux(
      assetId,
      toLanguageCode,
      trackName,
      presignedUrl,
      credentials,
    );
  } catch (error) {
    console.warn(`Failed to add track to Mux asset: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  return {
    assetId,
    sourceLanguageCode: fromLanguageCode as SupportedISO639_1,
    targetLanguageCode: toLanguageCode as SupportedISO639_1,
    sourceLanguage,
    targetLanguage,
    originalVtt: vttContent,
    translatedVtt,
    uploadedTrackId,
    presignedUrl,
    usage: usageWithMetadata,
  };
}
