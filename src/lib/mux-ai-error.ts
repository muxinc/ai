import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";

import type { TokenUsage } from "../types.ts";

// The legacy payload type, for MuxAiError's WORKFLOW_SERIALIZE return type only.
// LegacyMuxAiError (in legacy-mux-ai-error.ts) extends MuxAiError and overrides its
// static serializer to write this pre-classification shape, and TypeScript requires an
// overriding static method to return a type the base one allows, so the base return
// type names it. The import is type only and is erased from the output, so it adds no
// runtime import back to the legacy module, which itself imports MuxAiError at runtime
// to extend it (a runtime cycle there could break class definition order). It goes away
// with the legacy module.
import type { LegacySerializedMuxAiError } from "./legacy-mux-ai-error.ts";
import { detectLeakReason } from "./output-safety.ts";
import { getErrorTokenUsage } from "./token-usage.ts";

/**
 * Public error categories for job outcomes. One list for the SDK and its consumers,
 * which may extend it with their own types (e.g. request-time HTTP errors). Treat
 * `type` as an open string, so adding a value is not a breaking change.
 */
export const MUX_AI_ERROR_TYPES = {
  /** The request, the asset or the account can't be used as it is. */
  VALIDATION_ERROR: "validation_error",
  /** The work was attempted and failed. */
  PROCESSING_ERROR: "processing_error",
  /** The work didn't finish in time. */
  TIMEOUT_ERROR: "timeout_error",
  /** Content was refused by a content policy. */
  CONTENT_POLICY_ERROR: "content_policy_error",
  /** A service is rate limiting or over capacity. */
  CAPACITY_ERROR: "capacity_error",
  /** A fault in this code or its configuration. */
  SERVER_ERROR: "server_error",
} as const;
export type MuxAiErrorType = typeof MUX_AI_ERROR_TYPES[keyof typeof MUX_AI_ERROR_TYPES];
export const MUX_AI_ERROR_TYPE_VALUES: readonly MuxAiErrorType[] = Object.values(MUX_AI_ERROR_TYPES);

/** Whose problem a failure is, judged from the SDK caller's side. A consumer may re-attribute it. */
export const MUX_AI_ERROR_SOURCES = {
  /** The caller's input, e.g. a scope past the end of the asset. */
  REQUEST: "request",
  /** The Mux asset's state, e.g. no caption track in the requested language. */
  ASSET: "asset",
  /** The Mux account or environment, e.g. missing permissions. */
  ACCOUNT: "account",
  /** A remote service failed, e.g. the dubbing provider reported a failed dub. */
  UPSTREAM: "upstream",
  /** This code, or the configuration of the service running it, e.g. missing signing keys. */
  INTERNAL: "internal",
} as const;
export type MuxAiErrorSource = typeof MUX_AI_ERROR_SOURCES[keyof typeof MUX_AI_ERROR_SOURCES];
export const MUX_AI_ERROR_SOURCE_VALUES: readonly MuxAiErrorSource[] = Object.values(MUX_AI_ERROR_SOURCES);

/** A remote service reached over the network. Libraries in this process are not dependencies. */
export const MUX_AI_ERROR_DEPENDENCIES = {
  /** Mux Video: the API, stream and image delivery, and its static renditions and tracks. */
  MUX_VIDEO: "mux_video",
  /** Mux Data: its API, e.g. engagement data (heatmaps and hotspots). */
  MUX_DATA: "mux_data",
  /** A model or AI service provider, e.g. a language model API or the dubbing provider. */
  AI_PROVIDER: "ai_provider",
  /** Object storage the SDK writes to or reads from, e.g. an S3-compatible bucket. */
  STORAGE: "storage",
} as const;
export type MuxAiErrorDependency = typeof MUX_AI_ERROR_DEPENDENCIES[keyof typeof MUX_AI_ERROR_DEPENDENCIES];
export const MUX_AI_ERROR_DEPENDENCY_VALUES: readonly MuxAiErrorDependency[] = Object.values(MUX_AI_ERROR_DEPENDENCIES);

export type MuxAiErrorFactValue = string | number | boolean | null | MuxAiErrorFactValue[] | { [key: string]: MuxAiErrorFactValue };

/**
 * Details of one occurrence, JSON-safe so they survive step boundaries. Internal by
 * default: a consumer chooses what, if anything, to show. Dependency errors always
 * carry `call` (the outside call's snake_case name), plus `status` and `requestId`
 * when there was a response. A failure blamed on an input the caller passed carries
 * `inputs`: the input names involved (e.g. `credentials`), so a caller that set that
 * input itself, rather than passing on its end user's, can re-attribute the failure.
 */
