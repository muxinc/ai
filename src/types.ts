import type { Encrypted } from "@mux/ai/lib/workflow-crypto";

import type Mux from "@mux/mux-node";

/** Input shape for uploading objects through a storage adapter. */
export interface StoragePutObjectInput {
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
  body: string | Uint8Array;
  contentType?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** Input shape for presigning object download URLs through a storage adapter. */
export interface StoragePresignGetObjectInput {
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
  expiresInSeconds: number;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** Optional pluggable storage backend for S3-compatible object operations. */
export interface StorageAdapter {
  putObject: (input: StoragePutObjectInput) => Promise<void>;
  createPresignedGetUrl: (input: StoragePresignGetObjectInput) => Promise<string>;
}

export interface WorkflowMuxClient {
  createClient: () => Promise<Mux>;
  getSigningKey: () => string | undefined;
  getPrivateKey: () => string | undefined;
}

/**
 * Base options mixed into every higher-level workflow configuration.
 */
export interface MuxAIOptions {
  /** Optional timeout (ms) for helper utilities that support request limits. */
  timeout?: number;
  /**
   * Optional credentials for workflow execution.
   * Use encryptForWorkflow when running in Workflow Dev Kit environments.
   */
  credentials?: WorkflowCredentialsInput;
  /** Optional storage adapter for upload and presigning operations. */
  storageAdapter?: StorageAdapter;
}

/**
 * Workflow credentials.
 *
 * Supports plain credential objects and primitive credential fields for
 * per-request multi-tenant workflows.
 */
export interface WorkflowCredentials {
  /** Direct Mux API token ID for per-request credential injection. */
  muxTokenId?: string;
  /** Direct Mux API token secret for per-request credential injection. */
  muxTokenSecret?: string;
  /** Optional direct Mux signing key ID for signed playback URL generation. */
  muxSigningKey?: string;
  /** Optional direct Mux private key for signed playback URL generation. */
  muxPrivateKey?: string;
  /** Optional direct OpenAI API key for per-request credential injection. */
  openaiApiKey?: string;
  /** Optional direct Anthropic API key for per-request credential injection. */
  anthropicApiKey?: string;
  /** Optional direct Google API key for per-request credential injection. */
  googleApiKey?: string;
  /** Optional direct Hive API key for per-request credential injection. */
  hiveApiKey?: string;
  /** Optional direct ElevenLabs API key for per-request credential injection. */
  elevenLabsApiKey?: string;
}

/** Credentials that are safe to serialize across workflow boundaries. */
export type WorkflowCredentialsInput = WorkflowCredentials | Encrypted<WorkflowCredentials>;

/** Tone controls for the summarization helper. */
export type ToneType = "neutral" | "playful" | "professional";

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
  /** Workflow usage metadata (asset duration, thumbnails, etc.). */
  usage?: TokenUsage;
}
// ─────────────────────────────────────────────────────────────────────────────
// AI SDK Usage Metrics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metadata attached to usage objects for workflow context.
 */
export interface UsageMetadata {
  /** Total asset duration in seconds. */
  assetDurationSeconds?: number;
  /** Number of thumbnails sampled for workflows that use thumbnails. */
  thumbnailCount?: number;
}

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
  /** Workflow metadata (asset duration, thumbnails, etc.). */
  metadata?: UsageMetadata;
}
