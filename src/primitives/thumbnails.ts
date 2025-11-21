export interface ThumbnailOptions {
  /** Interval between thumbnails in seconds (default: 10) */
  interval?: number;
  /** Width of the thumbnail in pixels (default: 640) */
  width?: number;
}

/**
 * Generates thumbnail URLs at regular intervals based on video duration.
 */
export function getThumbnailUrls(
  playbackId: string,
  duration: number,
  options: ThumbnailOptions = {}
): string[] {
  const { interval = 10, width = 640 } = options;
  const timestamps: number[] = [];

  if (duration <= 50) {
    const spacing = duration / 6;
    for (let i = 1; i <= 5; i++) {
      timestamps.push(Math.round(i * spacing));
    }
  } else {
    for (let time = 0; time < duration; time += interval) {
      timestamps.push(time);
    }
  }

  return timestamps.map(
    (time) => `https://image.mux.com/${playbackId}/thumbnail.png?time=${time}&width=${width}`
  );
}
