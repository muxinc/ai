import { embed } from "ai";

import {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  isAudioOnlyAsset,
} from "@mux/ai/lib/mux-assets";
import type { EmbeddingModelIdByProvider, SupportedEmbeddingProvider } from "@mux/ai/lib/providers";
import { createEmbeddingModelFromConfig, resolveEmbeddingModelConfig } from "@mux/ai/lib/providers";
import { withRetry } from "@mux/ai/lib/retry";
import { resolveMuxSigningContext } from "@mux/ai/lib/workflow-credentials";
import { chunkText, chunkVTTCues } from "@mux/ai/primitives/text-chunking";
import { fetchTranscriptForAsset, getReadyTextTracks, parseVTTCues } from "@mux/ai/primitives/transcripts";
import type {
  ChunkEmbedding,
  ChunkingStrategy,
  MuxAIOptions,
  TextChunk,
  VideoEmbeddingsResult,
  WorkflowCredentialsInput,
} from "@mux/ai/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration accepted by `generateEmbeddings`. */
export interface EmbeddingsOptions extends MuxAIOptions {
  /** AI provider used to generate embeddings (defaults to 'openai'). */
  provider?: SupportedEmbeddingProvider;
  /** Provider-specific model identifier (defaults to text-embedding-3-small for OpenAI). */
  model?: EmbeddingModelIdByProvider[SupportedEmbeddingProvider];
  /** Language code for transcript selection (defaults to first available). */
  languageCode?: string;
  /** Chunking strategy configuration (defaults to token-based with 500 tokens, 100 overlap). */
  chunkingStrategy?: ChunkingStrategy;
  /** Maximum number of chunks to process concurrently (defaults to 5). */
  batchSize?: number;
}

/** Alias for embedding results (supports video or audio transcripts). */
export type EmbeddingsResult = VideoEmbeddingsResult;

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Averages multiple embedding vectors into a single vector.
 *
 * @param embeddings - Array of embedding vectors to average
 * @returns Single averaged embedding vector
 */
function averageEmbeddings(embeddings: number[][]): number[] {
  if (embeddings.length === 0) {
    return [];
  }

  const dimensions = embeddings[0].length;
  const averaged = Array.from({ length: dimensions }, () => 0);

  for (const embedding of embeddings) {
    for (let i = 0; i < dimensions; i++) {
      averaged[i] += embedding[i];
    }
  }

  for (let i = 0; i < dimensions; i++) {
    averaged[i] /= embeddings.length;
  }

  return averaged;
}

/**
 * Generates embedding for a single text chunk using the specified AI provider.
 *
 * @param options - Configuration object
 * @param options.chunk - Text chunk to embed
 * @param options.provider - AI provider for embedding generation
 * @param options.modelId - Provider-specific model identifier
 * @param options.credentials - Optional workflow credentials for API access
 * @returns Chunk embedding with metadata
 */
async function generateSingleChunkEmbedding({
  chunk,
  provider,
  modelId,
  credentials,
}: {
  chunk: TextChunk;
  provider: SupportedEmbeddingProvider;
  modelId: string;
  credentials?: WorkflowCredentialsInput;
}): Promise<ChunkEmbedding> {
  "use step";

  const model = await createEmbeddingModelFromConfig(provider, modelId, credentials);
  const response = await withRetry(() =>
    embed({
      model,
      value: chunk.text,
    }),
  );

  return {
    chunkId: chunk.id,
    embedding: response.embedding,
    metadata: {
      startTime: chunk.startTime,
      endTime: chunk.endTime,
      tokenCount: chunk.tokenCount,
    },
  };
}

/**
 * Generates vector embeddings for a media asset's transcript.
 *
 * This function:
 * 1. Fetches the transcript from Mux
 * 2. Chunks the transcript according to the specified strategy
 * 3. Generates embeddings for each chunk using the specified AI provider
 * 4. Returns both individual chunk embeddings and an averaged embedding
 *
 * @param assetId - Mux asset ID
 * @param options - Configuration options
 * @returns Embeddings result with chunks and averaged embedding
 *
 * @example
 * ```typescript
 * const embeddings = await generateEmbeddings("asset-id", {
 *   provider: "openai",
 *   chunkingStrategy: { type: "token", maxTokens: 500, overlap: 100 },
 * });
 *
 * // Store in vector database
 * for (const chunk of embeddings.chunks) {
 *   await db.insert({
 *     assetId: embeddings.assetId,
 *     chunkId: chunk.chunkId,
 *     embedding: chunk.embedding,
 *     metadata: chunk.metadata,
 *   });
 * }
 * ```
 */
