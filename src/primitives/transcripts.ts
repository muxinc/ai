import { signUrl } from "@mux/ai/lib/url-signing";
import type { AssetTextTrack, MuxAsset, WorkflowCredentialsInput } from "@mux/ai/types";

/** A single cue from a VTT file with timing info. */
export interface VTTCue {
  startTime: number;
  endTime: number;
  text: string;
}

export interface TranscriptFetchOptions {
  languageCode?: string;
  cleanTranscript?: boolean;
  /** Optional signing context for signed playback IDs */
  shouldSign?: boolean;
  credentials?: WorkflowCredentialsInput;
  /**
   * When true, throws if no usable transcript can be retrieved (no ready text track,
   * missing track id, fetch error, or empty transcript).
   *
   * Default behavior is non-fatal and returns an empty `transcriptText`.
   */
  required?: boolean;
}

export interface TranscriptResult {
  transcriptText: string;
  transcriptUrl?: string;
  track?: AssetTextTrack;
}

export function getReadyTextTracks(asset: MuxAsset): AssetTextTrack[] {
  return (asset.tracks || []).filter(
    track => track.type === "text" && track.status === "ready",
  );
}

export function findCaptionTrack(asset: MuxAsset, languageCode?: string): AssetTextTrack | undefined {
  const tracks = getReadyTextTracks(asset);
  if (!tracks.length)
    return undefined;

  if (!languageCode) {
    return tracks[0];
  }

  return tracks.find(
    track =>
      track.text_type === "subtitles" &&
      track.language_code === languageCode,
  );
}

export function extractTextFromVTT(vttContent: string): string {
  if (!vttContent.trim()) {
    return "";
  }

  const lines = vttContent.split("\n");
  const textLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line)
      continue;
    if (line === "WEBVTT")
      continue;
    if (line.startsWith("NOTE "))
      continue;
    if (line.includes("-->"))
      continue;
    if (/^[\w-]+$/.test(line) && !line.includes(" "))
      continue;
    if (line.startsWith("STYLE") || line.startsWith("REGION"))
      continue;

    const cleanLine = line.replace(/<[^>]*>/g, "").trim();

    if (cleanLine) {
      textLines.push(cleanLine);
    }
  }

  return textLines.join(" ").replace(/\s+/g, " ").trim();
}

export function vttTimestampToSeconds(timestamp: string): number {
  const parts = timestamp.split(":");
  if (parts.length !== 3)
    return 0;

  const hours = Number.parseInt(parts[0], 10) || 0;
  const minutes = Number.parseInt(parts[1], 10) || 0;
  const seconds = Number.parseFloat(parts[2]) || 0;

  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Converts seconds to a human-readable timestamp.
 * Returns M:SS for durations under an hour, H:MM:SS for an hour or more.
 *
 * @param seconds - The number of seconds to convert
 * @returns A formatted timestamp string (e.g., "2:05" or "01:02:05")
 */
export function secondsToTimestamp(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;

  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export function extractTimestampedTranscript(vttContent: string): string {
  if (!vttContent.trim()) {
    return "";
  }

  const lines = vttContent.split("\n");
  const segments: Array<{ time: number; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.includes("-->")) {
      const startTime = line.split(" --> ")[0].trim();
      const timeInSeconds = vttTimestampToSeconds(startTime);

      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) {
        j++;
      }

      if (j < lines.length) {
        const text = lines[j].trim().replace(/<[^>]*>/g, "");
        if (text) {
          segments.push({ time: timeInSeconds, text });
        }
      }
    }
  }

  return segments
    .map(segment => `[${Math.floor(segment.time)}s] ${segment.text}`)
    .join("\n");
}

/**
 * Parses VTT content into structured cues with timing.
 *
 * @param vttContent - Raw VTT file content
 * @returns Array of VTT cues with start/end times and text
 */
export function parseVTTCues(vttContent: string): VTTCue[] {
  if (!vttContent.trim())
    return [];

  const lines = vttContent.split("\n");
  const cues: VTTCue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.includes("-->")) {
      const [startStr, endStr] = line.split(" --> ").map(s => s.trim());
      const startTime = vttTimestampToSeconds(startStr);
      const endTime = vttTimestampToSeconds(endStr.split(" ")[0]); // Handle cue settings

      // Collect text lines until empty line or next timestamp
      const textLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() && !lines[j].includes("-->")) {
        const cleanLine = lines[j].trim().replace(/<[^>]*>/g, "");
        if (cleanLine)
          textLines.push(cleanLine);
        j++;
      }

      if (textLines.length > 0) {
        cues.push({
          startTime,
          endTime,
          text: textLines.join(" "),
        });
      }
    }
  }

  return cues;
}

/**
 * Builds a transcript URL for the given playback ID and track ID.
 * If a signing context is provided, the URL will be signed with a token.
 *
 * @param playbackId - The Mux playback ID
 * @param trackId - The text track ID
 * @param shouldSign - Flag for whether or not to use signed playback IDs
 * @returns Transcript URL (signed if context provided)
 */
export async function buildTranscriptUrl(
  playbackId: string,
  trackId: string,
  shouldSign: boolean = false,
  credentials?: WorkflowCredentialsInput,
): Promise<string> {
  "use step";
  const baseUrl = `https://stream.mux.com/${playbackId}/text/${trackId}.vtt`;

  if (shouldSign) {
    return signUrl(baseUrl, playbackId, "video", undefined, credentials);
  }

  return baseUrl;
}

export async function fetchTranscriptForAsset(
  asset: MuxAsset,
  playbackId: string,
  options: TranscriptFetchOptions = {},
): Promise<TranscriptResult> {
  "use step";
  const {
    languageCode,
    cleanTranscript = true,
    shouldSign,
    credentials,
    required = false,
  } = options;
  const track = findCaptionTrack(asset, languageCode);

  if (!track) {
    if (required) {
      const availableLanguages = getReadyTextTracks(asset)
        .map(t => t.language_code)
        .filter(Boolean)
        .join(", ");
      throw new Error(
        `No transcript track found${languageCode ? ` for language '${languageCode}'` : ""}. Available languages: ${availableLanguages || "none"}`,
      );
    }
    return { transcriptText: "" };
  }

  if (!track.id) {
    if (required) {
      throw new Error("Transcript track is missing an id");
    }
    return { transcriptText: "", track };
  }

  const transcriptUrl = await buildTranscriptUrl(playbackId, track.id, shouldSign, credentials);

  try {
    const response = await fetch(transcriptUrl);
    if (!response.ok) {
      if (required) {
        throw new Error(`Failed to fetch transcript (HTTP ${response.status})`);
      }
      return { transcriptText: "", transcriptUrl, track };
    }

    const rawVtt = await response.text();
    const transcriptText = cleanTranscript ? extractTextFromVTT(rawVtt) : rawVtt;

    if (required && !transcriptText.trim()) {
      throw new Error("Transcript is empty");
    }

    return { transcriptText, transcriptUrl, track };
  } catch (error) {
    if (required) {
      throw new Error(
        `Failed to fetch transcript: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
    console.warn("Failed to fetch transcript:", error);
    return { transcriptText: "", transcriptUrl, track };
  }
}
