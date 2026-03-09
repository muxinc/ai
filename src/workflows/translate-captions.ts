import { generateText, Output } from "ai";
import dedent from "dedent";
import { z } from "zod";

import env from "@mux/ai/env";
import { getLanguageCodePair, getLanguageName } from "@mux/ai/lib/language-codes";
import type { LanguageCodePair, SupportedISO639_1 } from "@mux/ai/lib/language-codes";
import {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  isAudioOnlyAsset,
} from "@mux/ai/lib/mux-assets";
import { createLanguageModelFromConfig, resolveLanguageModelConfig } from "@mux/ai/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "@mux/ai/lib/providers";
import {
  createPresignedGetUrlWithStorageAdapter,
  putObjectWithStorageAdapter,
} from "@mux/ai/lib/storage-adapter";
import {
  resolveMuxClient,
  resolveMuxSigningContext,
} from "@mux/ai/lib/workflow-credentials";
import { buildTranscriptUrl, getReadyTextTracks, parseVTTCues } from "@mux/ai/primitives/transcripts";
import {
  buildVttFromCueBlocks,
  chunkVTTCuesByDuration,
  concatenateVttSegments,
  splitVttPreambleAndCueBlocks,
} from "@mux/ai/primitives/vtt-chunking";
import type {
  MuxAIOptions,
  StorageAdapter,
  TokenUsage,
  WorkflowCredentialsInput,
} from "@mux/ai/types";

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
  /** Optional storage adapter override for upload + presign operations. */
  storageAdapter?: StorageAdapter;
  /**
   * Optional VTT-aware chunking for long caption tracks.
   * Defaults to splitting assets longer than 30 minutes into ~30 minute chunks.
   */
  chunking?: TranslationChunkingOptions;
}

export interface TranslationChunkingOptions {
  /** Set to false to force a single translation request. Defaults to true. */
  enabled?: boolean;
  /** Start chunking only when the asset duration meets or exceeds this threshold. Defaults to 30 minutes. */
  minimumAssetDurationSeconds?: number;
  /** Preferred duration for each chunk. Defaults to 30 minutes. */
  targetChunkDurationSeconds?: number;
  /** Hard cap for a single chunk before forcing a split. Defaults to 35 minutes. */
  maxChunkDurationSeconds?: number;
  /** Soft lower bound used while searching for a natural boundary. Defaults to 20 minutes. */
  minChunkDurationSeconds?: number;
  /** How many cues beyond the target duration to inspect before splitting. Defaults to 12. */
  boundaryLookaheadCues?: number;
  /** Prefer chunk boundaries that have at least this much silence between cues. Defaults to 1.25 seconds. */
  boundaryPauseSeconds?: number;
  /** Max number of concurrent translation requests when chunking. Defaults to 4. */
  maxConcurrentTranslations?: number;
}

/** Schema used when requesting caption translation from a language model. */
export const translationSchema = z.object({
  translation: z.string(),
});

/** Inferred shape returned by `translationSchema`. */
export type TranslationPayload = z.infer<typeof translationSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = dedent`
  You are a subtitle translation expert. Translate VTT subtitle files to the target language specified by the user.
  You may receive either a full VTT file or a chunk from a larger VTT.
  Preserve all timestamps, cue ordering, and VTT formatting exactly as they appear.
  Return JSON with a single key "translation" containing the translated VTT content.
`;

const DEFAULT_TRANSLATION_CHUNKING: Required<TranslationChunkingOptions> = {
  enabled: true,
  minimumAssetDurationSeconds: 30 * 60,
  targetChunkDurationSeconds: 30 * 60,
  maxChunkDurationSeconds: 35 * 60,
  minChunkDurationSeconds: 20 * 60,
  boundaryLookaheadCues: 12,
  boundaryPauseSeconds: 1.25,
  maxConcurrentTranslations: 4,
};

interface TranslationChunkRequest {
  id: string;
  cueCount: number;
  startTime: number;
  endTime: number;
  vttContent: string;
}

