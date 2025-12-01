import type Mux from "@mux/mux-node";

/**
 * Shared credential bag for every workflow. Each property falls back to the
 * corresponding environment variable when omitted.
 */
export interface MuxAIConfig {
  /** Override for the MUX_TOKEN_ID environment variable. */
  muxTokenId?: string;
  /** Override for the MUX_TOKEN_SECRET environment variable. */
  muxTokenSecret?: string;
  /** Mux signing key ID for signed playback IDs (defaults to the MUX_SIGNING_KEY environment variable). */
  muxSigningKey?: string;
  /** Mux signing key private key for signed playback IDs (defaults to the MUX_PRIVATE_KEY environment variable). */
  muxPrivateKey?: string;
  /** OpenAI API key (defaults to the OPENAI_API_KEY environment variable). */
  openaiApiKey?: string;
  /** Anthropic API key (defaults to the ANTHROPIC_API_KEY environment variable). */
  anthropicApiKey?: string;
  /** Google Generative AI API key (defaults to the GOOGLE_GENERATIVE_AI_API_KEY environment variable). */
  googleApiKey?: string;
  /** Hive Visual Moderation API key (defaults to the HIVE_API_KEY environment variable). */
  hiveApiKey?: string;
}

/**
 * Base options mixed into every higher-level workflow configuration.
 */
export interface MuxAIOptions extends MuxAIConfig {
  /** Optional timeout (ms) for helper utilities that support request limits. */
  timeout?: number;
  /**
   * Optional cancellation signal passed through to underlying AI SDK calls.
   * When aborted, in-flight model requests will be
   * cancelled where supported.
   */
  abortSignal?: AbortSignal;
}

/** Tone controls for the summarization helper. */
export type ToneType = "normal" | "sassy" | "professional";

/** Common transport for image-based workflows. */
export type ImageSubmissionMode = "url" | "base64";

/** Result of calling mux-node's asset retrieval helper. */
export type MuxAsset = Awaited<ReturnType<Mux["video"]["assets"]["retrieve"]>>;
/** Single ready track extracted from a Mux asset. */
export type AssetTextTrack = NonNullable<MuxAsset["tracks"]>[number];

/** Playback policy type for Mux assets. */
export type PlaybackPolicy = "public" | "signed";

/** Convenience bundle returned by `getPlaybackIdForAsset`. */
export interface PlaybackAsset {
  asset: MuxAsset;
  playbackId: string;
  /** The policy type of the playback ID ('public' or 'signed'). */
  policy: PlaybackPolicy;
}

/** Configuration for token-based chunking. */
export interface TokenChunkingConfig {
  type: "token";
  /** Maximum tokens per chunk. */
  maxTokens: number;
  /** Number of overlapping tokens between chunks. */
  overlap?: number;
}

/** Configuration for VTT-aware chunking that respects cue boundaries. */
export interface VTTChunkingConfig {
  type: "vtt";
  /** Maximum tokens per chunk. */
  maxTokens: number;
  /** Number of cues to overlap between chunks (default: 2). */
  overlapCues?: number;
}

/** Union type for all chunking strategy configurations. */
export type ChunkingStrategy = TokenChunkingConfig | VTTChunkingConfig;

/** A single chunk of text extracted from a transcript. */
export interface TextChunk {
  /** Unique identifier for this chunk. */
  id: string;
  /** The text content of the chunk. */
  text: string;
  /** Number of tokens in this chunk. */
  tokenCount: number;
  /** Start time in seconds (if available from timestamped transcript). */
  startTime?: number;
  /** End time in seconds (if available from timestamped transcript). */
  endTime?: number;
}

/** A chunk with its embedding vector. */
export interface ChunkEmbedding {
  /** Reference to the chunk ID. */
  chunkId: string;
  /** The embedding vector. */
  embedding: number[];
  /** Optional metadata for this chunk. */
  metadata: {
    startTime?: number;
    endTime?: number;
    tokenCount: number;
  };
}

/** Result of generating embeddings for a video asset. */
export interface VideoEmbeddingsResult {
  /** The Mux asset ID. */
  assetId: string;
  /** Individual chunk embeddings. */
  chunks: ChunkEmbedding[];
  /** Averaged embedding across all chunks. */
  averagedEmbedding: number[];
  /** AI provider used. */
  provider: string;
  /** Model used for embedding generation. */
  model: string;
  /** Additional metadata about the generation. */
  metadata: {
    totalChunks: number;
    totalTokens: number;
    chunkingStrategy: string;
    embeddingDimensions: number;
    generatedAt: string;
  };
}
// ─────────────────────────────────────────────────────────────────────────────
// AI SDK Usage Metrics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Token usage breakdown returned by AI SDK providers.
 * Used for efficiency and cost analysis.
 */
export interface TokenUsage {
  /** Number of tokens in the input prompt (text + image). */
  inputTokens?: number;
  /** Number of tokens generated in the output. */
  outputTokens?: number;
  /** Total tokens consumed (input + output). */
  totalTokens?: number;
  /** Tokens used for chain-of-thought reasoning (if applicable). */
  reasoningTokens?: number;
  /** Input tokens served from cache (reduces cost). */
  cachedInputTokens?: number;
}
