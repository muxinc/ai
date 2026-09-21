import type { AssetTextTrack, MuxAsset, WorkflowCredentialsInput } from "../types.ts";

import { isUndeterminedLanguageCode, toISO639_1 } from "./language-codes.ts";
import { MuxAiError } from "./mux-ai-error.ts";
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

export type TextTrackReplacementPlan =
  { kind: "clear" } |
  { kind: "blocked"; reason: string; tracks: TextTrackSummary[] } |
  { kind: "replace"; toDelete: TextTrackSummary[] };

/**
 * Every variant carries `deleted`: a `blocked` result can follow deletes when a
 * conflicting track appears between the first pass and the duplicate-name retry,
 * so callers must check it before assuming nothing was removed.
 */
export type ReplaceAndCreateTextTrackResult =
  { kind: "created"; trackId: string; deleted: TextTrackSummary[] } |
  { kind: "blocked"; reason: string; tracks: TextTrackSummary[]; deleted: TextTrackSummary[] } |
  { kind: "create_failed"; reason: string; deleted: TextTrackSummary[] };

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

function describeTracks(tracks: AssetTextTrack[]): string {
  return tracks
    .map(track => `${track.name ?? "(unnamed)"} [${track.language_code ?? "?"}, ${track.type === "audio" ? (track.primary ? "primary audio" : "audio") : (track.text_source ?? "unknown source")}, ${track.status ?? "ready"}]`)
    .join("; ");
}

/**
 * Decides which existing tracks stand in the way of `target` and what `policy`
 * says to do about them. Pure: pass the freshest asset you have.
 *
 * `keepTrackIds` marks tracks that are allowed to coexist with the new one and
 * are never treated as conflicts. edit-captions uses it under `fail` to keep
 * the source track it is editing.
 *
 * A conflicting primary audio track always blocks: Mux refuses to delete it and
 * it is the customer's original audio.
 */
export function planTextTrackReplacement(
  asset: MuxAsset,
  target: TextTrackTarget,
  policy: ReplaceExistingTracksPolicy,
  options: { keepTrackIds?: string[] } = {},
): TextTrackReplacementPlan {
  const label = targetType(target) === "audio" ? "Audio" : "Text";
  const keep = new Set(options.keepTrackIds ?? []);
  const conflicts = new Map<string, AssetTextTrack>();
  for (const track of [...findSameLanguageTextTracks(asset, target), ...findNameCollisionTextTracks(asset, target)]) {
    if (!keep.has(track.id!)) {
      conflicts.set(track.id!, track);
    }
  }
  const conflicting = [...conflicts.values()];

  if (conflicting.length === 0) {
    return { kind: "clear" };
  }

  if (policy === "fail") {
    return {
      kind: "blocked",
      reason: `${label} track(s) already exist for language '${target.languageCode}' or name '${target.name}': ${describeTracks(conflicting)}. Set replaceExistingTracks to replace them.`,
      tracks: conflicting.map(summarizeTextTrack),
    };
  }

  const primary = conflicting.filter(track => track.type === "audio" && track.primary === true);
  if (primary.length > 0) {
    return {
      kind: "blocked",
      reason: `The asset's primary audio track is in the way for language '${target.languageCode}' or name '${target.name}': ${describeTracks(primary)}. Primary audio cannot be replaced; choose a different trackName.`,
      tracks: primary.map(summarizeTextTrack),
    };
  }

  if (policy === "replace_generated") {
    const notGenerated = conflicting.filter(track => track.type !== "text" || !isMuxGeneratedTextTrack(track));
    if (notGenerated.length > 0) {
      return {
        kind: "blocked",
        reason: `${label} track(s) that are not Mux-generated exist for language '${target.languageCode}' or name '${target.name}': ${describeTracks(notGenerated)}. Use replaceExistingTracks: "replace_all" to replace them.`,
        tracks: notGenerated.map(summarizeTextTrack),
      };
    }
  }

  return { kind: "replace", toDelete: conflicting.map(summarizeTextTrack) };
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

/** Default audit tag written to `passthrough` on tracks created by `@mux/ai`. */
export function buildMuxAiTrackPassthrough(workflow: string): string {
  return JSON.stringify({ mux_ai: { workflow } });
}

export function validateTrackPassthrough(passthrough: string | undefined): string | undefined {
  if (passthrough !== undefined && passthrough.length > MUX_TRACK_PASSTHROUGH_MAX_CHARS) {
    throw new MuxAiError(
      `Track passthrough must be at most ${MUX_TRACK_PASSTHROUGH_MAX_CHARS} characters (received ${passthrough.length}).`,
      { type: "validation_error" },
    );
  }
  return passthrough;
}

// ─────────────────────────────────────────────────────────────────────────────
// Steps
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchVttFromMux(vttUrl: string): Promise<string> {
  "use step";

  const vttResponse = await fetch(vttUrl);
  if (!vttResponse.ok) {
    throw new Error(`Failed to fetch VTT file: ${vttResponse.statusText}`);
  }

  return vttResponse.text();
}

export interface CreateTextTrackOptions {
  closedCaptions?: boolean;
  passthrough?: string;
}

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
  const trackResponse = await mux.video.assets.createTrack(assetId, {
    type: "text",
    text_type: "subtitles",
    language_code: languageCode,
    name: trackName,
    url: presignedUrl,
    closed_captions: options.closedCaptions,
    passthrough: options.passthrough,
  });

  if (!trackResponse.id) {
    throw new Error("Failed to create text track: no track ID returned from Mux");
  }

  return trackResponse.id;
}