async function generateEmbeddingsInternal(
  assetId: string,
  options: EmbeddingsOptions = {},
): Promise<EmbeddingsResult> {
  const {
    provider = "openai",
    model,
    languageCode,
    chunkingStrategy = { type: "token", maxTokens: 500, overlap: 100 } as ChunkingStrategy,
    batchSize = 5,
    credentials,
  } = options;

  const embeddingModel = resolveEmbeddingModelConfig({ ...options, provider, model });
  // Fetch asset and playback ID
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

  // Fetch transcript (raw VTT for VTT strategy, cleaned text otherwise)
  const readyTextTracks = getReadyTextTracks(assetData);
  const useVttChunking = chunkingStrategy.type === "vtt";
  let transcriptResult = await fetchTranscriptForAsset(assetData, playbackId, {
    languageCode,
    cleanTranscript: !useVttChunking,
    shouldSign: policy === "signed",
    credentials,
  });

  if (isAudioOnly && !transcriptResult.track && readyTextTracks.length === 1) {
    transcriptResult = await fetchTranscriptForAsset(assetData, playbackId, {
      cleanTranscript: !useVttChunking,
      shouldSign: policy === "signed",
      credentials,
    });
  }

  if (!transcriptResult.track || !transcriptResult.transcriptText) {
    const availableLanguages = readyTextTracks
      .map(t => t.language_code)
      .filter(Boolean)
      .join(", ");
    if (isAudioOnly) {
      throw new Error(
        `No transcript track found${languageCode ? ` for language '${languageCode}'` : ""}. ` +
        `Audio-only assets require a transcript. Available languages: ${availableLanguages || "none"}`,
      );
    }
    throw new Error(
      `No caption track found${languageCode ? ` for language '${languageCode}'` : ""}. Available languages: ${availableLanguages || "none"}`,
    );
  }

  const transcriptText = transcriptResult.transcriptText;
  if (!transcriptText.trim()) {
    throw new Error("Transcript is empty");
  }

  // Chunk the transcript
  const chunks = useVttChunking ?
      chunkVTTCues(
        parseVTTCues(transcriptText),
        chunkingStrategy.maxTokens,
        chunkingStrategy.overlapCues,
      ) :
      chunkText(transcriptText, chunkingStrategy);
  if (chunks.length === 0) {
    throw new Error("No chunks generated from transcript");
  }

  // Generate embeddings for all chunks (process in batches)
  const chunkEmbeddings: ChunkEmbedding[] = [];
  try {
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(chunk =>
          generateSingleChunkEmbedding({
            chunk,
            provider: embeddingModel.provider,
            modelId: embeddingModel.modelId as string,
            credentials,
          }),
        ),
      );

      chunkEmbeddings.push(...batchResults);
    }
  } catch (error) {
    throw new Error(
      `Failed to generate embeddings with ${provider}: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  if (chunkEmbeddings.length === 0) {
    throw new Error("No embeddings generated");
  }

  // Calculate averaged embedding
  const averagedEmbedding = averageEmbeddings(chunkEmbeddings.map(ce => ce.embedding));

  // Calculate total tokens
  const totalTokens = chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0);

  return {
    assetId,
    chunks: chunkEmbeddings,
    averagedEmbedding,
    provider,
    model: embeddingModel.modelId,
    metadata: {
      totalChunks: chunks.length,
      totalTokens,
      chunkingStrategy: JSON.stringify(chunkingStrategy),
      embeddingDimensions: chunkEmbeddings[0].embedding.length,
      generatedAt: new Date().toISOString(),
    },
    usage: {
      metadata: {
        assetDurationSeconds,
      },
    },
  };
}

export async function generateEmbeddings(
  assetId: string,
  options: EmbeddingsOptions = {},
): Promise<EmbeddingsResult> {
  "use workflow";
  return generateEmbeddingsInternal(assetId, options);
}

/**
 * @deprecated Use {@link generateEmbeddings} instead. This name will be removed in a future release.
 */
export async function generateVideoEmbeddings(
  assetId: string,
  options: EmbeddingsOptions = {},
): Promise<EmbeddingsResult> {
  "use workflow";
  console.warn("generateVideoEmbeddings is deprecated. Use generateEmbeddings instead.");
  return generateEmbeddingsInternal(assetId, options);
}
