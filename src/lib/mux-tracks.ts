import type { AssetTextTrack, MuxAsset, WorkflowCredentialsInput } from "../types.ts";

import { requestIdOf } from "./dependency-error.ts";
import { isUndeterminedLanguageCode, toISO639_1 } from "./language-codes.ts";
import { LegacyMuxAiError } from "./legacy-mux-ai-error.ts";
import type { ClassifiedErrorsOption, MuxAiErrorFacts, MuxAiErrorFactValue } from "./mux-ai-error.ts";
import { errorDetailFact, MUX_AI_ERROR_CODES, MUX_AI_ERROR_SOURCES, MUX_AI_ERROR_TYPES, MuxAiError } from "./mux-ai-error.ts";
import { missingTrackIdError, muxVideoCallError, muxVideoError } from "./mux-video-errors.ts";
import { currentStepAttempt, MUX_VIDEO_RATE_LIMIT_POLICY, rateLimitStepRetry } from "./rate-limit.ts";
import { resolveMuxClient } from "./workflow-credentials.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a workflow treats tracks that already exist on the asset when it is
 * about to create a new one.
 *
 * - `fail`: stop before doing any work if a same-language or same-name track exists.
 * - `replace_all`: delete every same-language and same-name track first.
 * - `replace_generated`: delete Mux-generated (ASR) tracks; stop if any other track is in the way.
 *   Audio tracks are never Mux-generated, so for audio this behaves like `fail`.
 */
export type ReplaceExistingTracksPolicy = "fail" | "replace_all" | "replace_generated";

/**
 * How a workflow that edits an existing track treats that source track.
 *
 * - `replace`: delete the source and create the new track in its place. No other track is deleted.
 * - `fail`: delete nothing; the new track is added alongside the source and must have a different name.
 *
 * Only name collisions count: the new track is always in the source's language.
 */
export type SourceTrackReplacementPolicy = "replace" | "fail";

/** Mux track types that share a name-uniqueness group among themselves. */
export type ReplaceableTrackType = "text" | "audio";

/** The `(type, language_code, name)` a workflow is about to write to Mux. `type` defaults to `text`. */
export interface TextTrackTarget {
  languageCode: string;
  name: string;
  type?: ReplaceableTrackType;
}

export type TrackTarget = TextTrackTarget;

/** Serializable description of a track, safe to return across step boundaries. */
export interface TextTrackSummary {
  id: string;
  type?: ReplaceableTrackType;
  name?: string;
  languageCode?: string;
  status?: string;
  textSource?: string;
  passthrough?: string;
  /** Audio only: the asset's original audio, which Mux refuses to delete. */
  primary?: boolean;
}

export type TrackSummary = TextTrackSummary;

/**
 * Why a replacement was blocked:
 *
 * - `policy_fail`: the `fail` policy and a conflicting track exists.
 * - `not_generated`: `replace_generated` and a conflicting track is not Mux-generated.
 * - `name_collision`: another track already has the target's name.
 * - `primary_audio`: the asset's primary audio track conflicts; it can never be replaced.
 */
export type TrackReplacementBlockedReason = "policy_fail" | "not_generated" | "name_collision" | "primary_audio";

export interface TrackReplacementBlocked {
  kind: "blocked";
  /** Human-readable explanation naming the conflicting tracks. */
  reason: string;
  /** Machine-readable reason for the block. */
  code: TrackReplacementBlockedReason;
  /** The conflicting tracks. */
  tracks: TextTrackSummary[];
  /** Whether any conflicting track matched on language (rather than only on name). */
  conflictsOnLanguage: boolean;
}

export type TextTrackReplacementPlan =
  { kind: "clear" } |
  TrackReplacementBlocked |
  { kind: "replace"; toDelete: TextTrackSummary[] };

/**
 * Every variant carries `deleted`: a `blocked` result can follow deletes when a
 * conflicting track appears between the first pass and the duplicate-name retry,
 * so callers must check it before assuming nothing was removed.
 */