export type MuxAiErrorFacts = Readonly<Record<string, MuxAiErrorFactValue>>;

/**
 * Opts a shared helper into raising classified errors. A workflow passes it once it has
 * moved onto the classified model; without it, the helper fails exactly as it did
 * before, so workflows that haven't moved see no change. It goes away once every
 * caller has moved and classified errors become the only behavior.
 */
export interface ClassifiedErrorsOption {
  classifiedErrors?: boolean;
}

/**
 * What a code implies, in any catalog built on {@link ClassifiedError}: its type,
 * source and dependency, and retry overrides that hold for every occurrence.
 */
/**
 * A failure's source and the remote service involved, if any. An `upstream` failure is a
 * remote service's, so it always names the dependency; any other source names one when a
 * remote call was involved (e.g. Mux's 404 for the caller's asset).
 */
export type SourceAndDependency<TDependency extends string = string> =
  { source: typeof MUX_AI_ERROR_SOURCES.UPSTREAM; dependency: TDependency } |
  { source: Exclude<MuxAiErrorSource, typeof MUX_AI_ERROR_SOURCES.UPSTREAM>; dependency?: TDependency };

export type ErrorCatalogEntry<TType extends string = string, TDependency extends string = string> = {
  type: TType;
  /** Overrides the default from {@link defaultRetryable} for every error with this code. */
  retryable?: boolean;
  /** Overrides the default from {@link defaultTransient} for every error with this code. */
  transient?: boolean;
} & SourceAndDependency<TDependency>;

/**
 * Codes for conditions precise enough to name. A code implies its type, source and
 * dependency (see {@link MUX_AI_ERROR_CATALOG}), so a site raising it can't contradict
 * them. Codes name the condition, never the vendor.
 */
