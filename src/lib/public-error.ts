import type { MuxAiError, MuxAiErrorCode, MuxAiErrorFacts, MuxAiErrorFactValue, MuxAiErrorType } from "./mux-ai-error.ts";
import { MUX_AI_ERROR_CODES, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES } from "./mux-ai-error.ts";
import { legacyMp4SupportTooLargeMessage, legacyMp4SupportUnusableMessage } from "./mux-static-renditions.ts";
import type { TextTrackSummary } from "./mux-tracks.ts";
import { describeTrackSummaries } from "./mux-tracks.ts";

/**
 * What a consumer may show its end users about a failure. `type` and `retryable`
 * are always public; `code` and `facts` only for codes with a public mapping. The
 * error's own `message` never appears here.
 */
export interface MuxAiPublicError {
  type: MuxAiErrorType;
  /** Present only for codes in {@link MUX_AI_ERROR_PUBLIC_MAPPINGS}. */
  code?: MuxAiErrorCode;
  message: string;
  retryable: boolean;
  /** Only the facts the code's mapping allows. */
  facts?: MuxAiErrorFacts;
}

/** How one code is shown to end users. */
export interface MuxAiErrorPublicMapping {
  /** Facts that may reach end users. Every other fact is dropped. */
  facts?: readonly string[];
  /** End-user text, built only from the allowed facts. */
  message: string | ((facts: MuxAiErrorFacts, error: { retryable: boolean }) => string);
}

const TRY_AGAIN = " Please try again.";

/**
 * Wording for a failure whose code has no public mapping (or that has no code):
 * by source for failures the caller can act on, otherwise by type.
 */
export const MUX_AI_ERROR_GENERIC_MESSAGES = {
  request: "The request's parameters can't be used for this operation.",
  asset: "The asset can't be processed by this operation.",
  account: "The Mux account or environment can't be used for this operation.",
  timeout: "The operation timed out.",
  capacity: "A required service is over capacity.",
  contentPolicy: "The content was blocked by a content policy.",
  unavailable: "A required service was temporarily unavailable.",
  failed: "The operation failed.",
} as const;

function text(value: MuxAiErrorFactValue | undefined): string {
  return value === undefined || value === null ? "" : String(value);
}

function list(value: MuxAiErrorFactValue | undefined): string {
  return Array.isArray(value) && value.length > 0 ? value.map(text).join(", ") : "none";
}

function trackTarget(facts: MuxAiErrorFacts): string {
  const parts = [facts.languageCode && `language '${text(facts.languageCode)}'`, facts.trackName && `name '${text(facts.trackName)}'`].filter(Boolean);
  return parts.length > 0 ? ` for ${parts.join(" or ")}` : "";
}

function blockedTrackMessage(facts: MuxAiErrorFacts): string {
  const tracks = (Array.isArray(facts.conflictingTracks) ? facts.conflictingTracks : []) as unknown as TextTrackSummary[];
  const kind = facts.trackType === "audio" ? "audio" : "text";
  const subject = tracks.length > 1 ? `${tracks.length} ${kind} tracks` : `${kind === "audio" ? "An" : "A"} ${kind} track`;
  const described = tracks.length > 0 ? `: ${describeTrackSummaries(tracks)}` : "";
  const them = tracks.length > 1 ? "them" : "it";
  switch (facts.reason) {
    case "not_generated":
      return `${subject} that ${tracks.length > 1 ? "are" : "is"} not Mux-generated already ${tracks.length > 1 ? "exist" : "exists"}${trackTarget(facts)}${described}. Allow all existing tracks to be replaced, not only Mux-generated ones, to replace ${them}.`;
    case "name_collision":
      return `${subject} already ${tracks.length > 1 ? "have" : "has"} the name '${text(facts.trackName)}'${described}. Choose a different track name.`;
    case "primary_audio":
      return `The asset's primary audio track is in the way${trackTarget(facts)}${described}. Primary audio can't be replaced; choose a different track name.`;
    default:
      return `${subject} already ${tracks.length > 1 ? "exist" : "exists"}${trackTarget(facts)}${described}. Allow existing tracks to be replaced to replace ${them}.`;
  }
}