export type ReplaceAndCreateTextTrackResult =
  { kind: "created"; trackId: string; deleted: TextTrackSummary[] } |
  (TrackReplacementBlocked & { deleted: TextTrackSummary[] }) |
  TrackWriteFailed;

/** A Mux failure while writing a track. */
export interface TrackWriteFailed {
  kind: "create_failed";
  /** The raw error's message. Internal detail, not end-user text. */
  reason: string;
  deleted: TextTrackSummary[];
  /**
   * With `classifiedErrors`, the failure classified inside the step, while the raw error
   * was still in hand: it crosses the step boundary with its status, request id, Mux's
   * error type and a scrubbed cause summary.
   */
  error?: MuxAiError;
}

/**
 * The error for a failed track write, as a workflow that opted in to classified errors
 * throws it: the classified `error` the step returned, or `track_write_unclassified` if
 * it is missing, which would be a bug in the track-write path.
 */
export function trackWriteFailure(outcome: TrackWriteFailed): MuxAiError {
  return outcome.error ?? new MuxAiError(`Track write failed without a classified error: ${outcome.reason}`, {
    code: MUX_AI_ERROR_CODES.TRACK_WRITE_UNCLASSIFIED,
    type: MUX_AI_ERROR_TYPES.SERVER_ERROR,
    source: MUX_AI_ERROR_SOURCES.INTERNAL,
    facts: { reason: errorDetailFact(outcome.reason) },
  });
}

/** Mux caps track `passthrough` at 255 characters. */
export const MUX_TRACK_PASSTHROUGH_MAX_CHARS = 255;

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalizes a track language code for matching: lowercase, ISO 639-3 → 639-1,
 * primary subtag only (`en-US` → `en`). Returns `undefined` for codes that must
 * never match anything (`auto`, `und`, `mul`, `mis`, `zxx`, empty).
 */
export function normalizeTrackLanguageCode(code: string | undefined): string | undefined {
  if (!code) {
    return undefined;
  }
  const primarySubtag = code.trim().toLowerCase().split(/[-_]/)[0];
  if (!primarySubtag || primarySubtag === "auto" || isUndeterminedLanguageCode(primarySubtag)) {
    return undefined;
  }
  return toISO639_1(primarySubtag);
}

/** Normalizes a track name the way Mux compares them: trimmed, case-insensitive. */
export function normalizeTrackName(name: string | undefined): string | undefined {
  const normalized = name?.trim().toLowerCase();
  return normalized || undefined;
}

export function isMuxGeneratedTextTrack(track: AssetTextTrack): boolean {
  return track.text_source === "generated_vod" ||
    track.text_source === "generated_live" ||
    track.text_source === "generated_live_final";
}

function targetType(target: TextTrackTarget): ReplaceableTrackType {
  return target.type ?? "text";
}

function listTracks(asset: MuxAsset, type: ReplaceableTrackType): AssetTextTrack[] {
  return (asset.tracks ?? []).filter(track => track.type === type && track.status !== "deleted" && !!track.id);
}

export function summarizeTextTrack(track: AssetTextTrack): TextTrackSummary {
  return {
    id: track.id!,
    type: track.type === "audio" ? "audio" : "text",
    name: track.name,
    languageCode: track.language_code,
    status: track.status,
    textSource: track.text_source,
    passthrough: track.passthrough,
    ...(track.type === "audio" ? { primary: track.primary === true } : {}),
  };
}

/**
 * Tracks of the target's type whose language matches the target's, in any
 * status but `deleted`. Text tracks must be subtitles; audio tracks match on
 * language alone.
 */
export function findSameLanguageTextTracks(asset: MuxAsset, target: TextTrackTarget): AssetTextTrack[] {
  const targetLanguage = normalizeTrackLanguageCode(target.languageCode);
  if (!targetLanguage) {
    return [];
  }
  const type = targetType(target);
  return listTracks(asset, type).filter(track =>
    (type === "audio" || track.text_type === "subtitles") &&
    normalizeTrackLanguageCode(track.language_code) === targetLanguage,
  );
}