export const MUX_AI_ERROR_CODES = {
  /** The requested time range is invalid, or has nothing to work with. Facts: `reason` (`invalid_start_time`, `invalid_end_time`, `exceeds_duration`, `empty_range`, `no_video`, `no_transcript`) and the bounds involved. */
  INVALID_SCOPE: "invalid_scope",
  /** Existing tracks block writing the output track under the chosen replacement policy. Facts: `reason` (`policy_fail`, `not_generated`, `name_collision`, `primary_audio`), `conflictingTracks` and the target track, plus `sourceRestored` and `restoredTrackId` when a source track was deleted first. */
  TRACK_REPLACEMENT_BLOCKED: "track_replacement_blocked",
  /** An option's value can't be used. Facts: `parameter` (the caller's option name), `reason` (`too_many`, `empty`, `too_long`, `disallowed_characters`, `not_normalized`, `multiline`, `required_with`, `conflicts_with`, `not_allowed`, `one_of_required`) and the values the reason names: `count` and `max`, `index` (0-based entry), `length` and `maxLength`, `characters`, `with` and `withValue` (the other option), `allowed` and `value`, `parameters` (the options to choose from). */
  INVALID_PARAMETER: "invalid_parameter",
  /** A numeric option is outside its allowed range. Facts: `parameter` (the caller's option name), `value`, `min`, `max`, and `integer` when it must be a whole number. */
  PARAMETER_OUT_OF_RANGE: "parameter_out_of_range",
  /** No ready caption track matches the requested track or language. Facts: `trackId` or `languageCode`, and what is available. */
  CAPTION_TRACK_NOT_FOUND: "caption_track_not_found",
  /** The caption track has no language, so its source language can't be determined. Facts: `trackId`. */
  CAPTION_TRACK_LANGUAGE_MISSING: "caption_track_language_missing",
  /** The asset has no public or signed playback ID (DRM-only assets included). */
  PLAYBACK_ID_NOT_FOUND: "playback_id_not_found",
  /** Mux has no asset with the requested ID in this environment. Facts: `assetId`. */
  ASSET_NOT_FOUND: "asset_not_found",
  /** The transcript has no usable content. */
  TRANSCRIPT_EMPTY: "transcript_empty",
  /** The asset has no valid duration, so work that depends on it can't run. Facts: `assetId`. */
  ASSET_DURATION_UNAVAILABLE: "asset_duration_unavailable",
  /** Mux won't add an audio track to this asset. Facts: `reason` (`clip`, `live_stream`, `audio_only`). */
  AUDIO_TRACK_UNSUPPORTED: "audio_track_unsupported",
  /** The asset's existing static rendition can't be used as a source. Facts: `reason` (`unusable`, `too_large`) and the rendition's details. */
  STATIC_RENDITION_UNSUPPORTED: "static_rendition_unsupported",
  /** Signed playback needs signing keys the service running the SDK didn't provide. */
  SIGNING_CREDENTIALS_MISSING: "signing_credentials_missing",
  /** Storage is needed but the service running the SDK didn't configure it. */
  STORAGE_NOT_CONFIGURED: "storage_not_configured",
  /** A track write failed, but the opted-in result carried no classified error: a bug in the SDK's track-write path. Facts: `reason`, the raw failure's message. */
  TRACK_WRITE_UNCLASSIFIED: "track_write_unclassified",
  /** Mux answered a track create without a track id. The track may exist, so it isn't step-retried. Facts: `call`, `assetId`. */
  TRACK_ID_MISSING: "track_id_missing",
  /** The asset snapshot passed in is for a different asset than the one requested. Facts: `assetId`, `snapshotAssetId`. */
  ASSET_SNAPSHOT_MISMATCH: "asset_snapshot_mismatch",
  /** Translation needed to split a chunk of fewer than two cues: a bug in the SDK's chunking. Facts: `chunkId`, `cueCount`. */
  TRANSLATION_CHUNK_UNSPLITTABLE: "translation_chunk_unsplittable",
  /** The model provider refused the content. Facts: `reason` and `category`. */
  CONTENT_POLICY_BLOCKED: "content_policy_blocked",
  /** The model returned no output, or a required field was empty. Facts: `call`, `provider`, `model`, and `assetId` when there is one. */
  MODEL_OUTPUT_MISSING: "model_output_missing",
  /** The model's output breaks the expected shape or constraints (counts, allowed values, limits). Facts: `call`, `provider`, `model`, and `assetId` when there is one. */
  MODEL_OUTPUT_INVALID: "model_output_invalid",
  /** The model's output was withheld by the SDK's output safety filter (a suspected prompt leak). */
  MODEL_OUTPUT_SUPPRESSED: "model_output_suppressed",
  /** The model stopped early for a reason other than the length limit. */
  MODEL_OUTPUT_INCOMPLETE: "model_output_incomplete",
  /** The model hit the output length limit. */
  MODEL_OUTPUT_TRUNCATED: "model_output_truncated",
  /** Mux reported the static rendition a workflow needs as errored. */
  STATIC_RENDITION_FAILED: "static_rendition_failed",
  /** The dubbing provider doesn't support the requested language. Facts: `language` and `which` (`target` or `source`). */
  DUBBING_LANGUAGE_UNSUPPORTED: "dubbing_language_unsupported",
  /** The dubbing provider ran the dub and reported it failed. Facts: `providerError`, the provider's display text, when it gave one. */
  DUBBING_FAILED: "dubbing_failed",
} as const;
export type MuxAiErrorCode = typeof MUX_AI_ERROR_CODES[keyof typeof MUX_AI_ERROR_CODES];
export const MUX_AI_ERROR_CODE_VALUES: readonly MuxAiErrorCode[] = Object.values(MUX_AI_ERROR_CODES);

