import { generateText, Output } from "ai";
import dedent from "dedent";
import { z } from "zod";

import env from "@mux/ai/env";
import { MuxAiError, wrapError } from "@mux/ai/lib/mux-ai-error";
import {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
} from "@mux/ai/lib/mux-assets";
import { createTextTrackOnMux, fetchVttFromMux } from "@mux/ai/lib/mux-tracks";
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
import { buildTranscriptUrl, extractTextFromVTT, getReadyTextTracks, vttTimestampToSeconds } from "@mux/ai/primitives/transcripts";
import type {
  MuxAIOptions,
  StorageAdapter,
  TokenUsage,
  WorkflowCredentialsInput,
} from "@mux/ai/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Replacement strategy for censored words. */
export type CensorMode = "blank" | "remove" | "mask";

export interface AutoCensorProfanityOptions {
  mode?: CensorMode;
  alwaysCensor?: string[];
  neverCensor?: string[];
}

export interface CaptionReplacement {
  find: string;
  replace: string;
}

export interface ReplacementRecord {
  cueStartTime: number;
  before: string;
  after: string;
}

/** Configuration accepted by `editCaptions`. */
export interface EditCaptionsOptions<P extends SupportedProvider = SupportedProvider> extends MuxAIOptions {
  /** Provider responsible for profanity detection. Required when autoCensorProfanity is set. */
  provider?: P;
  /** Provider-specific chat model identifier. */
  model?: ModelIdByProvider[P];
  /** LLM-powered profanity censorship. */
  autoCensorProfanity?: AutoCensorProfanityOptions;
  /** Static find/replace pairs (no LLM needed). */
  replacements?: CaptionReplacement[];
  /** Delete the original track after creating the edited one. Defaults to true. */
  deleteOriginalTrack?: boolean;
  /**
   * When `true` the edited VTT is uploaded to the configured
   * S3-compatible bucket and a `presignedUrl` is returned.
   * Defaults to the value of `uploadToMux` when omitted.
   * Ignored (treated as `true`) when `uploadToMux` is `true`,
   * since Mux track creation requires a presigned URL.
   */
  uploadToS3?: boolean;
  /**
   * When true (default) the edited VTT is attached as a track on the
   * Mux asset. Implies `uploadToS3: true` because a presigned URL is
   * required for track creation.
   */
  uploadToMux?: boolean;
  /** Optional override for the S3-compatible endpoint used for uploads. */
  s3Endpoint?: string;
  /** S3 region (defaults to env.S3_REGION or 'auto'). */
  s3Region?: string;
  /** Bucket that will store edited VTT files. */
  s3Bucket?: string;
  /** Suffix appended to the original track name, e.g. "edited" produces "Subtitles (edited)". Defaults to "edited". */
  trackNameSuffix?: string;
  /** Expiry duration in seconds for S3 presigned GET URLs. Defaults to 86400 (24 hours). */
  s3SignedUrlExpirySeconds?: number;
}

/** Output returned from `editCaptions`. */
export interface EditCaptionsResult {
  assetId: string;
  trackId: string;
  originalVtt: string;
  editedVtt: string;
  totalReplacementCount: number;
  autoCensorProfanity?: {
    replacements: ReplacementRecord[];
  };
  replacements?: {
    replacements: ReplacementRecord[];
  };
  uploadedTrackId?: string;
  presignedUrl?: string;
  usage?: TokenUsage;
}

/** Schema used when requesting profanity detection from a language model. */
export const profanityDetectionSchema = z.object({
  profanity: z.array(z.string()).describe(
    "Unique profane words or short phrases exactly as they appear in the transcript text. " +
    "Include each distinct form only once (e.g., if 'fuck' and 'fucking' both appear, list both).",
  ),
});

/** Inferred shape returned by `profanityDetectionSchema`. */
export type ProfanityDetectionPayload = z.infer<typeof profanityDetectionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = dedent`
  You are a content moderation assistant. Your task is to identify profane, vulgar, or obscene
  words and phrases in subtitle text. Return ONLY the exact profane words or phrases as they appear
  in the text. Do not modify, censor, or paraphrase them. Do not include words that are merely
  informal or slang but not profane. Focus on words that would be bleeped on broadcast television.`;

// ─────────────────────────────────────────────────────────────────────────────
// Pure functions (exported for testing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applies a transform function only to VTT cue text lines, leaving headers,
 * timestamps, and cue identifiers untouched. A cue text line is any line that
 * follows a timestamp line (contains "-->") up until the next blank line.
 * The transform receives the line text and the cue's start time in seconds.
 */
