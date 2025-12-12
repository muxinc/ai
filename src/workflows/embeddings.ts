import { embed } from "ai";

import { createMuxClient, validateCredentials } from "../lib/client-factory";
import { getPlaybackIdForAsset } from "../lib/mux-assets";
import type { EmbeddingModelIdByProvider, SupportedEmbeddingProvider } from "../lib/providers";
import { resolveEmbeddingModel } from "../lib/providers";
import { withRetry } from "../lib/retry";
import { resolveSigningContext } from "../lib/url-signing";
import { chunkText, chunkVTTCues } from "../primitives/text-chunking";
import { fetchTranscriptForAsset, getReadyTextTracks, parseVTTCues } from "../primitives/transcripts";
import type {
  ChunkEmbedding,
  ChunkingStrategy,
  MuxAIOptions,
  TextChunk,
  VideoEmbeddingsResult,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration accepted by `generateVideoEmbeddings`. */
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

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PROVIDER = "openai";
const DEFAULT_CHUNKING_STRATEGY: ChunkingStrategy = {
  type: "token",
  maxTokens: 500,
  overlap: 100,
};
const DEFAULT_BATCH_SIZE = 5;

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
 * Generates embeddings for chunks of a video transcript in batches.
 *
 * @param chunks - Text chunks to embed
 * @param model - AI model to use for embedding generation
 * @param batchSize - Number of chunks to process concurrently
 * @param abortSignal - Optional abort signal
 * @returns Array of chunk embeddings
 */
async function generateChunkEmbeddings(
  chunks: TextChunk[],
  model: any,
  batchSize: number,
  abortSignal?: AbortSignal,
): Promise<ChunkEmbedding[]> {
  const results: ChunkEmbedding[] = [];

  // Process chunks in batches
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (chunk) => {
        const response = await withRetry(() =>
          embed({
            model,
            value: chunk.text,
            abortSignal,
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
      }),
    );

    results.push(...batchResults);
  }

  return results;
}

/**
 * Generates vector embeddings for a video asset's transcript.
 *
 * This function:
 * 1. Fetches the video transcript from Mux
 * 2. Chunks the transcript according to the specified strategy
 * 3. Generates embeddings for each chunk using the specified AI provider
 * 4. Returns both individual chunk embeddings and an averaged embedding
 *
 * @param assetId - Mux asset ID
 * @param options - Configuration options
 * @returns Video embeddings result with chunks and averaged embedding
 *
 * @example
 * ```typescript
 * const embeddings = await generateVideoEmbeddings("asset-id", {
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
export async function generateVideoEmbeddings(
  assetId: string,
  options: EmbeddingsOptions = {},
): Promise<VideoEmbeddingsResult> {
  const {
    provider = DEFAULT_PROVIDER,
    model,
    languageCode,
    chunkingStrategy = DEFAULT_CHUNKING_STRATEGY,
    batchSize = DEFAULT_BATCH_SIZE,
    abortSignal,
  } = options;

  // Validate credentials and initialize Mux client
  const credentials = validateCredentials(options, provider === "google" ? "google" : "openai");
  const muxClient = createMuxClient(credentials);
  const embeddingModel = resolveEmbeddingModel({ ...options, provider, model });

  // Fetch asset and playback ID
  const { asset: assetData, playbackId, policy } = await getPlaybackIdForAsset(
    muxClient,
    assetId,
  );

  // Resolve signing context for signed playback IDs
  const signingContext = resolveSigningContext(options);
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. " +
      "Provide muxSigningKey and muxPrivateKey in options or set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  // Fetch transcript (raw VTT for VTT strategy, cleaned text otherwise)
  const useVttChunking = chunkingStrategy.type === "vtt";
  const transcriptResult = await fetchTranscriptForAsset(assetData, playbackId, {
    languageCode,
    cleanTranscript: !useVttChunking,
    signingContext: policy === "signed" ? signingContext : undefined,
  });

  if (!transcriptResult.track || !transcriptResult.transcriptText) {
    const availableLanguages = getReadyTextTracks(assetData)
      .map(t => t.language_code)
      .filter(Boolean)
      .join(", ");
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

  // Generate embeddings for all chunks
  let chunkEmbeddings: ChunkEmbedding[];
  try {
    chunkEmbeddings = await generateChunkEmbeddings(
      chunks,
      embeddingModel.model,
      batchSize,
      abortSignal,
    );
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
  };
}