/** The classification and retry policy each code implies. */
export const MUX_AI_ERROR_CATALOG = {
  // The caller's input.
  [MUX_AI_ERROR_CODES.INVALID_SCOPE]: { type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.REQUEST },
  [MUX_AI_ERROR_CODES.TRACK_REPLACEMENT_BLOCKED]: { type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.REQUEST },
  [MUX_AI_ERROR_CODES.INVALID_PARAMETER]: { type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.REQUEST },
  [MUX_AI_ERROR_CODES.PARAMETER_OUT_OF_RANGE]: { type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.REQUEST },
  [MUX_AI_ERROR_CODES.ASSET_NOT_FOUND]: { type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.REQUEST, dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO },
  // The asset's state.
  [MUX_AI_ERROR_CODES.CAPTION_TRACK_NOT_FOUND]: { type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.ASSET },
  [MUX_AI_ERROR_CODES.PLAYBACK_ID_NOT_FOUND]: { type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.ASSET },
  [MUX_AI_ERROR_CODES.ASSET_DURATION_UNAVAILABLE]: { type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.ASSET },
  [MUX_AI_ERROR_CODES.TRANSCRIPT_EMPTY]: { type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.ASSET },
  [MUX_AI_ERROR_CODES.AUDIO_TRACK_UNSUPPORTED]: { type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.ASSET },
  [MUX_AI_ERROR_CODES.STATIC_RENDITION_UNSUPPORTED]: { type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.ASSET },
  // The configuration of the service running the SDK.
  [MUX_AI_ERROR_CODES.SIGNING_CREDENTIALS_MISSING]: { type: MUX_AI_ERROR_TYPES.SERVER_ERROR, source: MUX_AI_ERROR_SOURCES.INTERNAL },
  [MUX_AI_ERROR_CODES.STORAGE_NOT_CONFIGURED]: { type: MUX_AI_ERROR_TYPES.SERVER_ERROR, source: MUX_AI_ERROR_SOURCES.INTERNAL },
  // The SDK's own bug: never expected.
  [MUX_AI_ERROR_CODES.TRACK_WRITE_UNCLASSIFIED]: { type: MUX_AI_ERROR_TYPES.SERVER_ERROR, source: MUX_AI_ERROR_SOURCES.INTERNAL },
  [MUX_AI_ERROR_CODES.TRANSLATION_CHUNK_UNSPLITTABLE]: { type: MUX_AI_ERROR_TYPES.SERVER_ERROR, source: MUX_AI_ERROR_SOURCES.INTERNAL },
  [MUX_AI_ERROR_CODES.ASSET_SNAPSHOT_MISMATCH]: { type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.REQUEST },
  [MUX_AI_ERROR_CODES.CAPTION_TRACK_LANGUAGE_MISSING]: { type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.ASSET },
  // The track may exist, so a step retry could duplicate it; the job stays retryable.
  [MUX_AI_ERROR_CODES.TRACK_ID_MISSING]: { type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR, source: MUX_AI_ERROR_SOURCES.UPSTREAM, dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO },
  // Model calls.
  [MUX_AI_ERROR_CODES.CONTENT_POLICY_BLOCKED]: { type: MUX_AI_ERROR_TYPES.CONTENT_POLICY_ERROR, source: MUX_AI_ERROR_SOURCES.ASSET, dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER },
  // The model-output policies below keep what these failures did before classification
  // (fatal, not resubmittable); sites that differed keep their old values explicitly.
  // Whether they should be retried is an open follow-up, not decided here.
  [MUX_AI_ERROR_CODES.MODEL_OUTPUT_MISSING]: { type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR, source: MUX_AI_ERROR_SOURCES.UPSTREAM, dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER, transient: false, retryable: false },
  [MUX_AI_ERROR_CODES.MODEL_OUTPUT_INVALID]: { type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR, source: MUX_AI_ERROR_SOURCES.UPSTREAM, dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER, transient: false, retryable: false },
  [MUX_AI_ERROR_CODES.MODEL_OUTPUT_SUPPRESSED]: { type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR, source: MUX_AI_ERROR_SOURCES.UPSTREAM, dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER, transient: false, retryable: false },
  // Not transient: a step retry would repeat a full generation; the job can be resubmitted.
  [MUX_AI_ERROR_CODES.MODEL_OUTPUT_INCOMPLETE]: { type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR, source: MUX_AI_ERROR_SOURCES.UPSTREAM, dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER, transient: false },
  [MUX_AI_ERROR_CODES.MODEL_OUTPUT_TRUNCATED]: { type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR, source: MUX_AI_ERROR_SOURCES.INTERNAL, dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER },
  // Mux Video.
  // Reported by Mux: a step retry would find the same errored rendition, and resubmitting the same asset errors again.
  [MUX_AI_ERROR_CODES.STATIC_RENDITION_FAILED]: { type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR, source: MUX_AI_ERROR_SOURCES.UPSTREAM, dependency: MUX_AI_ERROR_DEPENDENCIES.MUX_VIDEO, transient: false, retryable: false },
  // Audio dubbing.
  [MUX_AI_ERROR_CODES.DUBBING_LANGUAGE_UNSUPPORTED]: { type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR, source: MUX_AI_ERROR_SOURCES.REQUEST, dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER },
  // Reported by the dubbing provider: a step retry would find the same failed dub.
  [MUX_AI_ERROR_CODES.DUBBING_FAILED]: { type: MUX_AI_ERROR_TYPES.PROCESSING_ERROR, source: MUX_AI_ERROR_SOURCES.UPSTREAM, dependency: MUX_AI_ERROR_DEPENDENCIES.AI_PROVIDER, transient: false },
} as const satisfies Record<MuxAiErrorCode, ErrorCatalogEntry<MuxAiErrorType, MuxAiErrorDependency>>;

export interface ModelCallDiagnostics {
  phase: "brief" | "draft" | "format_repair" | "length_repair";
  provider: string;
  modelId: string;
  maxOutputTokens?: number;
}

/**
 * No response, a timeout, "too early", rate limiting or a server error: worth retrying.
 * A 409 is not: unlike the AI SDK's own retry loop, a conflict here means state that
 * a retry would hit again.
 */
