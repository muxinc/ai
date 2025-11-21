import { generateObject } from 'ai';
import { summarySchema, SummarizationOptions, SummaryAndTagsResult } from '../types';
import { downloadImageAsBase64 } from '../lib/image-download';
import { createWorkflowClients } from '../lib/client-factory';
import { withRetry } from '../lib/retry';
import { SupportedProvider } from '../lib/providers';
import { fetchPlaybackAsset } from '../lib/mux-assets';
import { fetchTranscriptForAsset } from '../primitives/transcripts';
import { getStoryboardUrl } from '../primitives/storyboards';

const DEFAULT_PROMPT = "Generate a short title (max 100 characters) and description (max 500 characters) for what happens. Start immediately with the action or subject - never reference that this is a video, content, or storyboard. Example: Title: 'Cooking Pasta Tutorial' Description: 'Someone cooks pasta by boiling water and adding noodles.'";

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
    provider = 'openai',
    model,
    tone = 'normal',
    includeTranscript = true,
    cleanTranscript = true,
    imageSubmissionMode = 'url',
    imageDownloadOptions,
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
      messages: [
        {
          role: 'system',
          content:
            'You are an image analysis tool. You will be given a storyboard image from a video showing multiple frames/scenes, and be expected to return structured data about the contents across all the frames.',
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
    tags: aiAnalysis.keywords || [],
    storyboardUrl: imageUrl,
  };
}
