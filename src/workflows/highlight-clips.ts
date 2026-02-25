import { generateText, Output } from "ai";
import dedent from "dedent";
import { z } from "zod";

import { getMuxClientFromEnv } from "@mux/ai/lib/client-factory";
import {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
} from "@mux/ai/lib/mux-assets";
import { createPromptBuilder } from "@mux/ai/lib/prompt-builder";
import {
  createLanguageModelFromConfig,
  resolveLanguageModelConfig,
} from "@mux/ai/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "@mux/ai/lib/providers";
import { withRetry } from "@mux/ai/lib/retry";
import { resolveMuxSigningContext } from "@mux/ai/lib/workflow-credentials";
import { getHotspotsForAsset } from "@mux/ai/primitives/hotspots";
import type { Hotspot } from "@mux/ai/primitives/hotspots";
import { getStoryboardUrl } from "@mux/ai/primitives/storyboards";
import { getThumbnailUrls } from "@mux/ai/primitives/thumbnails";
import {
  extractTextFromVTT,
  fetchTranscriptForAsset,
  parseVTTCues,
} from "@mux/ai/primitives/transcripts";
import type { VTTCue } from "@mux/ai/primitives/transcripts";
import type {
  MuxAIOptions,
  TokenUsage,
  WorkflowCredentialsInput,
} from "@mux/ai/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Metadata for a single highlight clip */
export interface ClipMetadata {
  /** Start time in seconds */
  startTime: number;
  /** End time in seconds */
  endTime: number;
  /** Clip duration in seconds */
  duration: number;

  /** Clip title */
  title: string;
  /** Clip description */
  description: string;
  /** Keywords/tags for the clip */
  keywords: string[];

  /** Original hotspot engagement score (0-1) */
  engagementScore: number;
  /** Suggested platforms for this clip */
  suggestedPlatforms: string[];

  /** Mux asset ID for the clip (if created) */
  clipAssetId?: string;
  /** Playback ID for the clip (if created) */
  clipPlaybackId?: string;
  /** HLS playback URL (if created) */
  clipUrl?: string;
  /** Thumbnail image URL (if created) */
  thumbnailUrl?: string;

  /** Asset status: "preparing" | "ready" | "errored" */
  assetStatus?: string;

  // TODO: Advanced platform optimization (future feature)
  // aspectRatio?: string;
  // cropSuggestion?: { x: number; y: number; width: number; height: number };
}

/** Result returned by generateHighlightClips workflow */
export interface GenerateHighlightClipsResult {
  /** Source asset ID */
  assetId: string;
  /** Generated clips with metadata */
  clips: ClipMetadata[];
  /** AI token usage */
  usage?: TokenUsage;
  /** Total number of clips generated */
  totalClipsGenerated: number;
  /** Sum of all engagement scores */
  totalEngagementScore: number;
}

/** Configuration options for generateHighlightClips workflow */
export interface HighlightClipsOptions extends MuxAIOptions {
  /** Maximum number of clips to generate (default: 5) */
  maxClips?: number;
  /** Minimum clip duration in seconds (default: 15) */
  minClipDuration?: number;
  /** Maximum clip duration in seconds (default: 90) */
  maxClipDuration?: number;
  /** Preferred clip duration in seconds (optional) */
  targetDuration?: number;

  /** Hotspots engagement data timeframe (default: "[7:days]") */
  timeframe?: string;

  /** Skip asset creation, return analysis only (default: false) */
  dryRun?: boolean;

  /** AI provider (default: "openai") */
  provider?: SupportedProvider;
  /** Model identifier (optional) */
  model?: ModelIdByProvider[SupportedProvider];

