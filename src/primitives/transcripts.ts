import { getMuxSigningContextFromEnv, signUrl } from "@mux/ai/lib/url-signing";
import type { AssetTextTrack, MuxAsset } from "@mux/ai/types";

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
): Promise<string> {
  "use step";
  const baseUrl = `https://stream.mux.com/${playbackId}/text/${trackId}.vtt`;

  if (shouldSign) {
    // NOTE: this assumes you have already validated the signing context elsewhere
    const signingContext = getMuxSigningContextFromEnv();
    return signUrl(baseUrl, playbackId, signingContext!, "video");
  }

  return baseUrl;
}

export async function fetchTranscriptForAsset(
  asset: MuxAsset,
  playbackId: string,
  options: TranscriptFetchOptions = {},
): Promise<TranscriptResult> {
  "use step";
  const { languageCode, cleanTranscript = true, shouldSign } = options;
  const track = findCaptionTrack(asset, languageCode);

  if (!track) {
    return { transcriptText: "" };
  }

  if (!track.id) {
    return { transcriptText: "", track };
  }

  const transcriptUrl = await buildTranscriptUrl(playbackId, track.id, shouldSign);

  try {
    const response = await fetch(transcriptUrl);
    if (!response.ok) {
      return { transcriptText: "", transcriptUrl, track };
    }

    const rawVtt = await response.text();
    const transcriptText = cleanTranscript ? extractTextFromVTT(rawVtt) : rawVtt;

    return { transcriptText, transcriptUrl, track };
  } catch (error) {
    console.warn("Failed to fetch transcript:", error);
    return { transcriptText: "", transcriptUrl, track };
  }
}
