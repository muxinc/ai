import { generateObject } from 'ai';
import { z } from 'zod';
import { MuxAIOptions, ToneType, ImageSubmissionMode } from '../types';
import { downloadImageAsBase64, ImageDownloadOptions } from '../lib/image-download';
import { createWorkflowClients } from '../lib/client-factory';
import { withRetry } from '../lib/retry';
import { SupportedProvider, ModelIdByProvider } from '../lib/providers';
import { fetchPlaybackAsset } from '../lib/mux-assets';
import { fetchTranscriptForAsset } from '../primitives/transcripts';
import { getStoryboardUrl } from '../primitives/storyboards';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export const SUMMARY_KEYWORD_LIMIT = 10;

export const summarySchema = z.object({
  keywords: z.array(z.string()),
  title: z.string(),
  description: z.string(),
});

export type SummaryType = z.infer<typeof summarySchema>;

/** Structured return payload for `getSummaryAndTags`. */
export interface SummaryAndTagsResult {
  /** Asset ID passed into the workflow. */
  assetId: string;
  /** Short headline generated from the storyboard. */
  title: string;
  /** Longer description of the detected content. */
  description: string;
  /** Up to 10 keywords extracted by the model. */
  tags: string[];
  /** Storyboard image URL that was analyzed. */
  storyboardUrl: string;
}

/** Configuration accepted by `getSummaryAndTags`. */
export interface SummarizationOptions extends MuxAIOptions {
  /** AI provider to run (defaults to 'openai'). */
  provider?: SupportedProvider;
  /** Provider-specific chat model identifier. */
  model?: ModelIdByProvider[SupportedProvider];
  /** Prompt tone shim applied to the system instruction (defaults to 'normal'). */
  tone?: ToneType;
  /** Fetch the transcript and send it alongside the storyboard (defaults to true). */
  includeTranscript?: boolean;
  /** Strip timestamps/markup from transcripts before including them (defaults to true). */
  cleanTranscript?: boolean;
  /** How storyboard frames should be delivered to the provider (defaults to 'url'). */
  imageSubmissionMode?: ImageSubmissionMode;
  /** Fine-tune storyboard downloads when `imageSubmissionMode` === 'base64'. */
  imageDownloadOptions?: ImageDownloadOptions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PROMPT =
  "Generate a short title (max 100 characters) and description (max 500 characters) for what happens. Start immediately with the action or subject - never reference that this is a video, content, or storyboard. Provide up to 10 concise keywords that capture the primary people, objects, or actions. Example: Title: 'Cooking Pasta Tutorial' Description: 'Someone cooks pasta by boiling water and adding noodles.' Keywords: ['cooking', 'pasta', 'boiling water', 'noodles', 'kitchen'].";
const DEFAULT_PROVIDER = 'openai';
const DEFAULT_TONE = 'normal';

function normalizeKeywords(keywords?: string[]): string[] {
  if (!Array.isArray(keywords) || keywords.length === 0) {
    return [];
  }

  const uniqueLowercase = new Set<string>();
  const normalized: string[] = [];

  for (const keyword of keywords) {
    const trimmed = keyword?.trim();
    if (!trimmed) {
      continue;
    }

    const lower = trimmed.toLowerCase();
    if (uniqueLowercase.has(lower)) {
      continue;
    }

    uniqueLowercase.add(lower);
    normalized.push(trimmed);

    if (normalized.length === SUMMARY_KEYWORD_LIMIT) {
      break;
    }
  }

  return normalized;
}

export async function getSummaryAndTags(
  assetId: string,
  promptOrOptions?: string | SummarizationOptions,
  options?: SummarizationOptions
): Promise<SummaryAndTagsResult> {
  // Handle overloaded parameters
  let prompt: string;
  let actualOptions: SummarizationOptions;

  if (typeof promptOrOptions === 'string') {
    prompt = promptOrOptions;
    actualOptions = options || {};
  } else {
    prompt = DEFAULT_PROMPT;
    actualOptions = promptOrOptions || {};
  }

  const {
    provider = DEFAULT_PROVIDER,
    model,
    tone = DEFAULT_TONE,
    includeTranscript = true,
    cleanTranscript = true,
    imageSubmissionMode = 'url',
    imageDownloadOptions,
    abortSignal,
  } = actualOptions;

  // Initialize clients with validated credentials and resolved language model
  const clients = createWorkflowClients(
    { ...actualOptions, model },
    provider as SupportedProvider
  );

  // Fetch asset data from Mux and grab playback/transcript details
  const { asset: assetData, playbackId } = await fetchPlaybackAsset(clients.mux, assetId);

  const transcriptText =
    includeTranscript
      ? (await fetchTranscriptForAsset(assetData, playbackId, { cleanTranscript })).transcriptText
      : '';

  // Create tone-informed prompt
  let toneInstruction = '';
  switch (tone) {
    case 'sassy':
      toneInstruction = ' Answer with a sassy, playful attitude and personality.';
      break;
    case 'professional':
      toneInstruction = ' Provide a professional, executive-level analysis suitable for business reporting.';
      break;
    default: // normal
      toneInstruction = ' Provide a clear, straightforward analysis.';
  }

  // Add transcript context to prompt if available
  let contextualPrompt = prompt + toneInstruction;
  if (transcriptText) {
    const transcriptType = cleanTranscript ? 'transcript' : 'WebVTT transcript';
    contextualPrompt += ` Use the following ${transcriptType} for additional context: "${transcriptText}"`;
  }

  // Analyze storyboard with AI provider
  const imageUrl = getStoryboardUrl(playbackId, 640);

  const analyzeStoryboard = async (imageDataUrl: string) => {
    const response = await generateObject({
      model: clients.languageModel.model,
      schema: summarySchema,
      abortSignal,
      messages: [
        {
          role: 'system',
          content:
            'You are an image analysis tool. You will be given a storyboard image from a video showing multiple frames/scenes arranged in a grid. The frames are ordered temporally left-to-right, top-to-bottom (like reading text), so the first frame is in the top-left and the last frame is in the bottom-right. Analyze the progression of content across all frames and return structured data about what happens throughout the video.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: contextualPrompt },
            { type: 'image', image: imageDataUrl },
          ],
        },
      ],
    });

    return response.object;
  };

  let aiAnalysis: { title?: string; description?: string; keywords?: string[] } | null = null;

  try {
    if (imageSubmissionMode === 'base64') {
      const downloadResult = await downloadImageAsBase64(imageUrl, imageDownloadOptions);
      aiAnalysis = await analyzeStoryboard(downloadResult.base64Data);
    } else {
      // URL-based submission with retry logic
      aiAnalysis = await withRetry(() => analyzeStoryboard(imageUrl));
    }
  } catch (error: unknown) {
    throw new Error(
      `Failed to analyze video content with ${provider}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  return {
    assetId,
    title: aiAnalysis.title || 'No title available',
    description: aiAnalysis.description || 'No description available',
    tags: normalizeKeywords(aiAnalysis.keywords),
    storyboardUrl: imageUrl,
  };
}
