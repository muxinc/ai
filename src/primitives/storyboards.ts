import type { SigningContext } from "../lib/url-signing";
import { signUrl } from "../lib/url-signing";

export const DEFAULT_STORYBOARD_WIDTH = 640;

/**
 * Generates a storyboard URL for the given playback ID.
 * If a signing context is provided, the URL will be signed with a token.
 *
 * @param playbackId - The Mux playback ID
 * @param width - Width of the storyboard in pixels (default: 640)
 * @param signingContext - Optional signing context for signed playback IDs
 * @returns Storyboard URL (signed if context provided)
 */
export async function getStoryboardUrl(
  playbackId: string,
  width: number = DEFAULT_STORYBOARD_WIDTH,
  signingContext?: SigningContext,
): Promise<string> {
  const baseUrl = `https://image.mux.com/${playbackId}/storyboard.png`;

  if (signingContext) {
    return signUrl(baseUrl, playbackId, signingContext, "storyboard", { width });
  }

  return `${baseUrl}?width=${width}`;
}