  // TODO: Advanced platform optimization (future feature)
  // platforms?: Platform[];
  // aspectRatio?: "16:9" | "9:16" | "1:1";
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** Schema for a single analyzed clip from AI */
const analyzedClipSchema = z.object({
  startTime: z.number().describe("Start time in seconds"),
  endTime: z.number().describe("End time in seconds"),
  title: z.string().describe("Compelling title under 60 characters"),
  description: z
    .string()
    .describe("1-2 sentence description of the clip"),
  keywords: z
    .array(z.string())
    .describe("3-5 searchable keywords"),
  engagementScore: z.number().describe("Original engagement score (0-1)"),
  suggestedPlatforms: z
    .array(z.string())
    .describe("Platforms suitable for this clip"),
  reasoning: z
    .string()
    .describe("Reasoning for chosen boundaries and metadata"),
});

type AnalyzedClip = z.infer<typeof analyzedClipSchema>;

/** Schema for batch clip analysis response from AI */
const clipAnalysisSchema = z.object({
  clips: z.array(analyzedClipSchema),
});

const CLIP_ANALYSIS_OUTPUT = Output.object({
  name: "clip_analysis",
  description: "Analysis of engagement hotspots with optimized clip boundaries and metadata",
  schema: clipAnalysisSchema,
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

type HighlightClipsPromptSections =
  | "role" |
  "context" |
  "boundaryOptimization" |
  "metadataGuidelines" |
  "constraints";

/**
 * System prompt for the clip analysis AI
 */
const clipAnalysisSystemPromptBuilder = createPromptBuilder<HighlightClipsPromptSections>({
  template: {
    role: {
      tag: "role",
      content: dedent`
        You are a video clip editor specializing in creating engaging short-form content.
        Your job is to find the best clip boundaries and generate compelling metadata for
        highlight clips based on engagement data and content analysis.`,
    },
    context: {
      tag: "context",
      content: dedent`
        You receive:
        - Engagement hotspots (high-engagement moments in the video) from Mux Data API
        - Full transcript to understand overall video themes, style, and topics
        - Timestamped VTT cues for precise boundary detection
        - Storyboard showing video progression across time
        - Thumbnails at each hotspot timestamp for detailed visual analysis

        Your task is to:
        1. Understand the overall content context from the full transcript
        2. Optimize clip boundaries around each hotspot
        3. Generate compelling metadata that makes clips shareable on social platforms`,
    },
    boundaryOptimization: {
      tag: "clip_boundary_optimization",
      content: dedent`
        For each hotspot, find optimal start/end times by:
        1. Analyzing the transcript around the hotspot (±30s)
        2. Finding natural sentence boundaries (periods, question marks, etc.)
        3. Ensuring clips feel complete (full thoughts, not cut mid-sentence)
        4. Respecting duration constraints (min/max)
        5. Avoiding overlap with other clips
        6. Preferring slightly longer clips if content is compelling`,
    },
    metadataGuidelines: {
      tag: "metadata_guidelines",
      content: dedent`
        - Title: Compelling hook under 60 characters (no "Video of...", start with action)
        - Description: 1-2 sentences explaining what happens, using context from full transcript
        - Keywords: 3-5 searchable terms (actions, subjects, themes) informed by overall content
        - Platforms: Suggest based on:
          * Content type (tutorial → YouTube, entertainment → TikTok, professional → LinkedIn)
          * Pacing (fast-paced → TikTok/Reels, measured → YouTube)
          * Language style (casual → TikTok, formal → LinkedIn)
          * Visual complexity
          * Typical content length for that platform`,
    },
    constraints: {
      tag: "constraints",
      content: dedent`
        - Return only valid JSON matching the schema
        - Ensure no clips overlap in final output
        - Rank clips by engagement score and content quality
        - If content isn't suitable for a platform, don't suggest it`,
    },
  },
  sectionOrder: [
    "role",
    "context",
    "boundaryOptimization",
    "metadataGuidelines",
    "constraints",
  ],
});

/**
 * Formats VTT cues for the AI prompt
 */
function formatCuesForPrompt(cues: VTTCue[]): string {
  return cues
    .map(
      cue =>
        `[${cue.startTime.toFixed(1)}s - ${cue.endTime.toFixed(1)}s] ${cue.text}`,
    )
    .join("\n");
}

/**
 * Builds the user prompt with all context
 */
function buildUserPrompt({
  durationSeconds,
  storyboardUrl,
  fullTranscriptText,
  hotspots,
  thumbnailUrls,
  vttCues,
  minClipDuration,
  maxClipDuration,
  targetDuration,
}: {
  durationSeconds: number;
  storyboardUrl: string;
  fullTranscriptText: string;
  hotspots: Hotspot[];
  thumbnailUrls: string[];
  vttCues: VTTCue[];
  minClipDuration: number;
  maxClipDuration: number;
  targetDuration?: number;
}): string {
  const hotspotThumbnailList = hotspots
    .map((h, idx) => `Time ${(h.startMs / 1000).toFixed(1)}s: ${thumbnailUrls[idx]}`)
    .join("\n");

  return dedent`
    <video_context>
      <duration>${durationSeconds} seconds</duration>
      <storyboard_url>${storyboardUrl}</storyboard_url>
    </video_context>

    <full_transcript>
    ${fullTranscriptText}
    </full_transcript>

    <engagement_hotspots>
    ${JSON.stringify(
      hotspots.map(h => ({
        startMs: h.startMs,
        endMs: h.endMs,
        score: h.score,
      })),
      null,
      2,
    )}
    </engagement_hotspots>

    <hotspot_thumbnails>
    ${hotspotThumbnailList}
    </hotspot_thumbnails>

    <detailed_transcript_cues>
    ${formatCuesForPrompt(vttCues)}
    </detailed_transcript_cues>

    <constraints>
    - Minimum clip duration: ${minClipDuration}s
    - Maximum clip duration: ${maxClipDuration}s
    ${targetDuration ? `- Preferred duration: ${targetDuration}s` : ""}
    </constraints>

    First, analyze the full transcript to understand the overall content, themes, and style.
    Then, for each hotspot, optimize clip boundaries and generate metadata that makes sense
    in the context of the full video.
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyzes hotspots and generates optimized clip boundaries and metadata using AI
 */
async function analyzeClipsWithAI({
  provider,
  modelId,
  userPrompt,
  systemPrompt,
  credentials,
}: {
  provider: SupportedProvider;
  modelId: string;
  userPrompt: string;
  systemPrompt: string;
  credentials?: WorkflowCredentialsInput;
}): Promise<{ clips: AnalyzedClip[]; usage: TokenUsage }> {
  "use step";

  const model = await createLanguageModelFromConfig(provider, modelId, credentials);

  const response = await withRetry(() =>
    generateText({
      model,
      output: CLIP_ANALYSIS_OUTPUT,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
    }),
  );

  if (!response.output) {
    throw new Error("Clip analysis output missing");
  }

  return {
    clips: response.output.clips,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      reasoningTokens: response.usage.reasoningTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
    },
  };
}

/**
 * Creates Mux clip assets from analyzed clips
 */
async function createClipAssets(
  assetId: string,
  clips: AnalyzedClip[],
  credentials?: WorkflowCredentialsInput,
): Promise<ClipMetadata[]> {
  "use step";

  const muxClient = await getMuxClientFromEnv(credentials);
  const mux = await muxClient.createClient();

  const clipMetadataList: ClipMetadata[] = [];

  for (const clip of clips) {
    try {
      const clipAsset = await mux.video.assets.create({
        inputs: [
          {
            url: `mux://assets/${assetId}`,
            start_time: clip.startTime,
            end_time: clip.endTime,
          },
        ],
        passthrough: JSON.stringify({
          title: clip.title,
          description: clip.description,
          keywords: clip.keywords.join(", "),
          source_asset: assetId,
          engagement_score: clip.engagementScore,
          suggested_platforms: clip.suggestedPlatforms.join(", "),
        }),
        playback_policy: ["public"], // TODO: Inherit from source asset?
      });

      const playbackId = clipAsset.playback_ids?.[0]?.id;

      clipMetadataList.push({
        startTime: clip.startTime,
        endTime: clip.endTime,
        duration: clip.endTime - clip.startTime,
        title: clip.title,
        description: clip.description,
        keywords: clip.keywords,
        engagementScore: clip.engagementScore,
        suggestedPlatforms: clip.suggestedPlatforms,
        clipAssetId: clipAsset.id,
        clipPlaybackId: playbackId,
        clipUrl: playbackId ?
          `https://stream.mux.com/${playbackId}.m3u8` :
          undefined,
        thumbnailUrl: playbackId ?
          `https://image.mux.com/${playbackId}/thumbnail.png?width=640&time=${(clip.endTime - clip.startTime) / 2}` :
          undefined,
        assetStatus: clipAsset.status || "preparing",
      });
    } catch (error) {
      // Continue creating other clips even if one fails
      console.error(`Failed to create clip asset for ${clip.title}:`, error);
      clipMetadataList.push({
        startTime: clip.startTime,
        endTime: clip.endTime,
        duration: clip.endTime - clip.startTime,
        title: clip.title,
        description: clip.description,
        keywords: clip.keywords,
        engagementScore: clip.engagementScore,
        suggestedPlatforms: clip.suggestedPlatforms,
        assetStatus: "errored",
      });
    }
  }

  return clipMetadataList;
}