function resolveTranslationChunkingOptions(
  options?: TranslationChunkingOptions,
): Required<TranslationChunkingOptions> {
  const targetChunkDurationSeconds = Math.max(
    1,
    options?.targetChunkDurationSeconds ?? DEFAULT_TRANSLATION_CHUNKING.targetChunkDurationSeconds,
  );
  const maxChunkDurationSeconds = Math.max(
    targetChunkDurationSeconds,
    options?.maxChunkDurationSeconds ?? DEFAULT_TRANSLATION_CHUNKING.maxChunkDurationSeconds,
  );
  const minChunkDurationSeconds = Math.min(
    targetChunkDurationSeconds,
    Math.max(
      1,
      options?.minChunkDurationSeconds ?? DEFAULT_TRANSLATION_CHUNKING.minChunkDurationSeconds,
    ),
  );

  return {
    enabled: options?.enabled ?? DEFAULT_TRANSLATION_CHUNKING.enabled,
    minimumAssetDurationSeconds: Math.max(
      1,
      options?.minimumAssetDurationSeconds ?? DEFAULT_TRANSLATION_CHUNKING.minimumAssetDurationSeconds,
    ),
    targetChunkDurationSeconds,
    maxChunkDurationSeconds,
    minChunkDurationSeconds,
    boundaryLookaheadCues: Math.max(
      1,
      options?.boundaryLookaheadCues ?? DEFAULT_TRANSLATION_CHUNKING.boundaryLookaheadCues,
    ),
    boundaryPauseSeconds: options?.boundaryPauseSeconds ?? DEFAULT_TRANSLATION_CHUNKING.boundaryPauseSeconds,
    maxConcurrentTranslations: Math.max(
      1,
      options?.maxConcurrentTranslations ?? DEFAULT_TRANSLATION_CHUNKING.maxConcurrentTranslations,
    ),
  };
}

