import { AssetTextTrack, MuxAsset } from '../types';
import { SigningContext, signUrl } from '../lib/url-signing';

export interface TranscriptFetchOptions {
  languageCode?: string;
  cleanTranscript?: boolean;
  /** Optional signing context for signed playback IDs */
  signingContext?: SigningContext;
}

export interface TranscriptResult {
  transcriptText: string;
  transcriptUrl?: string;
  track?: AssetTextTrack;
}

export function getReadyTextTracks(asset: MuxAsset): AssetTextTrack[] {
  return (asset.tracks || []).filter(
    (track) => track.type === 'text' && track.status === 'ready'
  );
}

export function findCaptionTrack(asset: MuxAsset, languageCode?: string): AssetTextTrack | undefined {
  const tracks = getReadyTextTracks(asset);
  if (!tracks.length) return undefined;

  if (!languageCode) {
    return tracks[0];
  }

  return tracks.find(
    (track) =>
      track.text_type === 'subtitles' &&
      track.language_code === languageCode
  );
}

export function extractTextFromVTT(vttContent: string): string {
  if (!vttContent.trim()) {
    return '';
  }

  const lines = vttContent.split('\n');
  const textLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) continue;
    if (line === 'WEBVTT') continue;
    if (line.startsWith('NOTE ')) continue;
    if (line.includes('-->')) continue;
    if (/^[\d\w-]+$/.test(line) && !line.includes(' ')) continue;
    if (line.startsWith('STYLE') || line.startsWith('REGION')) continue;

    const cleanLine = line.replace(/<[^>]*>/g, '').trim();

    if (cleanLine) {
      textLines.push(cleanLine);
    }
  }

  return textLines.join(' ').replace(/\s+/g, ' ').trim();
}

export function vttTimestampToSeconds(timestamp: string): number {
  const parts = timestamp.split(':');
  if (parts.length !== 3) return 0;

  const hours = parseInt(parts[0], 10) || 0;
  const minutes = parseInt(parts[1], 10) || 0;
  const seconds = parseFloat(parts[2]) || 0;

  return hours * 3600 + minutes * 60 + seconds;
}

export function extractTimestampedTranscript(vttContent: string): string {
  if (!vttContent.trim()) {
    return '';
  }

  const lines = vttContent.split('\n');
  const segments: Array<{ time: number; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.includes('-->')) {
      const startTime = line.split(' --> ')[0].trim();
      const timeInSeconds = vttTimestampToSeconds(startTime);

      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) {
        j++;
      }

      if (j < lines.length) {
        const text = lines[j].trim().replace(/<[^>]*>/g, '');
        if (text) {
          segments.push({ time: timeInSeconds, text });
        }
      }
    }
  }

  return segments
    .map((segment) => `[${Math.floor(segment.time)}s] ${segment.text}`)
    .join('\n');
}

/**
 * Builds a transcript URL for the given playback ID and track ID.
 * If a signing context is provided, the URL will be signed with a token.
 *
 * @param playbackId - The Mux playback ID
 * @param trackId - The text track ID
 * @param signingContext - Optional signing context for signed playback IDs
 * @returns Transcript URL (signed if context provided)
 */
export async function buildTranscriptUrl(
  playbackId: string,
  trackId: string,
  signingContext?: SigningContext
): Promise<string> {
  const baseUrl = `https://stream.mux.com/${playbackId}/text/${trackId}.vtt`;

  if (signingContext) {
    return signUrl(baseUrl, playbackId, signingContext, 'video');
  }

  return baseUrl;
}

export async function fetchTranscriptForAsset(
  asset: MuxAsset,
  playbackId: string,
  options: TranscriptFetchOptions = {}
): Promise<TranscriptResult> {
  const { languageCode, cleanTranscript = true, signingContext } = options;
  const track = findCaptionTrack(asset, languageCode);

  if (!track) {
    return { transcriptText: '' };
  }

  if (!track.id) {
    return { transcriptText: '', track };
  }

  const transcriptUrl = await buildTranscriptUrl(playbackId, track.id, signingContext);

  try {
    const response = await fetch(transcriptUrl);
    if (!response.ok) {
      return { transcriptText: '', transcriptUrl, track };
    }

    const rawVtt = await response.text();
    const transcriptText = cleanTranscript ? extractTextFromVTT(rawVtt) : rawVtt;

    return { transcriptText, transcriptUrl, track };
  } catch (error) {
    console.warn('Failed to fetch transcript:', error);
    return { transcriptText: '', transcriptUrl, track };
  }
}