export interface ReplaceAndCreateTextTrackInput {
  assetId: string;
  target: TextTrackTarget;
  policy: ReplaceExistingTracksPolicy;
  presignedUrl: string;
  /** Text tracks only. */
  closedCaptions?: boolean;
  passthrough?: string;
  /** Tracks that may coexist with the new one; see `planTextTrackReplacement`. */
  keepTrackIds?: string[];
  credentials?: WorkflowCredentialsInput;
}

export type ReplaceAndCreateTrackInput = ReplaceAndCreateTextTrackInput;

/**
 * Fetches the asset fresh, deletes whatever `policy` allows, then creates the
 * new track of `target.type` (default `text`). Known outcomes come back as
 * discriminated results rather than throws so callers can react (Workflow
 * DevKit turns repeated step throws into a FatalError).
 *
 * The only throw is a failed asset fetch before anything has been deleted,
 * which is safe to retry. Once a track has been deleted every failure, Mux or
 * otherwise, is returned as `create_failed` with the `deleted` list so the
 * caller can restore what was removed.
 *
 * A duplicate-name rejection on create is retried once after re-planning
 * against a fresh asset, which covers a track appearing between the plan and
 * the create.
 */
export async function replaceAndCreateTrack(input: ReplaceAndCreateTextTrackInput): Promise<ReplaceAndCreateTextTrackResult> {
  "use step";
  const muxClient = await resolveMuxClient(input.credentials);
  const mux = await muxClient.createClient();
  const type = targetType(input.target);
  const deleted: TextTrackSummary[] = [];

  const failed = (error: unknown): Extract<ReplaceAndCreateTextTrackResult, { kind: "create_failed" }> => ({
    kind: "create_failed",
    reason: error instanceof Error ? error.message : String(error),
    deleted,
  });

  const clearConflicts = async (): Promise<Exclude<ReplaceAndCreateTextTrackResult, { kind: "created" }> | undefined> => {
    let asset: MuxAsset;
    try {
      asset = await mux.video.assets.retrieve(input.assetId);
    } catch (error) {
      if (deleted.length === 0) {
        throw error;
      }
      return failed(error);
    }
    const plan = planTextTrackReplacement(asset, input.target, input.policy, { keepTrackIds: input.keepTrackIds });
    if (plan.kind === "blocked") {
      return { ...plan, deleted };
    }
    if (plan.kind === "replace") {
      for (const track of plan.toDelete) {
        try {
          await mux.video.assets.deleteTrack(input.assetId, track.id);
          deleted.push(track);
        } catch (error) {
          if (!isNotFoundError(error)) {
            return failed(error);
          }
        }
      }
    }
    return undefined;
  };

  const create = async (): Promise<string> => {
    const track = await mux.video.assets.createTrack(input.assetId, {
      type,
      ...(type === "text" ? { text_type: "subtitles", closed_captions: input.closedCaptions } : {}),
      language_code: input.target.languageCode,
      name: input.target.name.trim(),
      url: input.presignedUrl,
      passthrough: input.passthrough,
    });
    if (!track.id) {
      throw new Error(`Failed to create ${type} track: no track ID returned from Mux`);
    }
    return track.id;
  };

  const stopped = await clearConflicts();
  if (stopped) {
    return stopped;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { kind: "created", trackId: await create(), deleted };
    } catch (error) {
      if (isDuplicateTrackNameError(error) && attempt === 0) {
        const stoppedOnRetry = await clearConflicts();
        if (stoppedOnRetry) {
          return stoppedOnRetry;
        }
        continue;
      }
      return failed(error);
    }
  }

  return { kind: "create_failed", reason: "Mux rejected the track name as not unique after retrying.", deleted };
}

/** `replaceAndCreateTrack` pinned to text tracks. */
export async function replaceAndCreateTextTrack(input: ReplaceAndCreateTextTrackInput): Promise<ReplaceAndCreateTextTrackResult> {
  "use step";
  return replaceAndCreateTrack({ ...input, target: { ...input.target, type: "text" } });
}
