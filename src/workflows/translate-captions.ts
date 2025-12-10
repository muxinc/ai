import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import Mux from "@mux/mux-node";
import { generateObject } from "ai";
import { z } from "zod";

import env from "../env";
import { createWorkflowConfig } from "../lib/client-factory";
import type { ValidatedCredentials } from "../lib/client-factory";
import { getLanguageCodePair, getLanguageName } from "../lib/language-codes";
import type { LanguageCodePair, SupportedISO639_1 } from "../lib/language-codes";
import { getPlaybackIdForAsset } from "../lib/mux-assets";
import { createLanguageModelFromConfig } from "../lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "../lib/providers";
import { resolveSigningContext, signUrl } from "../lib/url-signing";
import type { MuxAIOptions, TokenUsage } from "../types";

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
  /** Access key ID used for uploads. */
  s3AccessKeyId?: string;
  /** Secret access key used for uploads. */
  s3SecretAccessKey?: string;
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

async function createTextTrackOnMux(
  credentials: ValidatedCredentials,
  assetId: string,
  languageCode: string,
  trackName: string,
  presignedUrl: string,
): Promise<string> {
  "use step";
  const mux = new Mux({
    tokenId: credentials.muxTokenId,
    tokenSecret: credentials.muxTokenSecret,
  });
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
    s3AccessKeyId: providedS3AccessKeyId,
    s3SecretAccessKey: providedS3SecretAccessKey,
    uploadToMux: uploadToMuxOption,
  } = options;

  // S3 configuration
  const s3Endpoint = providedS3Endpoint ?? env.S3_ENDPOINT;
  const s3Region = providedS3Region ?? env.S3_REGION ?? "auto";
  const s3Bucket = providedS3Bucket ?? env.S3_BUCKET;
  const s3AccessKeyId = providedS3AccessKeyId ?? env.S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = providedS3SecretAccessKey ?? env.S3_SECRET_ACCESS_KEY;
  const uploadToMux = uploadToMuxOption !== false; // Default to true

  // Validate credentials and resolve language model
  const config = await createWorkflowConfig(
    { ...options, model },
    provider as SupportedProvider,
  );

  if (uploadToMux && (!s3Endpoint || !s3Bucket || !s3AccessKeyId || !s3SecretAccessKey)) {
    throw new Error("S3 configuration is required for uploading to Mux. Provide s3Endpoint, s3Bucket, s3AccessKeyId, and s3SecretAccessKey in options or set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY environment variables.");
  }

  // Fetch asset data and playback ID from Mux
  const { asset: assetData, playbackId, policy } = await getPlaybackIdForAsset(config.credentials, assetId);

  // Resolve signing context for signed playback IDs
  const signingContext = await resolveSigningContext(options);
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. " +
      "Provide muxSigningKey and muxPrivateKey in options or set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  // Find text track with the source language
  if (!assetData.tracks) {
    throw new Error("No tracks found for this asset");
  }

  const sourceTextTrack = assetData.tracks.find(track =>
    track.type === "text" &&
    track.status === "ready" &&
    track.language_code === fromLanguageCode,
  );

  if (!sourceTextTrack) {
    throw new Error(`No ready text track found with language code '${fromLanguageCode}' for this asset`);
  }

  // Fetch the VTT file content (signed if needed)
  let vttUrl = `https://stream.mux.com/${playbackId}/text/${sourceTextTrack.id}.vtt`;
  if (policy === "signed" && signingContext) {
    vttUrl = await signUrl(vttUrl, playbackId, signingContext, "video");
  }
  let vttContent: string;

  try {
    const vttResponse = await fetch(vttUrl);
    if (!vttResponse.ok) {
      throw new Error(`Failed to fetch VTT file: ${vttResponse.statusText}`);
    }
    vttContent = await vttResponse.text();
  } catch (error) {
    throw new Error(`Failed to fetch VTT content: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  // Translate VTT content using configured provider via ai-sdk
  let translatedVtt: string;
  let usage: TokenUsage | undefined;

  try {
    const languageModel = createLanguageModelFromConfig(
      config.provider,
      config.modelId,
      config.credentials,
    );

    const response = await generateObject({
      model: languageModel,
      schema: translationSchema,
      abortSignal: options.abortSignal,
      messages: [
        {
          role: "user",
          content: `Translate the following VTT subtitle file from ${fromLanguageCode} to ${toLanguageCode}. Preserve all timestamps and VTT formatting exactly as they appear. Return JSON with a single key "translation" containing the translated VTT.\n\n${vttContent}`,
        },
      ],
    });

    translatedVtt = response.object.translation;
    usage = {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      reasoningTokens: response.usage.reasoningTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
    };
  } catch (error) {
    throw new Error(`Failed to translate VTT with ${config.provider}: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

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
      usage,
    };
  }

  // Upload translated VTT to S3-compatible storage
  const s3Client = new S3Client({
    region: s3Region,
    endpoint: s3Endpoint,
    credentials: {
      accessKeyId: s3AccessKeyId!,
      secretAccessKey: s3SecretAccessKey!,
    },
    forcePathStyle: true, // Often needed for non-AWS S3 services
  });

  // Create unique key for the VTT file
  const vttKey = `translations/${assetId}/${fromLanguageCode}-to-${toLanguageCode}-${Date.now()}.vtt`;

  let presignedUrl: string;

  try {
    // Upload VTT to S3
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: s3Bucket!,
        Key: vttKey,
        Body: translatedVtt,
        ContentType: "text/vtt",
      },
    });

    await upload.done();

    // Generate presigned URL (valid for 1 hour)
    const getObjectCommand = new GetObjectCommand({
      Bucket: s3Bucket!,
      Key: vttKey,
    });

    presignedUrl = await getSignedUrl(s3Client, getObjectCommand, {
      expiresIn: 3600, // 1 hour
    });
  } catch (error) {
    throw new Error(`Failed to upload VTT to S3: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  // Add translated track to Mux asset
  let uploadedTrackId: string | undefined;

  try {
    const languageName = getLanguageName(toLanguageCode);
    const trackName = `${languageName} (auto-translated)`;

    uploadedTrackId = await createTextTrackOnMux(config.credentials, assetId, toLanguageCode, trackName, presignedUrl);
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
    usage,
  };
}