export function transformCueText(
  rawVtt: string,
  transform: (line: string, cueStartTime: number) => string,
): string {
  const lines = rawVtt.split("\n");
  let inCueText = false;
  let currentCueStartTime = 0;

  const transformed = lines.map((line) => {
    if (line.includes("-->")) {
      const startTimestamp = line.split("-->")[0].trim();
      currentCueStartTime = vttTimestampToSeconds(startTimestamp);
      inCueText = true;
      return line;
    }
    if (line.trim() === "") {
      inCueText = false;
      return line;
    }
    if (inCueText) {
      return transform(line, currentCueStartTime);
    }
    return line;
  });

  return transformed.join("\n");
}

/**
 * Builds a case-insensitive word-boundary regex from an array of profane words.
 * Words are sorted longest-first so multi-word phrases match before individual words.
 */
export function buildReplacementRegex(words: string[]): RegExp | null {
  const filtered = words.filter(w => w.length > 0);
  if (filtered.length === 0)
    return null;

  // Sort by length descending so longer phrases match first
  filtered.sort((a, b) => b.length - a.length);

  // Escape regex special characters in each word
  const escaped = filtered.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  const pattern = escaped.join("|");
  return new RegExp(`\\b(?:${pattern})\\b`, "gi");
}

/**
 * Returns a replacer function for the given censor mode.
 */
export function createReplacer(mode: CensorMode): (match: string) => string {
  switch (mode) {
    case "blank":
      return match => `[${"_".repeat(match.length)}]`;
    case "remove":
      return () => "";
    case "mask":
      return match => "?".repeat(match.length);
  }
}

/**
 * Applies profanity censorship to cue text lines in raw VTT content via
 * regex replacement. Headers, timestamps, and cue identifiers are untouched.
 */
export function censorVttContent(
  rawVtt: string,
  profanity: string[],
  mode: CensorMode,
): { censoredVtt: string; replacements: ReplacementRecord[] } {
  if (profanity.length === 0) {
    return { censoredVtt: rawVtt, replacements: [] };
  }

  const regex = buildReplacementRegex(profanity);
  if (!regex) {
    return { censoredVtt: rawVtt, replacements: [] };
  }

  const replacer = createReplacer(mode);
  const replacements: ReplacementRecord[] = [];

  const censoredVtt = transformCueText(rawVtt, (line, cueStartTime) => {
    return line.replace(regex, (match) => {
      const after = replacer(match);
      replacements.push({ cueStartTime, before: match, after });
      return after;
    });
  });

  return { censoredVtt, replacements };
}

/**
 * Merges `alwaysCensor` into and filters `neverCensor` from an LLM-detected
 * profanity list. Comparison is case-insensitive. `neverCensor` takes
 * precedence over `alwaysCensor` when the same word appears in both.
 */
export function applyOverrideLists(
  detected: string[],
  alwaysCensor: string[],
  neverCensor: string[],
): string[] {
  // Build a set of existing words (lowercased) for deduplication
  const seen = new Set(detected.map(w => w.toLowerCase()));
  const merged = [...detected];

  for (const word of alwaysCensor) {
    const lower = word.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      merged.push(word);
    }
  }

  // Filter out neverCensor words (case-insensitive)
  const neverSet = new Set(neverCensor.map(w => w.toLowerCase()));
  return merged.filter(w => !neverSet.has(w.toLowerCase()));
}

/**
 * Applies static find/replace pairs to cue text lines in raw VTT content
 * using word-boundary regex. Case-sensitive matching since static replacements
 * target specific known strings. Headers, timestamps, and cue identifiers are
 * untouched. Returns the edited VTT and the total number of replacements.
 */
export function applyReplacements(
  rawVtt: string,
  replacements: CaptionReplacement[],
): { editedVtt: string; replacements: ReplacementRecord[] } {
  const filtered = replacements.filter(r => r.find.length > 0);
  if (filtered.length === 0) {
    return { editedVtt: rawVtt, replacements: [] };
  }

  const records: ReplacementRecord[] = [];

  const editedVtt = transformCueText(rawVtt, (line, cueStartTime) => {
    let result = line;
    for (const { find, replace } of filtered) {
      const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`\\b${escaped}\\b`, "g");
      result = result.replace(regex, (match) => {
        records.push({ cueStartTime, before: match, after: replace });
        return replace;
      });
    }
    return result;
  });

  return { editedVtt, replacements: records };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step functions
// ─────────────────────────────────────────────────────────────────────────────

async function identifyProfanityWithAI({
  plainText,
  provider,
  modelId,
  credentials,
}: {
  plainText: string;
  provider: SupportedProvider;
  modelId: string;
  credentials?: WorkflowCredentialsInput;
}): Promise<{ profanity: string[]; usage: TokenUsage }> {
  "use step";

  const model = await createLanguageModelFromConfig(provider, modelId, credentials);

  const response = await generateText({
    model,
    output: Output.object({ schema: profanityDetectionSchema }),
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content:
          "Identify all profane words and phrases in the following subtitle transcript. " +
          "Return each unique profane word or phrase exactly as it appears in the text.\n\n" +
          `<transcript>\n${plainText}\n</transcript>`,
      },
    ],
  });

  return {
    profanity: response.output.profanity,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      reasoningTokens: response.usage.reasoningTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
    },
  };
}