function aggregateTokenUsage(usages: TokenUsage[]): TokenUsage {
  return usages.reduce<TokenUsage>(
    (aggregate, usage) => ({
      inputTokens: (aggregate.inputTokens ?? 0) + (usage.inputTokens ?? 0),
      outputTokens: (aggregate.outputTokens ?? 0) + (usage.outputTokens ?? 0),
      totalTokens: (aggregate.totalTokens ?? 0) + (usage.totalTokens ?? 0),
      reasoningTokens: (aggregate.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
      cachedInputTokens: (aggregate.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
    }),
    {},
  );
}

function buildTranslationChunkRequests(
  vttContent: string,
  assetDurationSeconds: number | undefined,
  chunkingOptions?: TranslationChunkingOptions,
): { preamble: string; chunks: TranslationChunkRequest[] } | null {
  const resolvedChunking = resolveTranslationChunkingOptions(chunkingOptions);
  if (
    !resolvedChunking.enabled ||
    typeof assetDurationSeconds !== "number" ||
    assetDurationSeconds < resolvedChunking.minimumAssetDurationSeconds
  ) {
    return null;
  }

  const cues = parseVTTCues(vttContent);
  if (cues.length === 0) {
    return null;
  }

  const { preamble, cueBlocks } = splitVttPreambleAndCueBlocks(vttContent);
  if (cueBlocks.length !== cues.length) {
    return null;
  }

  const durationChunks = chunkVTTCuesByDuration(cues, {
    targetChunkDurationSeconds: resolvedChunking.targetChunkDurationSeconds,
    maxChunkDurationSeconds: resolvedChunking.maxChunkDurationSeconds,
    minChunkDurationSeconds: resolvedChunking.minChunkDurationSeconds,
    boundaryLookaheadCues: resolvedChunking.boundaryLookaheadCues,
    boundaryPauseSeconds: resolvedChunking.boundaryPauseSeconds,
  });

  if (durationChunks.length <= 1) {
    return null;
  }

  return {
    preamble,
    chunks: durationChunks.map(chunk => ({
      id: chunk.id,
      cueCount: chunk.cueCount,
      startTime: chunk.startTime,
      endTime: chunk.endTime,
      vttContent: buildVttFromCueBlocks(
        cueBlocks.slice(chunk.cueStartIndex, chunk.cueEndIndex + 1),
      ),
    })),
  };
}

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
  chunkIndex,
  totalChunks,
}: {
  vttContent: string;
  fromLanguageCode: string;
  toLanguageCode: string;
  provider: SupportedProvider;
  modelId: string;
  credentials?: WorkflowCredentialsInput;
  chunkIndex?: number;
  totalChunks?: number;
}): Promise<{ translatedVtt: string; usage: TokenUsage }> {
  "use step";

  const model = await createLanguageModelFromConfig(provider, modelId, credentials);
  const segmentContext = typeof chunkIndex === "number" && typeof totalChunks === "number" ?
    `This VTT is segment ${chunkIndex + 1} of ${totalChunks} from a longer subtitle track. Translate only the provided segment and do not add or remove cues.\n\n` :
    "";

  const response = await generateText({
    model,
    output: Output.object({ schema: translationSchema }),
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: `${segmentContext}Translate from ${fromLanguageCode} to ${toLanguageCode}:\n\n${vttContent}`,
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

async function translateCaptionTrack({
  vttContent,
  assetDurationSeconds,
  fromLanguageCode,
  toLanguageCode,
  provider,
  modelId,
  credentials,
  chunking,
}: {
  vttContent: string;
  assetDurationSeconds?: number;
  fromLanguageCode: string;
  toLanguageCode: string;
  provider: SupportedProvider;
  modelId: string;
  credentials?: WorkflowCredentialsInput;
  chunking?: TranslationChunkingOptions;
}): Promise<{ translatedVtt: string; usage: TokenUsage }> {
  "use step";

  const chunkPlan = buildTranslationChunkRequests(vttContent, assetDurationSeconds, chunking);
  if (!chunkPlan) {
    return translateVttWithAI({
      vttContent,
      fromLanguageCode,
      toLanguageCode,
      provider,
      modelId,
      credentials,
    });
  }

  const resolvedChunking = resolveTranslationChunkingOptions(chunking);
  const translatedSegments: string[] = [];
  const usageByChunk: TokenUsage[] = [];

  for (let index = 0; index < chunkPlan.chunks.length; index += resolvedChunking.maxConcurrentTranslations) {
    const batch = chunkPlan.chunks.slice(index, index + resolvedChunking.maxConcurrentTranslations);
    const batchResults = await Promise.all(
      batch.map((chunk, batchIndex) =>
        translateVttWithAI({
          vttContent: chunk.vttContent,
          fromLanguageCode,
          toLanguageCode,
          provider,
          modelId,
          credentials,
          chunkIndex: index + batchIndex,
          totalChunks: chunkPlan.chunks.length,
        }).then((result) => {
          const translatedCueCount = splitVttPreambleAndCueBlocks(result.translatedVtt).cueBlocks.length;
          if (translatedCueCount !== chunk.cueCount) {
            throw new Error(
              `Chunk ${chunk.id} returned ${translatedCueCount} cues, expected ${chunk.cueCount} for ${Math.round(chunk.startTime)}s-${Math.round(chunk.endTime)}s`,
            );
          }

          return result;
        }),
      ),
    );

    translatedSegments.push(...batchResults.map(result => result.translatedVtt));
    usageByChunk.push(...batchResults.map(result => result.usage));
  }

  return {
    translatedVtt: concatenateVttSegments(translatedSegments, chunkPlan.preamble),
    usage: aggregateTokenUsage(usageByChunk),
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
  storageAdapter,
}: {
  translatedVtt: string;
  assetId: string;
  fromLanguageCode: string;
  toLanguageCode: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  storageAdapter?: StorageAdapter;
}): Promise<string> {
  "use step";

  const s3AccessKeyId = env.S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = env.S3_SECRET_ACCESS_KEY;

  // Create unique key for the VTT file
  const vttKey = `translations/${assetId}/${fromLanguageCode}-to-${toLanguageCode}-${Date.now()}.vtt`;

  await putObjectWithStorageAdapter({
    accessKeyId: s3AccessKeyId,
    secretAccessKey: s3SecretAccessKey,
    endpoint: s3Endpoint,
    region: s3Region,
    bucket: s3Bucket,
    key: vttKey,
    body: translatedVtt,
    contentType: "text/vtt",
  }, storageAdapter);

  return createPresignedGetUrlWithStorageAdapter({
    accessKeyId: s3AccessKeyId,
    secretAccessKey: s3SecretAccessKey,
    endpoint: s3Endpoint,
    region: s3Region,
    bucket: s3Bucket,
    key: vttKey,
    expiresInSeconds: 3600,
  }, storageAdapter);
}

async function createTextTrackOnMux(
  assetId: string,
  languageCode: string,
  trackName: string,
  presignedUrl: string,
  credentials?: WorkflowCredentialsInput,
): Promise<string> {
  "use step";
  const muxClient = await resolveMuxClient(credentials);
  const mux = await muxClient.createClient();
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
    storageAdapter,
    credentials: providedCredentials,
    chunking,
  } = options;
  const credentials = providedCredentials;
  const effectiveStorageAdapter = storageAdapter;

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

  if (uploadToMux && (!s3Endpoint || !s3Bucket || (!effectiveStorageAdapter && (!s3AccessKeyId || !s3SecretAccessKey)))) {
    throw new Error("Storage configuration is required for uploading to Mux. Provide s3Endpoint and s3Bucket. If no storageAdapter is supplied, also provide s3AccessKeyId and s3SecretAccessKey in options or set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY environment variables.");
  }

  // Fetch asset data and playback ID from Mux
  const { asset: assetData, playbackId, policy } = await getPlaybackIdForAsset(assetId, credentials);
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
    const result = await translateCaptionTrack({
      vttContent,
      assetDurationSeconds,
      fromLanguageCode,
      toLanguageCode,
      provider: modelConfig.provider,
      modelId: modelConfig.modelId,
      credentials,
      chunking,
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
      storageAdapter: effectiveStorageAdapter,
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
