import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { generateObject } from "ai";
import { z } from "zod";

import type { ModelIdByProvider, SupportedProvider } from "../lib/providers";
import type { MuxAIOptions } from "../types";

import env from "../env";
import { createWorkflowClients } from "../lib/client-factory";
import { getPlaybackIdForAsset } from "../lib/mux-assets";
import { resolveSigningContext, signUrl } from "../lib/url-signing";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Output returned from `translateCaptions`. */
export interface TranslationResult {
  assetId: string;
  sourceLanguageCode: string;
  targetLanguageCode: string;
  originalVtt: string;
  translatedVtt: string;
  uploadedTrackId?: string;
  presignedUrl?: string;
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

const DEFAULT_PROVIDER = "openai";

export async function translateCaptions<P extends SupportedProvider = SupportedProvider>(
  assetId: string,
  fromLanguageCode: string,
  toLanguageCode: string,
  options: TranslationOptions<P>,
): Promise<TranslationResult> {
  const {
    provider = DEFAULT_PROVIDER,
    model,
    s3Endpoint: providedS3Endpoint,
    s3Region: providedS3Region,
    s3Bucket: providedS3Bucket,
    s3AccessKeyId: providedS3AccessKeyId,
    s3SecretAccessKey: providedS3SecretAccessKey,
    uploadToMux: uploadToMuxOption,
    ...clientConfig
  } = options;

  const resolvedProvider = provider;

  // S3 configuration
  const s3Endpoint = providedS3Endpoint ?? env.S3_ENDPOINT;
  const s3Region = providedS3Region ?? env.S3_REGION ?? "auto";
  const s3Bucket = providedS3Bucket ?? env.S3_BUCKET;
  const s3AccessKeyId = providedS3AccessKeyId ?? env.S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = providedS3SecretAccessKey ?? env.S3_SECRET_ACCESS_KEY;
  const uploadToMux = uploadToMuxOption !== false; // Default to true

  const clients = createWorkflowClients(
    { ...clientConfig, provider: resolvedProvider, model },
    resolvedProvider,
  );

  if (uploadToMux && (!s3Endpoint || !s3Bucket || !s3AccessKeyId || !s3SecretAccessKey)) {
    throw new Error("S3 configuration is required for uploading to Mux. Provide s3Endpoint, s3Bucket, s3AccessKeyId, and s3SecretAccessKey in options or set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY environment variables.");
  }

  // Fetch asset data and playback ID from Mux
  const { asset: assetData, playbackId, policy } = await getPlaybackIdForAsset(clients.mux, assetId);

  // Resolve signing context for signed playback IDs
  const signingContext = resolveSigningContext(options);
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. "
      + "Provide muxSigningKey and muxPrivateKey in options or set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  // Find text track with the source language
  if (!assetData.tracks) {
    throw new Error("No tracks found for this asset");
  }

  const sourceTextTrack = assetData.tracks.find(track =>
    track.type === "text"
    && track.status === "ready"
    && track.language_code === fromLanguageCode,
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
  }
  catch (error) {
    throw new Error(`Failed to fetch VTT content: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  console.log(`✅ Found VTT content for language '${fromLanguageCode}'`);

  // Translate VTT content using configured provider via ai-sdk
  let translatedVtt: string;

  try {
    const response = await generateObject({
      model: clients.languageModel.model,
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
  }
  catch (error) {
    throw new Error(`Failed to translate VTT with ${resolvedProvider}: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  console.log(`\n✅ Translation completed successfully!`);

  // If uploadToMux is false, just return the translation
  if (!uploadToMux) {
    console.log(`✅ VTT translated to ${toLanguageCode} successfully!`);

    return {
      assetId,
      sourceLanguageCode: fromLanguageCode,
      targetLanguageCode: toLanguageCode,
      originalVtt: vttContent,
      translatedVtt,
    };
  }

  // Upload translated VTT to S3-compatible storage
  console.log("📤 Uploading translated VTT to S3-compatible storage...");

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
    console.log(`✅ VTT uploaded successfully to: ${vttKey}`);

    // Generate presigned URL (valid for 1 hour)
    const getObjectCommand = new GetObjectCommand({
      Bucket: s3Bucket!,
      Key: vttKey,
    });

    presignedUrl = await getSignedUrl(s3Client, getObjectCommand, {
      expiresIn: 3600, // 1 hour
    });

    console.log(`🔗 Generated presigned URL (expires in 1 hour)`);
  }
  catch (error) {
    throw new Error(`Failed to upload VTT to S3: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  // Add translated track to Mux asset
  console.log("📹 Adding translated track to Mux asset...");

  let uploadedTrackId: string | undefined;

  try {
    const languageName = new Intl.DisplayNames(["en"], { type: "language" }).of(toLanguageCode) || toLanguageCode.toUpperCase();
    const trackName = `${languageName} (auto-translated)`;

    const trackResponse = await clients.mux.video.assets.createTrack(assetId, {
      type: "text",
      text_type: "subtitles",
      language_code: toLanguageCode,
      name: trackName,
      url: presignedUrl,
    });

    uploadedTrackId = trackResponse.id;
    console.log(`✅ Track added to Mux asset with ID: ${uploadedTrackId}`);
    console.log(`📋 Track name: "${trackName}"`);
  }
  catch (error) {
    console.warn(`⚠️ Failed to add track to Mux asset: ${error instanceof Error ? error.message : "Unknown error"}`);
    console.log("🔗 You can manually add the track using this presigned URL:");
    console.log(presignedUrl);
  }

  return {
    assetId,
    sourceLanguageCode: fromLanguageCode,
    targetLanguageCode: toLanguageCode,
    originalVtt: vttContent,
    translatedVtt,
    uploadedTrackId,
    presignedUrl,
  };
}
