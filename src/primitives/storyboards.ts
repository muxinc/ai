import { z } from "zod";

import { requestIdOf } from "../lib/dependency-error.ts";
import { getMuxImageOrigin, getMuxStoryboardBaseUrl } from "../lib/mux-url.ts";
import { muxVideoError } from "../lib/mux-video-errors.ts";
import { signUrl } from "../lib/url-signing.ts";
import type { WorkflowCredentialsInput, WorkflowScope } from "../types.ts";

export const DEFAULT_STORYBOARD_WIDTH = 640;

/**
 * Generates a storyboard URL for the given playback ID.
 * If shouldSign is true, the URL will be signed with a token using credentials from environment variables.
 *
 * @param playbackId - The Mux playback ID
 * @param width - Width of the storyboard in pixels (default: 640)
 * @param shouldSign - Flag for whether or not to use signed playback IDs (default: false)
 * @param credentials - Optional workflow credentials used for signing
 * @param scope - Optional asset-relative range for storyboard tiles
 * @returns Storyboard URL (signed if shouldSign is true)
 */
export async function getStoryboardUrl(
  playbackId: string,
  width: number = DEFAULT_STORYBOARD_WIDTH,
  shouldSign: boolean = false,
  credentials?: WorkflowCredentialsInput,
  scope?: WorkflowScope,
): Promise<string> {
  "use step";
  const baseUrl = await getMuxStoryboardBaseUrl(playbackId, credentials);
  return withStoryboardParams(baseUrl, playbackId, width, shouldSign, credentials, scope);
}

async function withStoryboardParams(
  baseUrl: string,
  playbackId: string,
  width: number,
  shouldSign: boolean,
  credentials?: WorkflowCredentialsInput,
  scope?: WorkflowScope,
): Promise<string> {
  const params: Record<string, number> = { width };

  if (scope?.startTime !== undefined) {
    params.asset_start_time = scope.startTime;
  }
  if (scope?.endTime !== undefined) {
    params.asset_end_time = scope.endTime;
  }

  if (shouldSign) {
    return signUrl(baseUrl, playbackId, "storyboard", params, credentials);
  }

  return `${baseUrl}?${new URLSearchParams(
    Object.entries(params).map(([key, value]): [string, string] => [key, String(value)]),
  ).toString()}`;
}

/** One frame of a storyboard image and its time in the asset. */
export interface StoryboardFrame {
  /** Seconds from the start of the asset. */
  startTime: number;
  /** Row of the frame's tile in the storyboard grid, from 0. */
  row: number;
  /** Column of the frame's tile in the storyboard grid, from 0. */
  column: number;
  /** Width of the frame's tile in pixels. */
  width: number;
  /** Height of the frame's tile in pixels. */
  height: number;
}

const StoryboardJsonSchema = z.object({
  tile_width: z.number().positive(),
  tile_height: z.number().positive(),
  tiles: z.array(z.object({ start: z.number(), x: z.number(), y: z.number() })),
});

/**
 * Lists the frames of the storyboard image that {@link getStoryboardUrl}
 * returns for the same scope, in reading order. Mux reports a scoped
 * storyboard's times from the start of the scope; they are returned here
 * from the start of the asset. Returns an empty list when Mux's response
 * can't be read.
 */
export async function getStoryboardFrames(
  playbackId: string,
  width: number = DEFAULT_STORYBOARD_WIDTH,
  shouldSign: boolean = false,
  credentials?: WorkflowCredentialsInput,
  scope?: WorkflowScope,
): Promise<StoryboardFrame[]> {
  "use step";
  const baseUrl = `${await getMuxImageOrigin(credentials)}/${playbackId}/storyboard.json`;
  const url = await withStoryboardParams(baseUrl, playbackId, width, shouldSign, credentials, scope);

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw muxVideoError("Failed to fetch storyboard frames from Mux", { call: "fetch_storyboard_frames", cause: error });
  }
  if (!response.ok) {
    throw muxVideoError(`Failed to fetch storyboard frames from Mux (HTTP ${response.status})`, {
      call: "fetch_storyboard_frames",
      status: response.status,
      requestId: requestIdOf(response.headers),
    });
  }

  const parsed = StoryboardJsonSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    return [];
  }

  const { tile_width: tileWidth, tile_height: tileHeight, tiles } = parsed.data;
  const offset = scope?.startTime ?? 0;
  return tiles
    .map(tile => ({
      startTime: offset + tile.start,
      row: Math.round(tile.y / tileHeight),
      column: Math.round(tile.x / tileWidth),
      width: tileWidth,
      height: tileHeight,
    }))
    .sort((a, b) => a.row - b.row || a.column - b.column);
}
