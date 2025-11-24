import Mux from '@mux/mux-node';
import { z } from 'zod';
import { ImageDownloadOptions } from './lib/image-download';
import { SupportedProvider, ModelIdByProvider } from './lib/providers';

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
  /** Google Generative AI API key (defaults to GOOGLE_GENERATIVE_AI_API_KEY/GOOGLE_API_KEY). */
  googleApiKey?: string;
  /** Hive Visual Moderation API key (defaults to process.env.HIVE_API_KEY). */
  hiveApiKey?: string;
  /**
   * Reserved for future hosted deployments that may require overriding the API
   * base URL.
   */
  baseUrl?: string;
}

/**
 * Base options mixed into every higher-level workflow configuration.
 */
export interface MuxAIOptions extends MuxAIConfig {
  /** Optional timeout (ms) for helper utilities that support request limits. */
  timeout?: number;
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

// Shared schemas and inferred types for AI interactions
export const summarySchema = z.object({
  keywords: z.array(z.string()).max(10),
  title: z.string().max(100),
  description: z.string().max(1000),
});

export type SummaryType = z.infer<typeof summarySchema>;

/** Structured return payload for `getSummaryAndTags`. */
export interface SummaryAndTagsResult {
  /** Asset ID passed into the workflow. */
  assetId: string;
  /** Short headline generated from the storyboard. */
  title: string;
  /** Longer description of the detected content. */
  description: string;
  /** Up to 10 keywords extracted by the model. */
  tags: string[];
  /** Storyboard image URL that was analyzed. */
  storyboardUrl: string;
}

/** Configuration accepted by `getSummaryAndTags`. */
export interface SummarizationOptions extends MuxAIOptions {
  /** AI provider to run (defaults to 'openai'). */
  provider?: SupportedProvider;
  /** Provider-specific chat model identifier. */
  model?: ModelIdByProvider[SupportedProvider];
  /** Prompt tone shim applied to the system instruction (defaults to 'normal'). */
  tone?: ToneType;
  /** Fetch the transcript and send it alongside the storyboard (defaults to true). */
  includeTranscript?: boolean;
  /** Strip timestamps/markup from transcripts before including them (defaults to true). */
  cleanTranscript?: boolean;
  /** How storyboard frames should be delivered to the provider (defaults to 'url'). */
  imageSubmissionMode?: ImageSubmissionMode;
  /** Fine-tune storyboard downloads when `imageSubmissionMode` === 'base64'. */
  imageDownloadOptions?: ImageDownloadOptions;
}

export const chapterSchema = z.object({
  startTime: z.number(),
  title: z.string(),
});

export type Chapter = z.infer<typeof chapterSchema>;

export const chaptersSchema = z.object({
  chapters: z.array(chapterSchema),
});

export type ChaptersType = z.infer<typeof chaptersSchema>;

/** Structured return payload from `generateChapters`. */
export interface ChaptersResult {
  assetId: string;
  languageCode: string;
  chapters: Chapter[];
}

/** Configuration accepted by `generateChapters`. */
export interface ChaptersOptions extends MuxAIOptions {
  /** AI provider used to interpret the transcript (defaults to 'openai'). */
  provider?: SupportedProvider;
  /** Provider-specific model identifier. */
  model?: ModelIdByProvider[SupportedProvider];
}

/** Per-thumbnail moderation result returned from `getModerationScores`. */
export interface ThumbnailModerationScore {
  url: string;
  sexual: number;
  violence: number;
  error: boolean;
}

/** Aggregated moderation payload returned from `getModerationScores`. */
export interface ModerationResult {
  assetId: string;
  thumbnailScores: ThumbnailModerationScore[];
  maxScores: {
    sexual: number;
    violence: number;
  };
  exceedsThreshold: boolean;
  thresholds: {
    sexual: number;
    violence: number;
  };
}

/** Provider list accepted by `getModerationScores`. */
export type ModerationProvider = SupportedProvider | 'hive';

export type HiveModerationSource =
  | { kind: 'url'; value: string }
  | { kind: 'file'; buffer: Buffer; contentType: string };

export interface HiveModerationOutput {
  classes?: Array<{
    class: string;
    score: number;
  }>;
}

/** Configuration accepted by `getModerationScores`. */
export interface ModerationOptions extends MuxAIOptions {
  /** Provider used for moderation (defaults to 'openai'). */
  provider?: ModerationProvider;
  /** Provider-specific model identifier (defaults to opinionated value per provider). */
  model?: ModelIdByProvider[SupportedProvider];
  /** Override the default sexual/violence thresholds (0-1). */
  thresholds?: {
    sexual?: number;
    violence?: number;
  };
  /** Interval between storyboard thumbnails in seconds (defaults to 10). */
  thumbnailInterval?: number;
  /** Width of storyboard thumbnails in pixels (defaults to 640). */
  thumbnailWidth?: number;
  /** Max concurrent moderation requests (defaults to 5). */
  maxConcurrent?: number;
  /** Transport used for thumbnails (defaults to 'url'). */
  imageSubmissionMode?: ImageSubmissionMode;
  /** Download tuning used when `imageSubmissionMode` === 'base64'. */
  imageDownloadOptions?: ImageDownloadOptions;
}

/** Structured payload returned from `hasBurnedInCaptions`. */
export interface BurnedInCaptionsResult {
  assetId: string;
  hasBurnedInCaptions: boolean;
  confidence: number;
  detectedLanguage: string | null;
  storyboardUrl: string;
}

/** Configuration accepted by `hasBurnedInCaptions`. */
export interface BurnedInCaptionsOptions extends MuxAIOptions {
  /** AI provider used for storyboard inspection (defaults to 'openai'). */
  provider?: SupportedProvider;
  /** Provider-specific model identifier. */
  model?: ModelIdByProvider[SupportedProvider];
  /** Transport used for storyboard submission (defaults to 'url'). */
  imageSubmissionMode?: ImageSubmissionMode;
  /** Download tuning used when `imageSubmissionMode` === 'base64'. */
  imageDownloadOptions?: ImageDownloadOptions;
}

/** Schema used to validate burned-in captions analysis responses. */
export const burnedInCaptionsSchema = z.object({
  hasBurnedInCaptions: z.boolean(),
  confidence: z.number().min(0).max(1),
  detectedLanguage: z.string().nullable(),
});

/** Inferred shape returned from the burned-in captions schema. */
export type BurnedInCaptionsAnalysis = z.infer<typeof burnedInCaptionsSchema>;

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
  /** S3 region (defaults to process.env.S3_REGION or 'auto'). */
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

/** Output returned from `translateAudio`. */
export interface AudioTranslationResult {
  assetId: string;
  targetLanguageCode: string;
  dubbingId: string;
  uploadedTrackId?: string;
  presignedUrl?: string;
}

/** Configuration accepted by `translateAudio`. */
export interface AudioTranslationOptions extends MuxAIOptions {
  /** Audio dubbing provider (currently ElevenLabs only). */
  provider?: 'elevenlabs';
  /** Number of speakers supplied to ElevenLabs (0 = auto-detect, default). */
  numSpeakers?: number;
  /** Optional override for the S3-compatible endpoint used for uploads. */
  s3Endpoint?: string;
  /** S3 region (defaults to process.env.S3_REGION or 'auto'). */
  s3Region?: string;
  /** Bucket that will store dubbed audio files. */
  s3Bucket?: string;
  /** Access key ID used for uploads. */
  s3AccessKeyId?: string;
  /** Secret access key used for uploads. */
  s3SecretAccessKey?: string;
  /**
   * When true (default) the dubbed audio file is uploaded to the configured
   * bucket and attached to the Mux asset.
   */
  uploadToMux?: boolean;
  /** Override for process.env.ELEVENLABS_API_KEY. */
  elevenLabsApiKey?: string;
}