export function isTransientStatus(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Default for `transient`: an `upstream` failure with a transient status (the `status`
 * fact). Without one, the dependency reported the failure (e.g. a failed dub), which a
 * step retry would find again. A call that got no response is transient too, but the
 * dependency helpers decide that where the call is made ({@link classifyDependencyFailure}).
 */
export function defaultTransient(source: MuxAiErrorSource, facts: MuxAiErrorFacts = {}): boolean {
  return source === MUX_AI_ERROR_SOURCES.UPSTREAM &&
    typeof facts.status === "number" && isTransientStatus(facts.status);
}

/**
 * Default for `retryable`: whether resubmitting the same job may succeed. Yes when
 * the failure is transient, a timeout, capacity, or otherwise `upstream`; no when the
 * request, asset, account or this service's own code or configuration is the problem.
 */
export function defaultRetryable(type: string, source: MuxAiErrorSource, transient: boolean): boolean {
  if (transient || type === MUX_AI_ERROR_TYPES.TIMEOUT_ERROR || type === MUX_AI_ERROR_TYPES.CAPACITY_ERROR) {
    return true;
  }
  if (type === MUX_AI_ERROR_TYPES.VALIDATION_ERROR || type === MUX_AI_ERROR_TYPES.CONTENT_POLICY_ERROR) {
    return false;
  }
  return source === MUX_AI_ERROR_SOURCES.UPSTREAM;
}

/** A short record of one raw cause, kept across step boundaries in place of the cause itself. */
export interface ErrorCauseSummary {
  name: string;
  message: string;
  status?: number;
}

/**
 * The classification a coded site states: the code, and the type, source and dependency
 * its catalog entry implies. Each code accepts only its own, so a site reads on its own
 * and can't contradict the catalog.
 */
export type CodedClassification<TCatalog extends Readonly<Record<string, ErrorCatalogEntry>>> = {
  [C in keyof TCatalog & string]: {
    code: C;
    type: TCatalog[C]["type"];
    source: TCatalog[C]["source"];
  } & (TCatalog[C] extends { dependency: infer D extends string } ? { dependency: D } : { dependency?: never });
}[keyof TCatalog & string];

/**
 * How a site classifies an error: always a type and source (with the dependency for an
 * `upstream` failure), plus a code when the condition has one, plus what varies. With a
 * catalog type (`TCatalog`), a code accepts only the type, source and dependency its
 * catalog entry implies.
 */
export type ClassifiedErrorInit<TType extends string, TCode extends string, TDependency extends string, TCatalog extends Readonly<Record<string, ErrorCatalogEntry>> = never> = (
  ([TCatalog] extends [never] ? ({ code: TCode; type: TType } & SourceAndDependency<TDependency>) : CodedClassification<TCatalog>) |
  ({ code?: never; type: TType } & SourceAndDependency<TDependency>)
) & {
  facts?: MuxAiErrorFacts;
  /**
   * Whether submitting the same job again, unchanged, may succeed. Not "fixable":
   * whether the caller can change something first is what `source` and `code` say.
   * Defaults from the classification ({@link defaultRetryable}); set it only to
   * override, with a comment saying why. Ignored when the error is transient.
   */
  retryable?: boolean;
  /**
   * Whether the step runner should retry the step. Defaults from the classification
   * ({@link defaultTransient}); set it only to override, with a comment saying why
   * (e.g. a call that isn't idempotent).
   */
  transient?: boolean;
  /** The raw cause. Kept locally only; a bounded summary crosses step boundaries. */
  cause?: unknown;
};

export type MuxAiErrorInit = ClassifiedErrorInit<MuxAiErrorType, MuxAiErrorCode, MuxAiErrorDependency, typeof MUX_AI_ERROR_CATALOG>;

/**
 * A classified error's fields as JSON-safe data, for a subclass's Workflow serializer
 * (see {@link serializeClassification} and {@link restoreClassification}).
 */
export interface SerializedClassification<TType extends string = string, TCode extends string = string, TDependency extends string = string> {
  message: string;
  type: TType;
  source: MuxAiErrorSource;
  dependency?: TDependency;
  code?: TCode;
  facts: MuxAiErrorFacts;
  retryable: boolean;
  transient: boolean;
  causes: ErrorCauseSummary[];
  stack?: string;
}

/**
 * What crosses a Workflow step boundary. A run replays the events it already wrote,
 * so `v` is bumped on a shape change and earlier versions stay readable.
 */
export interface SerializedMuxAiError extends SerializedClassification<MuxAiErrorType, MuxAiErrorCode, MuxAiErrorDependency> {
  v: 2;
  usage?: TokenUsage;
  finishReason?: string;
  rawFinishReason?: string;
  diagnostics?: ModelCallDiagnostics;
}

const MAX_CAUSE_DEPTH = 3;
const MAX_CAUSE_MESSAGE_LENGTH = 500;

function statusOf(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { status, statusCode } = value as { status?: unknown; statusCode?: unknown };
  const candidate = typeof status === "number" ? status : statusCode;
  return typeof candidate === "number" && candidate >= 100 && candidate < 600 ? candidate : undefined;
}

/** Summarizes a cause chain, scrubbing high-confidence prompt leaks from each message. */
function summarizeCauses(cause: unknown): ErrorCauseSummary[] {
  const causes: ErrorCauseSummary[] = [];
  let current = cause;
  while (current !== undefined && current !== null && causes.length < MAX_CAUSE_DEPTH) {
    if (ClassifiedError.isClassified(current)) {
      causes.push(...current.causes.slice(0, MAX_CAUSE_DEPTH - causes.length));
      break;
    }
    const status = statusOf(current);
    causes.push({
      // Duck-typed: an error from another realm (e.g. a Workflow step VM) fails instanceof.
      name: typeof (current as { name?: unknown }).name === "string" ? (current as { name: string }).name : typeof current,
      message: scrubDetail(extractErrorDetail(current)).slice(0, MAX_CAUSE_MESSAGE_LENGTH),
      ...(status !== undefined && { status }),
    });
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return causes;
}

/**
 * The shared error model: a `type` and `source` on every instance, a `dependency`
 * for remote failures, a `code` for conditions precise enough to name, JSON-safe
 * `facts`, and a retry policy derived from the classification. `message` is internal
 * detail, never end-user text (see `createPublicErrorView()`).
 *
 * `MuxAiError` is built on it, and consumers can build their own errors on it with
 * their own type list, code catalog and dependencies, so policy, serialization and
 * the public view work the same way everywhere. A subclass supplies its catalog,
 * a brand for its own `is()`, and Workflow serializer hooks built from
 * {@link serializeClassification} and {@link restoreClassification}.
 */
export class ClassifiedError<TType extends string = string, TCode extends string = string, TDependency extends string = string> extends Error {
  /** Structural brand shared by every classified error, for duck-type identification across realms. */
  readonly __classified_error = true;

  readonly type: TType;
  readonly source: MuxAiErrorSource;
  readonly dependency?: TDependency;
  readonly code?: TCode;
  readonly facts: MuxAiErrorFacts;

  /** Whether submitting the same job again, unchanged, may succeed. Always true when transient. */
  readonly retryable: boolean;

  /**
   * Whether the step runner should retry the step. Workflow DevKit skips retries
   * for errors named `FatalError`, so only non-transient errors take that name.
   */
  readonly transient: boolean;

  /** Raw cause; non-enumerable, local only. */
  declare readonly cause?: unknown;

  /** Bounded summary of the cause chain; non-enumerable, crosses step boundaries. */
  declare readonly causes: ErrorCauseSummary[];

  constructor(
    message: string,
    init: ClassifiedErrorInit<TType, TCode, TDependency>,
    catalog: Readonly<Partial<Record<TCode, ErrorCatalogEntry<TType, TDependency>>>>,
  ) {
    super(message);
    const entry = init.code ? catalog[init.code] : undefined;
    this.type = entry?.type ?? init.type!;
    this.source = entry?.source ?? init.source!;
    const dependency = init.dependency ?? entry?.dependency;
    if (dependency) {
      this.dependency = dependency;
    }
    if (init.code) {
      this.code = init.code;
    }
    this.facts = init.facts ?? {};
    // The site's value wins, then the code's, then the default from the classification.
    this.transient = init.transient ?? entry?.transient ?? defaultTransient(this.source, this.facts);
    // Transient implies retryable: if a step retry may succeed, so may resubmitting.
    this.retryable = this.transient || (init.retryable ?? entry?.retryable ?? defaultRetryable(this.type, this.source, false));
    this.name = this.transient ? "Error" : "FatalError";
    if (init.cause !== undefined) {
      Object.defineProperty(this, "cause", { value: init.cause, writable: true, configurable: true });
    }
    Object.defineProperty(this, "causes", { value: summarizeCauses(init.cause), writable: true, configurable: true });
  }

  /** Whether `value` is any classified error, from this copy of the SDK or another. */
  static isClassified(value: unknown): value is ClassifiedError {
    return (
      typeof value === "object" &&
      value !== null &&
      "__classified_error" in value &&
      value.__classified_error === true
    );
  }
}

/** The classification of `error`, for a subclass's `WORKFLOW_SERIALIZE` hook. */
export function serializeClassification<TType extends string, TCode extends string, TDependency extends string>(
  error: ClassifiedError<TType, TCode, TDependency>,
): SerializedClassification<TType, TCode, TDependency> {
  return {
    message: error.message,
    type: error.type,
    source: error.source,
    ...(error.dependency && { dependency: error.dependency }),
    ...(error.code && { code: error.code }),
    facts: error.facts,
    retryable: error.retryable,
    transient: error.transient,
    causes: error.causes,
    stack: error.stack,
  };
}

/**
 * The constructor options that rebuild a serialized classification, for a
 * subclass's `WORKFLOW_DESERIALIZE` hook; follow with {@link restoreClassification}.
 * The stored classification wins over the catalog's current mapping for a code.
 */
export function classificationInit<TType extends string, TCode extends string, TDependency extends string>(
  record: SerializedClassification<TType, TCode, TDependency>,
): ClassifiedErrorInit<TType, TCode, TDependency> {
  // A stored classification satisfied the source/dependency rule when it was written.
  return {
    type: record.type,
    source: record.source,
    dependency: record.dependency,
    facts: record.facts,
    retryable: record.retryable,
    transient: record.transient,
  } as ClassifiedErrorInit<TType, TCode, TDependency>;
}

/** Restores what the constructor can't take back: the code, the cause summaries and the stack. */
export function restoreClassification<T extends ClassifiedError>(error: T, record: SerializedClassification): T {
  if (record.code) {
    Object.assign(error, { code: record.code });
  }
  Object.defineProperty(error, "causes", { value: record.causes, writable: true, configurable: true });
  if (record.stack !== undefined) {
    error.stack = record.stack;
  }
  return error;
}

/**
 * A classified @mux/ai failure, built on {@link ClassifiedError} with the SDK's
 * catalog. `message` is internal detail for developers and logs, never end-user
 * text: render what end users see with `toPublicError()`, which only exposes
 * allowlisted codes and facts. See docs/ERRORS.md.
 *
 * Fields, not subclasses, carry the classification: a custom Workflow codec keeps
 * them across step boundaries, and every subclass revives as `MuxAiError`.
 */
export class MuxAiError extends ClassifiedError<MuxAiErrorType, MuxAiErrorCode, MuxAiErrorDependency> {
  /** Structural brand for duck-type identification across copies of the SDK. */
  readonly __mux_ai_error = true;

  declare usage?: TokenUsage;
  declare diagnostics?: ModelCallDiagnostics;

  constructor(message: string, init: MuxAiErrorInit) {
    super(message, init, MUX_AI_ERROR_CATALOG);
  }

  static is(value: unknown): value is MuxAiError {
    return (
      typeof value === "object" &&
      value !== null &&
      "__mux_ai_error" in value &&
      value.__mux_ai_error === true
    );
  }

  // Subclasses with their own codec (LegacyMuxAiError) write their own shape.
  static [WORKFLOW_SERIALIZE](instance: MuxAiError): SerializedMuxAiError | LegacySerializedMuxAiError {
    const incomplete = instance as MuxAiError & { finishReason?: string; rawFinishReason?: string };
    return {
      v: 2,
      ...serializeClassification(instance),
      usage: getErrorTokenUsage(instance),
      finishReason: incomplete.finishReason,
      rawFinishReason: incomplete.rawFinishReason,
      diagnostics: instance.diagnostics,
    };
  }

  static [WORKFLOW_DESERIALIZE](value: SerializedMuxAiError): MuxAiError {
    // Subclasses inherit this codec. Restore their fields for structural guards
    // without depending on subclass constructor signatures or raw causes.
    // The stored classification matched the catalog when it was written.
    const error = restoreClassification(new MuxAiError(value.message, classificationInit(value) as MuxAiErrorInit), value);
    Object.assign(error, {
      usage: value.usage,
      diagnostics: value.diagnostics,
      ...(value.finishReason !== undefined && { finishReason: value.finishReason }),
      ...(value.rawFinishReason !== undefined && { rawFinishReason: value.rawFinishReason }),
    });
    return error;
  }
}

/**
 * Extract a human-readable detail from an unknown thrown value.
 *
 * An error thrown inside a Workflow DevKit step crosses a VM/serialization
 * boundary before it reaches a workflow-level catch, arriving as a plain
 * object that fails `instanceof Error` but still carries a `message` string.
 * Duck-typing `message` avoids collapsing the real cause (e.g. "fetch failed")
 * to "Unknown error".
 */
export function extractErrorDetail(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return "Unknown error";
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/g;
const URL_QUERY = /^([^?#]+)[?#].*$/s;

/**
 * Drops the query string, fragment and any credentials (`user:password@`) from every
 * URL in `text`. Signed Mux and presigned S3 URLs carry their tokens in the query; the
 * host and path stay for debugging, and a URL with nothing to drop is left as it is.
 */
export function stripUrlQueries(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    let url: URL;
    try {
      url = new URL(match);
    } catch {
      // Not a parseable URL: still drop anything after `?` or `#`.
      return match.replace(URL_QUERY, "$1?…");
    }
    if (!url.username && !url.password && !url.search && !url.hash) {
      return match;
    }
    return `${url.origin}${url.pathname}${url.search || url.hash ? "?…" : ""}`;
  });
}

/**
 * Prepares free text from a dependency (a provider's failure reason, a raw error
 * message) for an error's facts: URL tokens stripped, high-confidence prompt leaks
 * suppressed, length capped.
 */
export function errorDetailFact(text: string, maxLength = 500): string {
  return scrubDetail(text).slice(0, maxLength);
}

/**
 * Scrubs a raw error detail for **high-confidence** signs of a system-prompt leak
 * before it is kept on an error (message or cause summary). Rationale: the AI SDK
 * and some providers include the offending model output in their error messages
 * (e.g. "Failed to parse structured output: { reasoning: '<role>…' }"). If an
 * injection payload caused the parse failure, the raw output would otherwise bypass
 * the free-text scrubber and reach the caller through the error channel.
 *
 * Only the `canary` and `prompt_tag` detectors trigger suppression here — they
 * have very low false-positive rates. The `encoded_blob` heuristic is
 * intentionally NOT applied to error messages: legitimate upstream errors from
 * infrastructure (S3 errors containing ETags, git errors containing SHAs, AWS
 * request IDs, content hashes) can match the encoded-blob shape without being a
 * prompt leak. Suppressing those would erase useful debugging information with no
 * security benefit, because an attacker exfiltrating through a shaped blob would
 * trigger the much stronger field-level scrubber on the preceding model output.
 */
function scrubDetail(detail: string, context?: string): string {
  const leakReason = detectLeakReason(detail);
  if (leakReason !== "canary" && leakReason !== "prompt_tag") {
    return stripUrlQueries(detail);
  }
  console.warn(`[@mux/ai] Suppressed suspected prompt leak in error detail${context ? ` (context: ${context})` : ""} (reason: ${leakReason}).`);
  return "Upstream error details suppressed by safety filter";
}

/**
 * Re-throws a classified error unchanged, merging any `facts` into it (its own
 * values win). Anything else becomes an `internal` error: a remote failure would
 * already have been classified where the call was made, so what reaches here
 * unclassified is this code's own failure.
 *
 * Use this in catch blocks that re-throw, so a classified error from a callee
 * keeps its classification. Token usage carries over either way.
 */
export function wrapError(error: unknown, message: string, facts?: MuxAiErrorFacts): never {
  if (MuxAiError.is(error)) {
    if (facts) {
      Object.assign(error, { facts: { ...facts, ...error.facts } });
    }
    throw error;
  }
  const wrapped = new MuxAiError(`${message}: ${scrubDetail(extractErrorDetail(error), message)}`, {
    type: MUX_AI_ERROR_TYPES.SERVER_ERROR,
    source: MUX_AI_ERROR_SOURCES.INTERNAL,
    facts,
    cause: error,
  });
  // Carry `usage` through wrapping so failed workflows still report tokens burned.
  const usage = getErrorTokenUsage(error);
  if (usage) {
    wrapped.usage = usage;
  }
  throw wrapped;
}

/**
 * This code's own failure: a broken invariant, an unexpected shape it produced, or
 * an in-process library throwing. Use it instead of `throw new Error(...)`.
 */
export function internalError(message: string, facts?: MuxAiErrorFacts, cause?: unknown): MuxAiError {
  return new MuxAiError(message, {
    type: MUX_AI_ERROR_TYPES.SERVER_ERROR,
    source: MUX_AI_ERROR_SOURCES.INTERNAL,
    facts,
    cause,
  });
}

/** Exhaustiveness guard for switch statements over closed unions. */
export function assertNever(value: never, what = "value"): never {
  throw internalError(`Unexpected ${what}: ${String(value)}`);
}