async function uploadEditedVttToS3({
  editedVtt,
  assetId,
  trackId,
  s3Endpoint,
  s3Region,
  s3Bucket,
  storageAdapter,
  s3SignedUrlExpirySeconds,
}: {
  editedVtt: string;
  assetId: string;
  trackId: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  storageAdapter?: StorageAdapter;
  s3SignedUrlExpirySeconds?: number;
}): Promise<string> {
  "use step";

  const s3AccessKeyId = env.S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = env.S3_SECRET_ACCESS_KEY;

  const vttKey = `edited/${assetId}/${trackId}-edited-${Date.now()}.vtt`;

  await putObjectWithStorageAdapter({
    accessKeyId: s3AccessKeyId,
    secretAccessKey: s3SecretAccessKey,
    endpoint: s3Endpoint,
    region: s3Region,
    bucket: s3Bucket,
    key: vttKey,
    body: editedVtt,
    contentType: "text/vtt",
  }, storageAdapter);

  return createPresignedGetUrlWithStorageAdapter({
    accessKeyId: s3AccessKeyId,
    secretAccessKey: s3SecretAccessKey,
    endpoint: s3Endpoint,
    region: s3Region,
    bucket: s3Bucket,
    key: vttKey,
    expiresInSeconds: s3SignedUrlExpirySeconds ?? 86400,
  }, storageAdapter);
}

