import { getMuxStoryboardBaseUrl } from "../lib/mux-url.ts";
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
  const baseUrl = getMuxStoryboardBaseUrl(playbackId);
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