/** Tracks of the target's type whose name collides with the target's under Mux's uniqueness rule. */
export function findNameCollisionTextTracks(asset: MuxAsset, target: TextTrackTarget): AssetTextTrack[] {
  const targetName = normalizeTrackName(target.name);
  if (!targetName) {
    return [];
  }
  return listTracks(asset, targetType(target)).filter(track => normalizeTrackName(track.name) === targetName);
}

/** `A text track` / `2 text tracks`, with the verb agreeing, so messages read naturally for one match or several. */
function countTracks(tracks: AssetTextTrack[], label: string, singularVerb: string, pluralVerb: string): string {
  const kind = label.toLowerCase();
  if (tracks.length === 1) {
    return `${kind === "audio" ? "An" : "A"} ${kind} track ${singularVerb}`;
  }
  return `${tracks.length} ${kind} tracks ${pluralVerb}`;
}

function itOrThem(tracks: AssetTextTrack[]): string {
  return tracks.length === 1 ? "it" : "them";
}

function describeTracks(tracks: AssetTextTrack[]): string {
  return describeTrackSummaries(tracks.map(summarizeTextTrack));
}

/** e.g. `English [en, uploaded, ready]; Spanish [es, generated_vod, ready]`. */
export function describeTrackSummaries(tracks: TextTrackSummary[]): string {
  return tracks
    .map(track => `${track.name ?? "(unnamed)"} [${track.languageCode ?? "?"}, ${track.type === "audio" ? (track.primary ? "primary audio" : "audio") : (track.textSource ?? "unknown source")}, ${track.status ?? "ready"}]`)
    .join("; ");
}

/**
 * Decides which existing tracks stand in the way of `target` and what `policy`
 * says to do about them. Pure: pass the freshest asset you have.
 *
 * A conflicting primary audio track always blocks: Mux refuses to delete it and
 * it is the customer's original audio.
 */
export function planTextTrackReplacement(
  asset: MuxAsset,
  target: TextTrackTarget,
  policy: ReplaceExistingTracksPolicy,
): TextTrackReplacementPlan {
  const label = targetType(target) === "audio" ? "Audio" : "Text";
  const sameLanguage = findSameLanguageTextTracks(asset, target);
  const sameLanguageIds = new Set(sameLanguage.map(track => track.id!));
  const conflicts = new Map<string, AssetTextTrack>();
  for (const track of [...sameLanguage, ...findNameCollisionTextTracks(asset, target)]) {
    conflicts.set(track.id!, track);
  }
  const conflicting = [...conflicts.values()];

  if (conflicting.length === 0) {
    return { kind: "clear" };
  }

  const blocked = (code: TrackReplacementBlockedReason, reason: string, tracks: AssetTextTrack[]): TrackReplacementBlocked => ({
    kind: "blocked",
    reason,
    code,
    tracks: tracks.map(summarizeTextTrack),
    conflictsOnLanguage: tracks.some(track => sameLanguageIds.has(track.id!)),
  });

  const primary = conflicting.filter(track => track.type === "audio" && track.primary === true);
  if (primary.length > 0) {
    return blocked(
      "primary_audio",
      `The asset's primary audio track is in the way for language '${target.languageCode}' or name '${target.name}': ${describeTracks(primary)}. Primary audio cannot be replaced; choose a different trackName.`,
      primary,
    );
  }

  if (policy === "fail") {
    return blocked(
      "policy_fail",
      `${countTracks(conflicting, label, "already exists", "already exist")} for language '${target.languageCode}' or name '${target.name}': ${describeTracks(conflicting)}. Set replaceExistingTracks to replace ${itOrThem(conflicting)}.`,
      conflicting,
    );
  }

  if (policy === "replace_generated") {
    const notGenerated = conflicting.filter(track => track.type !== "text" || !isMuxGeneratedTextTrack(track));
    if (notGenerated.length > 0) {
      return blocked(
        "not_generated",
        `${countTracks(notGenerated, label, "that is not Mux-generated exists", "that are not Mux-generated exist")} for language '${target.languageCode}' or name '${target.name}': ${describeTracks(notGenerated)}. Use replaceExistingTracks: "replace_all" to replace ${itOrThem(notGenerated)}.`,
        notGenerated,
      );
    }
  }

  return { kind: "replace", toDelete: conflicting.map(summarizeTextTrack) };
}