/**
 * Generates highlight clips from a Mux asset based on engagement hotspots.
 *
 * This workflow:
 * 1. Fetches engagement hotspots from Mux Data API
 * 2. Analyzes content with AI to find optimal clip boundaries
 * 3. Generates compelling metadata for each clip
 * 4. Creates clip assets in Mux (unless dryRun is true)
 *
 * @param assetId - Mux asset ID
 * @param options - Configuration options
 * @returns Highlight clips with metadata and URLs
 */
export async function generateHighlightClips(
  assetId: string,
  options: HighlightClipsOptions = {},
): Promise<GenerateHighlightClipsResult> {
  "use workflow";

  const {
    maxClips = 5,
    minClipDuration = 15,
    maxClipDuration = 90,
    targetDuration,
    timeframe = "[7:days]",
    dryRun = false,
    provider = "openai",
    model,
    credentials,
  } = options;

  // Resolve model configuration
  const modelConfig = resolveLanguageModelConfig({
    ...options,
    model,
    provider: provider as SupportedProvider,
  });

  // Step 1: Fetch engagement hotspots
  const hotspots = await getHotspotsForAsset(assetId, {
    limit: maxClips,
    timeframe,
    credentials,
  });

  if (hotspots.length === 0) {
    return {
      assetId,
      clips: [],
      totalClipsGenerated: 0,
      totalEngagementScore: 0,
    };
  }

  // Step 2: Fetch asset metadata
  const { asset: assetData, playbackId, policy } = await getPlaybackIdForAsset(
    assetId,
    credentials,
  );
  const durationSeconds = getAssetDurationSecondsFromAsset(assetData);

  if (!durationSeconds) {
    throw new Error(`Asset ${assetId} has no duration`);
  }

  // Handle signed playback IDs
  const signingContext = await resolveMuxSigningContext(credentials);
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. " +
      "Set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  const shouldSign = policy === "signed";

  // Step 3: Fetch transcript and storyboard
  const transcriptResult = await fetchTranscriptForAsset(assetData, playbackId, {
    cleanTranscript: false, // Preserve VTT timestamps
    shouldSign,
    credentials,
  });

  if (!transcriptResult.transcriptText) {
    console.warn("No transcript found for asset, proceeding with limited context");
  }

  const fullTranscriptText = transcriptResult.transcriptText ?
      extractTextFromVTT(transcriptResult.transcriptText) :
    "";
  const vttCues = transcriptResult.transcriptText ?
      parseVTTCues(transcriptResult.transcriptText) :
      [];

  // Get storyboard for overall visual context
  const storyboardUrl = await getStoryboardUrl(playbackId, 640, shouldSign, credentials);

  // Get thumbnails at each hotspot timestamp for detailed analysis
  const hotspotTimestamps = hotspots.map(h => h.startMs / 1000);
  const thumbnailUrls = await Promise.all(
    hotspotTimestamps.map(async (timestamp) => {
      const urls = await getThumbnailUrls(playbackId, durationSeconds, {
        interval: durationSeconds, // Just get one thumbnail
        width: 640,
        shouldSign,
        credentials,
      });
      // Generate thumbnail URL at specific timestamp
      return shouldSign ?
        urls[0] :
        `https://image.mux.com/${playbackId}/thumbnail.png?time=${timestamp}&width=640`;
    }),
  );

  // Step 4: AI batch analysis
  const systemPrompt = clipAnalysisSystemPromptBuilder.build();
  const userPrompt = buildUserPrompt({
    durationSeconds,
    storyboardUrl,
    fullTranscriptText,
    hotspots,
    thumbnailUrls,
    vttCues,
    minClipDuration,
    maxClipDuration,
    targetDuration,
  });

  let analysisResult: { clips: AnalyzedClip[]; usage: TokenUsage };
  try {
    analysisResult = await analyzeClipsWithAI({
      provider: modelConfig.provider,
      modelId: modelConfig.modelId,
      userPrompt,
      systemPrompt,
      credentials,
    });
  } catch (error) {
    throw new Error(
      `Failed to analyze clips with ${provider}: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  if (!analysisResult.clips || analysisResult.clips.length === 0) {
    return {
      assetId,
      clips: [],
      usage: analysisResult.usage,
      totalClipsGenerated: 0,
      totalEngagementScore: 0,
    };
  }

  // Step 5: Create clip assets (unless dryRun)
  let clipMetadataList: ClipMetadata[];

  if (dryRun) {
    // Dry run: just return analysis without creating assets
    clipMetadataList = analysisResult.clips.map(clip => ({
      startTime: clip.startTime,
      endTime: clip.endTime,
      duration: clip.endTime - clip.startTime,
      title: clip.title,
      description: clip.description,
      keywords: clip.keywords,
      engagementScore: clip.engagementScore,
      suggestedPlatforms: clip.suggestedPlatforms,
    }));
  } else {
    // Create actual Mux clip assets
    clipMetadataList = await createClipAssets(assetId, analysisResult.clips, credentials);
  }

  const totalEngagementScore = clipMetadataList.reduce(
    (sum, clip) => sum + clip.engagementScore,
    0,
  );

  return {
    assetId,
    clips: clipMetadataList,
    usage: {
      ...analysisResult.usage,
      metadata: {
        assetDurationSeconds: durationSeconds,
      },
    },
    totalClipsGenerated: clipMetadataList.length,
    totalEngagementScore,
  };
}
