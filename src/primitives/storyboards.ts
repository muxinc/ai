export const DEFAULT_STORYBOARD_WIDTH = 640;

export function getStoryboardUrl(playbackId: string, width: number = DEFAULT_STORYBOARD_WIDTH): string {
  return `https://image.mux.com/${playbackId}/storyboard.png?width=${width}`;
}