/** Plans an edit of `sourceTrackId` into `target`: deletes at most the source, and blocks if any other track has the target's name. */
export function planSourceTrackReplacement(
  asset: MuxAsset,
  sourceTrackId: string,
  target: TextTrackTarget,
  policy: SourceTrackReplacementPolicy,
): TextTrackReplacementPlan {
  const colliding = findNameCollisionTextTracks(asset, target);
  const blocking = policy === "fail" ? colliding : colliding.filter(track => track.id !== sourceTrackId);
  if (blocking.length > 0) {
    return {
      kind: "blocked",
      code: "name_collision",
      reason: `${countTracks(blocking, "Text", "already has", "already have")} the name '${target.name}': ${describeTracks(blocking)}. Choose a different trackName.`,
      tracks: blocking.map(summarizeTextTrack),
      conflictsOnLanguage: false,
    };
  }

  const source = policy === "replace" ? listTracks(asset, targetType(target)).find(track => track.id === sourceTrackId) : undefined;
  return source ? { kind: "replace", toDelete: [summarizeTextTrack(source)] } : { kind: "clear" };
}

/** True for Mux's `400 invalid_parameters` "Track name 'X' is not unique" rejection. */
export function isDuplicateTrackNameError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as { status?: unknown; error?: { messages?: unknown }; message?: unknown };
  if (record.status !== 400) {
    return false;
  }
  const messages = Array.isArray(record.error?.messages) ? record.error.messages : [];
  const haystack = [...messages, record.message]
    .filter((value): value is string => typeof value === "string")
    .map(value => value.toLowerCase());
  return haystack.some(value => value.includes("is not unique"));
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

function trackFacts(track: TextTrackSummary): MuxAiErrorFactValue {
  return Object.fromEntries(
    Object.entries({
      id: track.id,
      type: track.type,
      name: track.name,
      languageCode: track.languageCode,
      status: track.status,
      textSource: track.textSource,
      primary: track.primary,
    }).filter(([, value]) => value !== undefined),
  ) as MuxAiErrorFactValue;
}

/** The track a write was for, as error facts: `trackType`, `languageCode` and `trackName`. */
export function trackTargetFacts(target: TextTrackTarget): MuxAiErrorFacts {
  return {
    trackType: targetType(target),
    languageCode: target.languageCode,
    ...(target.name !== undefined && { trackName: target.name }),
  };
}

/** JSON-safe summaries of `tracks` for error facts. */
export function trackSummaryFacts(tracks: TextTrackSummary[]): MuxAiErrorFactValue[] {
  return tracks.map(trackFacts);
}

/**
 * The error for a blocked replacement plan or outcome. The caller chose the policy
 * and the name, so it is `track_replacement_blocked` (`request`), except the
 * asset's primary audio in the target's language: no option avoids that, so it is
 * the `asset`'s.
 */
export function trackReplacementBlockedError(
  blocked: Pick<TrackReplacementBlocked, "reason" | "code" | "tracks" | "conflictsOnLanguage">,
  options: { message?: string; facts?: MuxAiErrorFacts } = {},
): MuxAiError {
  const message = options.message ?? blocked.reason;
  const facts: MuxAiErrorFacts = {
    ...options.facts,
    reason: blocked.code,
    conflictingTracks: trackSummaryFacts(blocked.tracks),
  };
  if (blocked.code === "primary_audio" && blocked.conflictsOnLanguage) {
    return new MuxAiError(message, {
      code: MUX_AI_ERROR_CODES.PRIMARY_AUDIO_TRACK_CONFLICT,
      type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
      source: MUX_AI_ERROR_SOURCES.ASSET,
      facts,
    });
  }
  return new MuxAiError(message, {
    code: MUX_AI_ERROR_CODES.TRACK_REPLACEMENT_BLOCKED,
    type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
    source: MUX_AI_ERROR_SOURCES.REQUEST,
    facts,
  });
}

