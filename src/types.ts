import Mux from '@mux/mux-node';

/**
 * Shared credential bag for every workflow. Each property falls back to the
 * corresponding environment variable when omitted.
 */
export interface MuxAIConfig {
  /** Override for process.env.MUX_TOKEN_ID. */
  muxTokenId?: string;
  /** Override for process.env.MUX_TOKEN_SECRET. */
  muxTokenSecret?: string;
  /** OpenAI API key (defaults to process.env.OPENAI_API_KEY). */
  openaiApiKey?: string;
  /** Anthropic API key (defaults to process.env.ANTHROPIC_API_KEY). */
  anthropicApiKey?: string;
  /** Google Generative AI API key (defaults to process.env.GOOGLE_GENERATIVE_AI_API_KEY). */
  googleApiKey?: string;
  /** Hive Visual Moderation API key (defaults to process.env.HIVE_API_KEY). */
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
export type ToneType = 'normal' | 'sassy' | 'professional';

/** Common transport for image-based workflows. */
export type ImageSubmissionMode = 'url' | 'base64';

/** Result of calling mux-node's asset retrieval helper. */
export type MuxAsset = Awaited<ReturnType<Mux['video']['assets']['retrieve']>>;
/** Single ready track extracted from a Mux asset. */
export type AssetTextTrack = NonNullable<MuxAsset['tracks']>[number];

/** Convenience bundle returned by `fetchPlaybackAsset`. */
export interface PlaybackAsset {
  asset: MuxAsset;
  playbackId: string;
}
