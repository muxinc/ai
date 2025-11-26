import { generateObject } from 'ai';
import { z } from 'zod';
import { MuxAIOptions } from '../types';
import { createWorkflowClients } from '../lib/client-factory';
import { withRetry } from '../lib/retry';
import { getPlaybackIdForAsset } from '../lib/mux-assets';
import {
  fetchTranscriptForAsset,
  getReadyTextTracks,
  extractTimestampedTranscript,
} from '../primitives/transcripts';
import { SupportedProvider, ModelIdByProvider } from '../lib/providers';
import { resolveSigningContext } from '../lib/url-signing';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export const chapterSchema = z.object({
  startTime: z.number(),
  title: z.string(),
});

export type Chapter = z.infer<typeof chapterSchema>;

export const chaptersSchema = z.object({
  chapters: z.array(chapterSchema),
});

export type ChaptersType = z.infer<typeof chaptersSchema>;

/** Structured return payload from `generateChapters`. */
export interface ChaptersResult {
  assetId: string;
  languageCode: string;
  chapters: Chapter[];
}

/** Configuration accepted by `generateChapters`. */
export interface ChaptersOptions extends MuxAIOptions {
  /** AI provider used to interpret the transcript (defaults to 'openai'). */
  provider?: SupportedProvider;
  /** Provider-specific model identifier. */
  model?: ModelIdByProvider[SupportedProvider];
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PROVIDER = 'openai';

const SYSTEM_PROMPT = `Your role is to segment the following captions into chunked chapters, summarising each chapter with a title.

Analyze the transcript and create logical chapter breaks based on topic changes, major transitions, or distinct sections of content. Each chapter should represent a meaningful segment of the video.

You must respond with valid JSON in exactly this format:
{
  "chapters": [
    {"startTime": 0, "title": "Introduction"},
    {"startTime": 45.5, "title": "Main Topic Discussion"},
    {"startTime": 120.0, "title": "Conclusion"}
  ]
}

Important rules:
- startTime must be in seconds (not HH:MM:SS format)
- Always start with startTime: 0 for the first chapter
- Create 3-8 chapters depending on content length and natural breaks
- Chapter titles should be concise and descriptive
- Do not include any text before or after the JSON
- The JSON must be valid and parseable`;

export async function generateChapters(
  assetId: string,
  languageCode: string,
  options: ChaptersOptions = {}
): Promise<ChaptersResult> {
  const { provider = DEFAULT_PROVIDER, model, abortSignal } = options;

  // Initialize clients with validated credentials and resolved language model
  const clients = createWorkflowClients({ ...options, model }, provider as SupportedProvider);

  // Fetch asset and caption track/transcript
  const { asset: assetData, playbackId, policy } = await getPlaybackIdForAsset(clients.mux, assetId);

  // Resolve signing context for signed playback IDs
  const signingContext = resolveSigningContext(options);
  if (policy === 'signed' && !signingContext) {
    throw new Error(
      'Signed playback ID requires signing credentials. ' +
      'Provide muxSigningKey and muxPrivateKey in options or set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.'
    );
  }

  const transcriptResult = await fetchTranscriptForAsset(assetData, playbackId, {
    languageCode,
    cleanTranscript: false, // keep timestamps for chapter segmentation
    signingContext: policy === 'signed' ? signingContext : undefined,
  });

  if (!transcriptResult.track || !transcriptResult.transcriptText) {
    const availableLanguages = getReadyTextTracks(assetData)
      .map((t) => t.language_code)
      .filter(Boolean)
      .join(', ');
    throw new Error(
      `No caption track found for language '${languageCode}'. Available languages: ${availableLanguages || 'none'}`
    );
  }

  const timestampedTranscript = extractTimestampedTranscript(transcriptResult.transcriptText);
  if (!timestampedTranscript) {
    throw new Error('No usable content found in caption track');
  }

  // Generate chapters using AI SDK
  let chaptersData: { chapters: Chapter[] } | null = null;

  try {
    const response = await withRetry(() =>
      generateObject({
        model: clients.languageModel.model,
        schema: chaptersSchema,
        abortSignal,
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT,
          },
          {
            role: 'user',
            content: timestampedTranscript,
          },
        ],
      })
    );

    chaptersData = response.object;
  } catch (error) {
    throw new Error(
      `Failed to generate chapters with ${provider}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  if (!chaptersData || !chaptersData.chapters) {
    throw new Error('No chapters generated from AI response');
  }

  // Validate and sort chapters
  const validChapters = chaptersData.chapters
    .filter(chapter => typeof chapter.startTime === 'number' && typeof chapter.title === 'string')
    .sort((a, b) => a.startTime - b.startTime);

  if (validChapters.length === 0) {
    throw new Error('No valid chapters found in AI response');
  }

  // Ensure first chapter starts at 0
  if (validChapters[0].startTime !== 0) {
    validChapters[0].startTime = 0;
  }

  return {
    assetId,
    languageCode,
    chapters: validChapters,
  };
}