function scopeMessage(facts: MuxAiErrorFacts): string {
  switch (facts.reason) {
    case "invalid_start_time":
      return `The requested start time must be a non-negative number of seconds (received ${text(facts.received)}).`;
    case "invalid_end_time":
      return `The requested end time must be a non-negative number of seconds (received ${text(facts.received)}).`;
    case "exceeds_duration":
      return `The requested end time (${text(facts.endTime)}s) is after the end of the asset (${text(facts.assetDurationSeconds)}s).`;
    case "empty_range":
      return `The requested start time (${text(facts.startTime)}s) must be before the end time (${text(facts.endTime)}s).`;
    case "no_video":
      return "The requested time range doesn't include any video.";
    case "no_transcript":
      return "The transcript has no content in the requested time range.";
    default:
      return "The requested time range can't be used for this asset.";
  }
}

const AUDIO_TRACK_UNSUPPORTED_MESSAGES: Readonly<Record<string, string>> = {
  clip: "Mux doesn't support adding audio tracks to clipped assets. Dub the source asset instead, or use the dubbed audio file without adding it to Mux.",
  live_stream: "Mux doesn't support adding audio tracks to live stream assets. Use the dubbed audio file without adding it to Mux instead.",
  audio_only: "Mux doesn't support adding audio tracks to audio-only assets. Use the dubbed audio file without adding it to Mux instead.",
};

/**
 * The codes end users may see, and how. A code absent here is internal: it renders
 * through {@link MUX_AI_ERROR_GENERIC_MESSAGES} and its code and facts are dropped.
 * Add a code only when its condition is something an end user can act on or needs
 * to know, and allow only facts that are safe to show (never URLs, credentials,
 * provider internals or model output).
 */
export const MUX_AI_ERROR_PUBLIC_MAPPINGS = {
  [MUX_AI_ERROR_CODES.INVALID_SCOPE]: {
    facts: ["reason", "received", "startTime", "endTime", "assetDurationSeconds"],
    message: scopeMessage,
  },
  [MUX_AI_ERROR_CODES.TRACK_REPLACEMENT_BLOCKED]: {
    facts: ["reason", "trackType", "languageCode", "trackName", "conflictingTracks"],
    message: blockedTrackMessage,
  },
  [MUX_AI_ERROR_CODES.CAPTION_TRACK_NOT_FOUND]: {
    facts: ["trackId", "availableTrackIds", "languageCode", "availableLanguages"],
    message: facts => facts.trackId ?
      `Track ${text(facts.trackId)} was not found or is not ready. Available track IDs: ${list(facts.availableTrackIds)}.` :
      `No ready caption track was found${facts.languageCode ? ` for language ${text(facts.languageCode)}` : ""}. Available languages: ${list(facts.availableLanguages)}.`,
  },
  [MUX_AI_ERROR_CODES.PLAYBACK_ID_NOT_FOUND]: {
    message: "The asset has no public or signed playback ID. DRM playback IDs aren't supported.",
  },
  [MUX_AI_ERROR_CODES.TRANSCRIPT_EMPTY]: {
    message: "The transcript has no usable content.",
  },
  [MUX_AI_ERROR_CODES.AUDIO_TRACK_UNSUPPORTED]: {
    facts: ["reason"],
    message: facts => AUDIO_TRACK_UNSUPPORTED_MESSAGES[text(facts.reason)] ?? "Mux doesn't support adding audio tracks to this asset.",
  },
  [MUX_AI_ERROR_CODES.STATIC_RENDITION_UNSUPPORTED]: {
    facts: ["reason", "mp4Support", "renditionStatus", "renditionName", "sizeBytes", "maxBytes"],
    message: facts => facts.reason === "too_large" ?
        legacyMp4SupportTooLargeMessage({ name: text(facts.renditionName), filesizeBytes: Number(facts.sizeBytes), maxBytes: Number(facts.maxBytes) }) :
        legacyMp4SupportUnusableMessage({ status: text(facts.renditionStatus) || undefined, mp4Support: text(facts.mp4Support) || undefined }),
  },
  [MUX_AI_ERROR_CODES.STATIC_RENDITION_FAILED]: {
    message: "Mux failed to create the static rendition this operation needs. Check the asset's static renditions in the Mux dashboard.",
  },
  [MUX_AI_ERROR_CODES.CONTENT_POLICY_BLOCKED]: {
    facts: ["reason", "category"],
    message: (facts) => {
      const detail = [facts.reason && `reason: ${text(facts.reason)}`, facts.category && `category: ${text(facts.category)}`].filter(Boolean).join("; ");
      return `The content was blocked by a content policy${detail ? ` (${detail})` : ""}.`;
    },
  },
  [MUX_AI_ERROR_CODES.DUBBING_LANGUAGE_UNSUPPORTED]: {
    facts: ["language", "which"],
    message: facts => `Audio dubbing doesn't support the ${text(facts.which) || "requested"} language "${text(facts.language)}".`,
  },
  [MUX_AI_ERROR_CODES.DUBBING_FAILED]: {
    // The dubbing provider documents this text as safe to display.
    facts: ["providerError"],
    message: (facts, { retryable }) => `Audio dubbing failed${facts.providerError ? `: ${text(facts.providerError)}` : "."}${retryable ? TRY_AGAIN : ""}`,
  },
} as const satisfies Partial<Record<MuxAiErrorCode, MuxAiErrorPublicMapping>>;

