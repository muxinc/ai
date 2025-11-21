import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { MuxAIOptions } from './types';
import { createWorkflowClients, WorkflowClients } from './lib/client-factory';
import { getDefaultModel, validateProvider } from './lib/provider-models';
import { withRetry } from './lib/retry';

export interface Chapter {
  /** Start time in seconds */
  startTime: number;
  /** Chapter title */
  title: string;
}

export interface ChaptersResult {
  assetId: string;
  languageCode: string;
  chapters: Chapter[];
}

export interface ChaptersOptions extends MuxAIOptions {
  provider?: 'openai' | 'anthropic';
  model?: string;
}

const chaptersSchema = z.object({
  chapters: z.array(z.object({
    startTime: z.number(),
    title: z.string()
  }))
});

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

const JSON_FORMAT_PROMPT = `You must respond with valid JSON in exactly this format:
{
  "chapters": [
    {"startTime": 0, "title": "Chapter title here"},
    {"startTime": 45.5, "title": "Another chapter title"}
  ]
}

Do not include any text before or after the JSON. The JSON must be valid and parseable.`;

/**
 * Converts VTT timestamp (HH:MM:SS.mmm) to seconds
 */
function vttTimestampToSeconds(timestamp: string): number {
  const parts = timestamp.split(':');
  if (parts.length !== 3) return 0;
  
  const hours = parseInt(parts[0], 10) || 0;
  const minutes = parseInt(parts[1], 10) || 0;
  const seconds = parseFloat(parts[2]) || 0;
  
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Extracts timestamps and text from VTT content for chapter generation
 */
function extractTimestampsFromVTT(vttContent: string): string {
  if (!vttContent.trim()) {
    return '';
  }

  const lines = vttContent.split('\n');
  const segments: Array<{time: number, text: string}> = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Find timestamp lines (contain -->)
    if (line.includes('-->')) {
      const startTime = line.split(' --> ')[0].trim();
      const timeInSeconds = vttTimestampToSeconds(startTime);
      
      // Get the subtitle text (next non-empty line)
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) {
        j++;
      }
      
      if (j < lines.length) {
        const text = lines[j].trim().replace(/<[^>]*>/g, ''); // Remove formatting tags
        if (text) {
          segments.push({ time: timeInSeconds, text });
        }
      }
    }
  }
  
  // Create a readable transcript with timestamps for the AI
  return segments
    .map(segment => `[${Math.floor(segment.time)}s] ${segment.text}`)
    .join('\n');
}

export async function generateChapters(
  assetId: string,
  languageCode: string,
  options: ChaptersOptions = {}
): Promise<ChaptersResult> {
  const { provider = 'openai', model } = options;

  // Validate provider and get default model
  validateProvider(provider);
  const finalModel = model || getDefaultModel(provider);

  // Initialize clients with validated credentials
  const clients = createWorkflowClients(options, provider);

  // Fetch asset data from Mux
  let assetData;
  try {
    const asset = await clients.mux.video.assets.retrieve(assetId);
    assetData = asset;
  } catch (error) {
    throw new Error(`Failed to fetch asset from Mux: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Get playback ID
  const playbackId = assetData.playback_ids?.[0]?.id;
  if (!playbackId) {
    throw new Error('No playback ID found for this asset');
  }

  // Find caption track in the specified language
  if (!assetData.tracks) {
    throw new Error('No tracks found for this asset');
  }

  const captionTrack = assetData.tracks.find((track) => 
    track.type === 'text' && 
    track.status === 'ready' &&
    track.text_type === 'subtitles' &&
    track.language_code === languageCode
  );

  if (!captionTrack) {
    throw new Error(`No caption track found for language '${languageCode}'. Available languages: ${assetData.tracks.filter(t => t.type === 'text').map(t => t.language_code).join(', ')}`);
  }

  // Fetch the VTT content
  const transcriptUrl = `https://stream.mux.com/${playbackId}/text/${captionTrack.id}.vtt`;
  
  let vttContent: string;
  try {
    const transcriptResponse = await fetch(transcriptUrl);
    if (!transcriptResponse.ok) {
      throw new Error(`Failed to fetch VTT: ${transcriptResponse.statusText}`);
    }
    vttContent = await transcriptResponse.text();
  } catch (error) {
    throw new Error(`Failed to fetch caption track: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Extract timestamped transcript for AI processing
  const timestampedTranscript = extractTimestampsFromVTT(vttContent);
  
  if (!timestampedTranscript) {
    throw new Error('No usable content found in caption track');
  }

  // Generate chapters using AI
  let chaptersData: { chapters: Chapter[] } | null = null;

  if (provider === 'openai') {
    if (!clients.openai) {
      throw new Error('OpenAI client not initialized');
    }

    try {
      const response = await clients.openai.responses.parse({
        model: finalModel,
        input: [
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: timestampedTranscript,
              },
            ],
          },
        ],
        text: {
          format: zodTextFormat(chaptersSchema, "chapters"),
        },
      });

      chaptersData = response.output_parsed;
    } catch (error) {
      throw new Error(`Failed to generate chapters with OpenAI: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else if (provider === 'anthropic') {
    if (!clients.anthropic) {
      throw new Error('Anthropic client not initialized');
    }

    const anthropicPrompt = `${SYSTEM_PROMPT}

${JSON_FORMAT_PROMPT}

Transcript:
${timestampedTranscript}`;

    try {
      const response = await clients.anthropic.messages.create({
        model: finalModel,
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: anthropicPrompt,
          },
        ],
      });

      const content = response.content[0];
      if (content.type === 'text') {
        const jsonText = content.text.trim();
        try {
          chaptersData = JSON.parse(jsonText);
        } catch (parseError) {
          throw new Error(`Failed to parse JSON response from Anthropic: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
        }
      } else {
        throw new Error('Unexpected response type from Anthropic');
      }
    } catch (error) {
      throw new Error(`Failed to generate chapters with Anthropic: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
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