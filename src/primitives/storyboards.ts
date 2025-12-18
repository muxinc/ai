import { getMuxSigningContextFromEnv, signUrl } from "@mux/ai/lib/url-signing";

export const DEFAULT_STORYBOARD_WIDTH = 640;

/**
 * Generates a storyboard URL for the given playback ID.
 * If shouldSign is true, the URL will be signed with a token using credentials from environment variables.
 *
 * @param playbackId - The Mux playback ID
 * @param width - Width of the storyboard in pixels (default: 640)
 * @param shouldSign - Flag for whether or not to use signed playback IDs (default: false)
 * @returns Storyboard URL (signed if shouldSign is true)
 */
export async function getStoryboardUrl(
  playbackId: string,
  width: number = DEFAULT_STORYBOARD_WIDTH,
  shouldSign: boolean = false,
): Promise<string> {
  "use step";
  const baseUrl = `https://image.mux.com/${playbackId}/storyboard.png`;

  if (shouldSign) {
    // NOTE: this assumes you have already validated the signing context elsewhere
    const signingContext = getMuxSigningContextFromEnv();
    return signUrl(baseUrl, playbackId, signingContext!, "storyboard", { width });
  }

  return `${baseUrl}?width=${width}`;
}