function genericMessage(error: MuxAiError): string {
  const retry = error.retryable ? TRY_AGAIN : "";
  switch (error.source) {
    case MUX_AI_ERROR_SOURCES.REQUEST:
      return MUX_AI_ERROR_GENERIC_MESSAGES.request;
    case MUX_AI_ERROR_SOURCES.ASSET:
      return `${MUX_AI_ERROR_GENERIC_MESSAGES.asset}${retry}`;
    case MUX_AI_ERROR_SOURCES.ACCOUNT:
      return MUX_AI_ERROR_GENERIC_MESSAGES.account;
  }
  switch (error.type) {
    case MUX_AI_ERROR_TYPES.TIMEOUT_ERROR:
      return `${MUX_AI_ERROR_GENERIC_MESSAGES.timeout}${retry}`;
    case MUX_AI_ERROR_TYPES.CAPACITY_ERROR:
      return `${MUX_AI_ERROR_GENERIC_MESSAGES.capacity}${retry}`;
    case MUX_AI_ERROR_TYPES.CONTENT_POLICY_ERROR:
      return MUX_AI_ERROR_GENERIC_MESSAGES.contentPolicy;
    default:
      return error.retryable ? `${MUX_AI_ERROR_GENERIC_MESSAGES.unavailable}${TRY_AGAIN}` : MUX_AI_ERROR_GENERIC_MESSAGES.failed;
  }
}

function allowedFacts(facts: MuxAiErrorFacts | undefined, allowed: readonly string[] | undefined): MuxAiErrorFacts | undefined {
  if (!facts || !allowed?.length) {
    return undefined;
  }
  const picked = Object.fromEntries(allowed.filter(key => facts[key] !== undefined).map(key => [key, facts[key]]));
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/**
 * The end-user view of a failure. A code with a public mapping keeps its code and
 * allowed facts and renders the mapping's text; anything else renders generic text
 * by source, then by type. Never includes the error's own `message`.
 */
export function toPublicError(error: MuxAiError): MuxAiPublicError {
  const mapping: MuxAiErrorPublicMapping | undefined = error.code ?
      (MUX_AI_ERROR_PUBLIC_MAPPINGS as Partial<Record<MuxAiErrorCode, MuxAiErrorPublicMapping>>)[error.code] :
    undefined;
  if (!mapping) {
    return { type: error.type, message: genericMessage(error), retryable: error.retryable };
  }
  const facts = allowedFacts(error.facts, mapping.facts);
  return {
    type: error.type,
    code: error.code,
    message: typeof mapping.message === "string" ? mapping.message : mapping.message(facts ?? {}, error),
    retryable: error.retryable,
    ...(facts && { facts }),
  };
}
