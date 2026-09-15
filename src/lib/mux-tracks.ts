import type { AssetTextTrack, MuxAsset, WorkflowCredentialsInput } from "../types.ts";

import { isUndeterminedLanguageCode, toISO639_1 } from "./language-codes.ts";
import { MuxAiError } from "./mux-ai-error.ts";
import { resolveMuxClient } from "./workflow-credentials.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a workflow treats text tracks that already exist on the asset when it
 * is about to create a new one.
 *
 * - `fail`: stop before doing any work if a same-language or same-name track exists.
 * - `replace_all`: delete every same-language and same-name track first.
 * - `replace_generated`: delete Mux-generated (ASR) tracks; stop if any other track is in the way.
 */
export type ReplaceExistingTracksPolicy = "fail" | "replace_all" | "replace_generated";

/** The `(language_code, name)` pair a workflow is about to write to Mux. */
export interface TextTrackTarget {
  languageCode: string;
  name: string;
}

/** Serializable description of a text track, safe to return across step boundaries. */
export interface TextTrackSummary {
  id: string;
  name?: string;
  languageCode?: string;
  status?: string;
  textSource?: string;
  passthrough?: string;
}

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

function listTextTracks(asset: MuxAsset): AssetTextTrack[] {
  return (asset.tracks ?? []).filter(track => track.type === "text" && track.status !== "deleted" && !!track.id);
}

export function summarizeTextTrack(track: AssetTextTrack): TextTrackSummary {
  return {
    id: track.id!,
    name: track.name,
    languageCode: track.language_code,
    status: track.status,
    textSource: track.text_source,
    passthrough: track.passthrough,
  };
}

/** Subtitles tracks whose language matches the target's, in any status but `deleted`. */
export function findSameLanguageTextTracks(asset: MuxAsset, target: TextTrackTarget): AssetTextTrack[] {
  const targetLanguage = normalizeTrackLanguageCode(target.languageCode);
  if (!targetLanguage) {
    return [];
  }
  return listTextTracks(asset).filter(track =>
    track.text_type === "subtitles" && normalizeTrackLanguageCode(track.language_code) === targetLanguage,
  );
}

/** Text tracks whose name collides with the target's under Mux's uniqueness rule. */
export function findNameCollisionTextTracks(asset: MuxAsset, target: TextTrackTarget): AssetTextTrack[] {
  const targetName = normalizeTrackName(target.name);
  if (!targetName) {
    return [];
  }
  return listTextTracks(asset).filter(track => normalizeTrackName(track.name) === targetName);
}

function describeTracks(tracks: AssetTextTrack[]): string {
  return tracks
    .map(track => `${track.name ?? "(unnamed)"} [${track.language_code ?? "?"}, ${track.text_source ?? "unknown source"}, ${track.status ?? "unknown status"}]`)
    .join("; ");
}

/**
 * Decides which existing text tracks stand in the way of `target` and what
 * `policy` says to do about them. Pure: pass the freshest asset you have.
 *
 * `keepTrackIds` marks tracks that are allowed to coexist with the new one and
 * are never treated as conflicts. edit-captions uses it under `fail` to keep
 * the source track it is editing.
 */
export function planTextTrackReplacement(
  asset: MuxAsset,
  target: TextTrackTarget,
  policy: ReplaceExistingTracksPolicy,
  options: { keepTrackIds?: string[] } = {},
): TextTrackReplacementPlan {
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
      reason: `Text track(s) already exist for language '${target.languageCode}' or name '${target.name}': ${describeTracks(conflicting)}. Set replaceExistingTracks to replace them.`,
      tracks: conflicting.map(summarizeTextTrack),
    };
  }

  if (policy === "replace_generated") {
    const notGenerated = conflicting.filter(track => !isMuxGeneratedTextTrack(track));
    if (notGenerated.length > 0) {
      return {
        kind: "blocked",
        reason: `Text track(s) that are not Mux-generated exist for language '${target.languageCode}' or name '${target.name}': ${describeTracks(notGenerated)}. Use replaceExistingTracks: "replace_all" to replace them.`,
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
  closedCaptions?: boolean;
  passthrough?: string;
  /** Tracks that may coexist with the new one; see `planTextTrackReplacement`. */
  keepTrackIds?: string[];
  credentials?: WorkflowCredentialsInput;
}

/**
 * Fetches the asset fresh, deletes whatever `policy` allows, then creates the
 * new text track. Known outcomes come back as discriminated results rather than
 * throws so callers can react (Workflow DevKit turns repeated step throws into
 * a FatalError). Unexpected Mux failures during the fetch or deletes still throw.
 *
 * A duplicate-name rejection on create is retried once after re-planning
 * against a fresh asset, which covers a track appearing between the plan and
 * the create.
 */
export async function replaceAndCreateTextTrack(input: ReplaceAndCreateTextTrackInput): Promise<ReplaceAndCreateTextTrackResult> {
  "use step";
  const muxClient = await resolveMuxClient(input.credentials);
  const mux = await muxClient.createClient();
  const deleted: TextTrackSummary[] = [];

  const clearConflicts = async (): Promise<Extract<ReplaceAndCreateTextTrackResult, { kind: "blocked" }> | undefined> => {
    const asset = await mux.video.assets.retrieve(input.assetId);
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
            throw error;
          }
        }
      }
    }
    return undefined;
  };

  const create = async (): Promise<string> => {
    const track = await mux.video.assets.createTrack(input.assetId, {
      type: "text",
      text_type: "subtitles",
      language_code: input.target.languageCode,
      name: input.target.name.trim(),
      url: input.presignedUrl,
      closed_captions: input.closedCaptions,
      passthrough: input.passthrough,
    });
    if (!track.id) {
      throw new Error("Failed to create text track: no track ID returned from Mux");
    }
    return track.id;
  };

  const blocked = await clearConflicts();
  if (blocked) {
    return blocked;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { kind: "created", trackId: await create(), deleted };
    } catch (error) {
      if (isDuplicateTrackNameError(error) && attempt === 0) {
        const blockedOnRetry = await clearConflicts();
        if (blockedOnRetry) {
          return blockedOnRetry;
        }
        continue;
      }
      return {
        kind: "create_failed",
        reason: error instanceof Error ? error.message : String(error),
        deleted,
      };
    }
  }

  return { kind: "create_failed", reason: "Mux rejected the track name as not unique after retrying.", deleted };
}