/** Default audit tag written to `passthrough` on tracks created by `@mux/ai`. */
export function buildMuxAiTrackPassthrough(workflow: string): string {
  return JSON.stringify({ mux_ai: { workflow } });
}

export function validateTrackPassthrough(passthrough: string | undefined, options: ClassifiedErrorsOption = {}): string | undefined {
  if (passthrough !== undefined && passthrough.length > MUX_TRACK_PASSTHROUGH_MAX_CHARS) {
    const message = `Track passthrough must be at most ${MUX_TRACK_PASSTHROUGH_MAX_CHARS} characters (received ${passthrough.length}).`;
    if (!options.classifiedErrors) {
      throw new LegacyMuxAiError(message, { type: "validation_error" });
    }
    throw new MuxAiError(message, {
      code: MUX_AI_ERROR_CODES.INVALID_PARAMETER,
      type: MUX_AI_ERROR_TYPES.VALIDATION_ERROR,
      source: MUX_AI_ERROR_SOURCES.REQUEST,
      facts: { parameter: "trackPassthrough", reason: "too_long", length: passthrough.length, maxLength: MUX_TRACK_PASSTHROUGH_MAX_CHARS, inputs: ["trackPassthrough"] },
    });
  }
  return passthrough;
}

// ─────────────────────────────────────────────────────────────────────────────
// Steps
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchVttFromMux(vttUrl: string, options: ClassifiedErrorsOption = {}): Promise<string> {
  "use step";

  if (!options.classifiedErrors) {
    const vttResponse = await fetch(vttUrl);
    if (!vttResponse.ok) {
      throw new Error(`Failed to fetch VTT file: ${vttResponse.statusText}`);
    }
    return vttResponse.text();
  }

  // The URL may carry a signed playback token, so it stays out of messages and facts.
  let vttResponse: Response;
  try {
    vttResponse = await fetch(vttUrl);
  } catch (error) {
    throw muxVideoError("Failed to fetch VTT file from Mux", { call: "fetch_vtt", cause: error });
  }
  if (!vttResponse.ok) {
    throw muxVideoError(`Failed to fetch VTT file from Mux (HTTP ${vttResponse.status})`, {
      call: "fetch_vtt",
      status: vttResponse.status,
      requestId: requestIdOf(vttResponse.headers),
    });
  }
  try {
    return await vttResponse.text();
  } catch (error) {
    // The body failed mid-read (e.g. a reset connection): treated as no response, so transient.
    throw muxVideoError("Failed to read VTT file from Mux", { call: "fetch_vtt", cause: error });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Track writes
//
// Each Mux write that can be rate limited is its own Workflow DevKit step, after the
// caller's paid work: a 429 is waited out by rerunning just that step (see
// `./rate-limit.ts`), and what earlier steps did (the deleted tracks) is kept in the event
// log. The composed writes (`replaceAndCreateTrack` and friends) are not steps: call them
// from a workflow body. Called from inside a step, their steps run inline as plain
// functions, and a rate-limit retry reruns the caller's whole step instead.
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateTextTrackOptions {
  closedCaptions?: boolean;
  passthrough?: string;
}

/**
 * Creates a text track, and nothing else. A Mux 429 is waited out at this step's boundary
 * (`MUX_VIDEO_RATE_LIMIT_POLICY`); any other failure throws classified, as before.
 */
export async function createTextTrackOnMux(
  assetId: string,
  languageCode: string,
  trackName: string,
  presignedUrl: string,
  credentials?: WorkflowCredentialsInput,
  options: CreateTextTrackOptions = {},
): Promise<string> {
  "use step";
  const muxClient = await resolveMuxClient(credentials);
  const mux = await muxClient.createClient();
  let trackResponse: Awaited<ReturnType<typeof mux.video.assets.createTrack>>;
  try {
    trackResponse = await mux.video.assets.createTrack(assetId, {
      type: "text",
      text_type: "subtitles",
      language_code: languageCode,
      name: trackName,
      url: presignedUrl,
      closed_captions: options.closedCaptions,
      passthrough: options.passthrough,
    });
  } catch (error) {
    // Classified here, while the raw error is in hand: past the step boundary only its message is left.
    const classified = muxVideoCallError("Failed to create the text track on Mux", "create_track", error, { assetId });
    throw (await rateLimitStepRetry(classified, MUX_VIDEO_RATE_LIMIT_POLICY)) ?? classified;
  }

  if (!trackResponse.id) {
    throw missingTrackIdError("Failed to create text track: no track ID returned from Mux", { assetId });
  }

  return trackResponse.id;
}
createTextTrackOnMux.maxRetries = MUX_VIDEO_RATE_LIMIT_POLICY.maxRetries;

interface CreateTrackWriteInput extends ClassifiedErrorsOption {
  assetId: string;
  target: TextTrackTarget;
  presignedUrl: string;
  /** Text tracks only. */
  closedCaptions?: boolean;
  passthrough?: string;
  credentials?: WorkflowCredentialsInput;
}

export interface ReplaceAndCreateTextTrackInput extends CreateTrackWriteInput {
  policy: ReplaceExistingTracksPolicy;
}

export type ReplaceAndCreateTrackInput = ReplaceAndCreateTextTrackInput;

export interface ReplaceSourceTrackInput extends CreateTrackWriteInput {
  /** The track being edited; see `planSourceTrackReplacement`. */
  sourceTrackId: string;
  policy: SourceTrackReplacementPolicy;
}

/**
 * Which planner a track write uses: data, not a function, because it crosses into
 * `clearTrackConflicts` as a step argument.
 */
export type TrackWritePlan =
  { kind: "target"; policy: ReplaceExistingTracksPolicy } |
  { kind: "source"; sourceTrackId: string; policy: SourceTrackReplacementPolicy };

export type ClearTrackConflictsResult =
  { kind: "clear"; deleted: TextTrackSummary[] } |
  (TrackReplacementBlocked & { deleted: TextTrackSummary[] }) |
  TrackWriteFailed;

export type CreateTrackResult =
  { kind: "created"; trackId: string } |
  { kind: "duplicate_name" } |
  Omit<TrackWriteFailed, "deleted">;

type TrackWriteCall = "get_asset" | "delete_track" | "create_track";

function trackWriteFailed(input: CreateTrackWriteInput, call: TrackWriteCall, error: unknown): Omit<TrackWriteFailed, "deleted"> {
  return {
    kind: "create_failed",
    reason: error instanceof Error ? error.message : String(error),
    ...(input.classifiedErrors && {
      error: muxVideoCallError(`Mux ${call} failed while writing the ${targetType(input.target)} track`, call, error, { assetId: input.assetId }),
    }),
  };
}

function planFor(asset: MuxAsset, target: TextTrackTarget, plan: TrackWritePlan): TextTrackReplacementPlan {
  return plan.kind === "source" ?
      planSourceTrackReplacement(asset, plan.sourceTrackId, target, plan.policy) :
      planTextTrackReplacement(asset, target, plan.policy);
}

/**
 * Plans against a fresh asset and deletes what the plan allows. Once anything has been
 * deleted, in this step or an earlier one (`afterDeletes`), a failure is returned, not
 * thrown, so the deleted tracks reach the caller. Before that, a failed fetch or delete
 * throws: rerunning the step is safe, and a 429 is waited out at the step boundary.
 */
export async function clearTrackConflicts(
  input: CreateTrackWriteInput,
  plan: TrackWritePlan,
  afterDeletes = false,
): Promise<ClearTrackConflictsResult> {
  "use step";
  const muxClient = await resolveMuxClient(input.credentials);
  const mux = await muxClient.createClient();
  const deleted: TextTrackSummary[] = [];

  const stop = async (call: TrackWriteCall, error: unknown): Promise<TrackWriteFailed> => {
    if (afterDeletes || deleted.length > 0) {
      return { ...trackWriteFailed(input, call, error), deleted };
    }
    const classified = call === "get_asset" ?
        muxVideoCallError("Failed to fetch the asset from Mux", "get_asset", error, { assetId: input.assetId }) :
        muxVideoCallError(`Mux ${call} failed while writing the ${targetType(input.target)} track`, call, error, { assetId: input.assetId });
    const retry = await rateLimitStepRetry(classified, MUX_VIDEO_RATE_LIMIT_POLICY);
    if (retry) {
      throw retry;
    }
    if (call === "get_asset") {
      throw input.classifiedErrors ? classified : error;
    }
    return { ...trackWriteFailed(input, call, error), deleted };
  };

  let asset: MuxAsset;
  try {
    asset = await mux.video.assets.retrieve(input.assetId);
  } catch (error) {
    return stop("get_asset", error);
  }
  const planned = planFor(asset, input.target, plan);
  if (planned.kind === "blocked") {
    return { ...planned, deleted };
  }
  if (planned.kind === "replace") {
    for (const track of planned.toDelete) {
      try {
        await mux.video.assets.deleteTrack(input.assetId, track.id);
        deleted.push(track);
      } catch (error) {
        if (!isNotFoundError(error)) {
          return stop("delete_track", error);
        }
      }
    }
  }
  return { kind: "clear", deleted };
}
clearTrackConflicts.maxRetries = MUX_VIDEO_RATE_LIMIT_POLICY.maxRetries;

/**
 * Creates the track of `target.type`, and nothing else. A Mux 429 is waited out at this
 * step's boundary (`MUX_VIDEO_RATE_LIMIT_POLICY`); on the last attempt it is returned as
 * `create_failed` like any other failure. Only a 429 is retried: it means Mux didn't process
 * the create, whereas after a timeout or 5xx the track may exist.
 *
 * A rerun first looks for the track a previous attempt created (same type, name and
 * `passthrough`), in case the step was cut short after Mux accepted the create.
 */
export async function createTrack(input: CreateTrackWriteInput): Promise<CreateTrackResult> {
  "use step";
  const muxClient = await resolveMuxClient(input.credentials);
  const mux = await muxClient.createClient();
  const type = targetType(input.target);
  const name = input.target.name.trim();

  if (input.passthrough && ((await currentStepAttempt()) ?? 1) > 1) {
    try {
      const asset = await mux.video.assets.retrieve(input.assetId);
      const existing = listTracks(asset, type).find(track =>
        track.name === name && track.passthrough === input.passthrough && track.status !== "errored");
      if (existing?.id) {
        return { kind: "created", trackId: existing.id };
      }
    } catch {
      // Best effort: a failed look falls through to the create, which a duplicate name would reject.
    }
  }

  try {
    const track = await mux.video.assets.createTrack(input.assetId, {
      type,
      ...(type === "text" ? { text_type: "subtitles", closed_captions: input.closedCaptions } : {}),
      language_code: input.target.languageCode,
      name,
      url: input.presignedUrl,
      passthrough: input.passthrough,
    });
    if (!track.id) {
      const message = `Failed to create ${type} track: no track ID returned from Mux`;
      return trackWriteFailed(input, "create_track", input.classifiedErrors ? missingTrackIdError(message, { assetId: input.assetId }) : new Error(message));
    }
    return { kind: "created", trackId: track.id };
  } catch (error) {
    if (isDuplicateTrackNameError(error)) {
      return { kind: "duplicate_name" };
    }
    const failed = trackWriteFailed(input, "create_track", error);
    const retry = await rateLimitStepRetry(
      failed.error ?? muxVideoCallError("Failed to create the track on Mux", "create_track", error, { assetId: input.assetId }),
      MUX_VIDEO_RATE_LIMIT_POLICY,
    );
    if (retry) {
      throw retry;
    }
    return failed;
  }
}
createTrack.maxRetries = MUX_VIDEO_RATE_LIMIT_POLICY.maxRetries;

/**
 * Deletes whatever `policy` allows against a fresh asset, then creates the new track of
 * `target.type` (default `text`), in two steps (`clearTrackConflicts`, `createTrack`). Call
 * it from a workflow body. Known outcomes come back as discriminated results rather than
 * throws so callers can react.
 *
 * The only throw is a failure before anything has been deleted, which is safe to retry.
 * Once a track has been deleted every failure is returned as `create_failed` with the
 * `deleted` list so the caller can restore what was removed. A Mux 429 on any of these
 * calls is waited out by rerunning just the step that got it.
 *
 * A duplicate-name rejection on create is retried once after re-planning against a fresh
 * asset, which covers a track appearing between the plan and the create.
 */
export async function replaceAndCreateTrack(input: ReplaceAndCreateTextTrackInput): Promise<ReplaceAndCreateTextTrackResult> {
  return writeTrack(input, { kind: "target", policy: input.policy });
}

/**
 * `replaceAndCreateTrack` for a workflow that edits an existing text track: plans
 * with `planSourceTrackReplacement`, so at most the source itself is deleted.
 * Same outcomes and retry behaviour.
 */
export async function replaceSourceTrack(input: ReplaceSourceTrackInput): Promise<ReplaceAndCreateTextTrackResult> {
  const target: TextTrackTarget = { ...input.target, type: "text" };
  return writeTrack({ ...input, target }, { kind: "source", sourceTrackId: input.sourceTrackId, policy: input.policy });
}

async function writeTrack(input: CreateTrackWriteInput, plan: TrackWritePlan): Promise<ReplaceAndCreateTextTrackResult> {
  // Step arguments are serialized: pass plain data only.
  const writeInput: CreateTrackWriteInput = {
    assetId: input.assetId,
    target: input.target,
    presignedUrl: input.presignedUrl,
    closedCaptions: input.closedCaptions,
    passthrough: input.passthrough,
    credentials: input.credentials,
    classifiedErrors: input.classifiedErrors,
  };
  const deleted: TextTrackSummary[] = [];

  for (let pass = 0; pass < 2; pass++) {
    const cleared = await clearTrackConflicts(writeInput, plan, deleted.length > 0);
    deleted.push(...cleared.deleted);
    if (cleared.kind !== "clear") {
      return { ...cleared, deleted };
    }
    const created = await createTrack(writeInput);
    if (created.kind === "created") {
      return { kind: "created", trackId: created.trackId, deleted };
    }
    if (created.kind === "create_failed") {
      return { ...created, deleted };
    }
  }

  if (!input.classifiedErrors) {
    return { kind: "create_failed", reason: "Mux rejected the track name as not unique after retrying.", deleted };
  }
  // The fresh asset showed no conflict, yet Mux still rejects the name: a conflict on
  // the chosen name, not a Mux failure.
  return {
    kind: "blocked",
    code: "name_collision",
    reason: `Mux rejected the track name '${input.target.name.trim()}' as not unique after retrying. Choose a different track name.`,
    tracks: [],
    conflictsOnLanguage: false,
    deleted,
  };
}

/** `replaceAndCreateTrack` pinned to text tracks. Call it from a workflow body. */
export async function replaceAndCreateTextTrack(input: ReplaceAndCreateTextTrackInput): Promise<ReplaceAndCreateTextTrackResult> {
  return replaceAndCreateTrack({ ...input, target: { ...input.target, type: "text" } });
}