async function deleteTrackOnMux(
  assetId: string,
  trackId: string,
  credentials?: WorkflowCredentialsInput,
): Promise<void> {
  "use step";
  const muxClient = await resolveMuxClient(credentials);
  const mux = await muxClient.createClient();
  await mux.video.assets.deleteTrack(assetId, trackId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main workflow
// ─────────────────────────────────────────────────────────────────────────────

export async function editCaptions<P extends SupportedProvider = SupportedProvider>(
  assetId: string,
  trackId: string,
  options: EditCaptionsOptions<P>,
): Promise<EditCaptionsResult> {
  "use workflow";

  const {
    provider,
    model,
    autoCensorProfanity: autoCensorOption,
    replacements: replacementsOption,
    deleteOriginalTrack,
    uploadToS3: uploadToS3Option,
    uploadToMux: uploadToMuxOption,
    s3Endpoint: providedS3Endpoint,
    s3Region: providedS3Region,
    s3Bucket: providedS3Bucket,
    trackNameSuffix,
    storageAdapter,
    credentials,
  } = options;

  // Validation
  const hasAutoCensor = !!autoCensorOption;
  const hasReplacements = !!replacementsOption && replacementsOption.length > 0;
  if (!hasAutoCensor && !hasReplacements) {
    throw new MuxAiError("At least one of autoCensorProfanity or replacements must be provided.", { type: "validation_error" });
  }

  if (autoCensorOption && !provider) {
    throw new MuxAiError("provider is required when using autoCensorProfanity.", { type: "validation_error" });
  }

  const deleteOriginal = deleteOriginalTrack !== false;
  const uploadToMux = uploadToMuxOption !== false; // Default to true
  const uploadToS3 = uploadToS3Option || uploadToMux; // Defaults to uploadToMux; uploadToMux: true forces S3 upload

  // S3 configuration
  const s3Endpoint = providedS3Endpoint ?? env.S3_ENDPOINT;
  const s3Region = providedS3Region ?? env.S3_REGION ?? "auto";
  const s3Bucket = providedS3Bucket ?? env.S3_BUCKET;
  const s3AccessKeyId = env.S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = env.S3_SECRET_ACCESS_KEY;

  if (uploadToS3 && (!s3Endpoint || !s3Bucket || (!storageAdapter && (!s3AccessKeyId || !s3SecretAccessKey)))) {
    throw new MuxAiError(
      "Storage configuration is required for uploading. Provide s3Endpoint and s3Bucket. " +
      "If no storageAdapter is supplied, also provide s3AccessKeyId and s3SecretAccessKey in options " +
      "or set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY environment variables.",
      { type: "validation_error" },
    );
  }

  // Fetch asset data and playback ID from Mux
  const { asset: assetData, playbackId, policy } = await getPlaybackIdForAsset(assetId, credentials);
  const assetDurationSeconds = getAssetDurationSecondsFromAsset(assetData);

  // Resolve signing context for signed playback IDs
  const signingContext = await resolveMuxSigningContext(credentials);
  if (policy === "signed" && !signingContext) {
    throw new MuxAiError(
      "Signed playback ID requires signing credentials. " +
      "Set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
      { type: "validation_error" },
    );
  }

  // Validate track exists
  const readyTextTracks = getReadyTextTracks(assetData);
  const sourceTrack = readyTextTracks.find(t => t.id === trackId);
  if (!sourceTrack) {
    const availableTrackIds = readyTextTracks
      .map(t => t.id)
      .filter(Boolean)
      .join(", ");
    throw new MuxAiError(
      `Track '${trackId}' not found or not ready on asset '${assetId}'. ` +
      `Available track IDs: ${availableTrackIds || "none"}`,
      { type: "validation_error" },
    );
  }

  // Fetch the VTT file content
  const vttUrl = await buildTranscriptUrl(playbackId, trackId, policy === "signed", credentials);

  let vttContent: string;
  try {
    vttContent = await fetchVttFromMux(vttUrl);
  } catch (error) {
    wrapError(error, "Failed to fetch VTT content");
  }

  let editedVtt = vttContent;
  let totalReplacementCount = 0;

  // 1. LLM-powered profanity censorship first (analyses original text)
  let autoCensorResult: { replacements: ReplacementRecord[] } | undefined;
  let usage: TokenUsage | undefined;
  if (autoCensorOption) {
    const { mode = "blank", alwaysCensor = [], neverCensor = [] } = autoCensorOption;

    const plainText = extractTextFromVTT(vttContent);
    if (!plainText.trim()) {
      throw new MuxAiError("Track transcript is empty; nothing to censor.", { type: "validation_error" });
    }

    const modelConfig = resolveLanguageModelConfig({
      ...options,
      provider: provider as SupportedProvider,
      model,
    });

    let detectedProfanity: string[];
    try {
      const result = await identifyProfanityWithAI({
        plainText,
        provider: modelConfig.provider,
        modelId: modelConfig.modelId,
        credentials,
      });
      detectedProfanity = result.profanity;
      usage = result.usage;
    } catch (error) {
      wrapError(error, `Failed to detect profanity with ${modelConfig.provider}`);
    }

    const finalProfanity = applyOverrideLists(detectedProfanity, alwaysCensor, neverCensor);

    const { censoredVtt, replacements: censorReplacements } = censorVttContent(editedVtt, finalProfanity, mode);
    editedVtt = censoredVtt;
    totalReplacementCount += censorReplacements.length;
    autoCensorResult = { replacements: censorReplacements };
  }

  // 2. Static replacements applied after censorship
  let replacementsResult: { replacements: ReplacementRecord[] } | undefined;
  if (replacementsOption && replacementsOption.length > 0) {
    const { editedVtt: afterReplacements, replacements: staticReplacements } = applyReplacements(editedVtt, replacementsOption);
    editedVtt = afterReplacements;
    totalReplacementCount += staticReplacements.length;
    replacementsResult = { replacements: staticReplacements };
  }

  const usageWithMetadata = usage ?
      {
        ...usage,
        metadata: {
          assetDurationSeconds,
        },
      } :
    undefined;

  // Upload edited VTT to S3-compatible storage
  let presignedUrl: string | undefined;
  let uploadedTrackId: string | undefined;

  if (uploadToS3) {
    try {
      presignedUrl = await uploadEditedVttToS3({
        editedVtt,
        assetId,
        trackId,
        s3Endpoint: s3Endpoint!,
        s3Region,
        s3Bucket: s3Bucket!,
        storageAdapter,
        s3SignedUrlExpirySeconds: options.s3SignedUrlExpirySeconds,
      });
    } catch (error) {
      wrapError(error, "Failed to upload VTT to S3");
    }

    // Add edited track to Mux asset (only when uploadToMux is true)
    if (uploadToMux) {
      try {
        const languageCode = sourceTrack.language_code || "en";
        const suffix = trackNameSuffix ?? "edited";
        const trackName = `${sourceTrack.name || "Subtitles"} (${suffix})`;

        uploadedTrackId = await createTextTrackOnMux(
          assetId,
          languageCode,
          trackName,
          presignedUrl,
          credentials,
        );
      } catch (error) {
        console.warn(`Failed to add track to Mux asset: ${error instanceof Error ? error.message : "Unknown error"}`);
      }

      // Delete original track only if the replacement track was created
      if (deleteOriginal && uploadedTrackId) {
        try {
          await deleteTrackOnMux(assetId, trackId, credentials);
        } catch (error) {
          console.warn(`Failed to delete original track: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
      }
    }
  }

  return {
    assetId,
    trackId,
    originalVtt: vttContent,
    editedVtt,
    totalReplacementCount,
    autoCensorProfanity: autoCensorResult,
    replacements: replacementsResult,
    uploadedTrackId,
    presignedUrl,
    usage: usageWithMetadata,
  };
}
