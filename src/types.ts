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
