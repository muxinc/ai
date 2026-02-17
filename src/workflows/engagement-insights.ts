import { generateText, Output } from "ai";
import dedent from "dedent";
import { z } from "zod";

import { getAssetDurationSecondsFromAsset, getPlaybackIdForAssetWithClient } from "@mux/ai/lib/mux-assets";
import { createPromptBuilder } from "@mux/ai/lib/prompt-builder";
import { createLanguageModelFromConfig, resolveLanguageModelConfig } from "@mux/ai/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "@mux/ai/lib/providers";
import { resolveMuxClient, resolveMuxSigningContext } from "@mux/ai/lib/workflow-credentials";
import type { HeatmapResponse } from "@mux/ai/primitives/heatmap";
import { getHeatmapForAsset } from "@mux/ai/primitives/heatmap";
import type { Hotspot } from "@mux/ai/primitives/hotspots";
import { getHotspotsForAsset } from "@mux/ai/primitives/hotspots";
import { fetchTranscriptForAsset, parseVTTCues, secondsToTimestamp } from "@mux/ai/primitives/transcripts";
import type { MuxAIOptions, TokenUsage, WorkflowCredentialsInput } from "@mux/ai/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration options for engagement insights workflow. */
export interface EngagementInsightsOptions extends MuxAIOptions {
  /** AI provider to run (defaults to 'openai'). */
  provider?: SupportedProvider;
  /** Provider-specific chat model identifier. */
  model?: ModelIdByProvider[SupportedProvider];
  /** Number of engagement moments to analyze (default: 5, max: 10) */
  hotspotLimit?: number;
  /** Type of insights to generate (default: 'informational') */
  insightType?: "informational" | "actionable" | "both";
  /** Timeframe for engagement data (default: '[7:days]') */
  timeframe?: string;
}

/** A single moment insight for a specific engagement hotspot */
export interface MomentInsight {
  /** Start time in milliseconds */
  startMs: number;
  /** End time in milliseconds */
  endMs: number;
  /** Human-readable timestamp (e.g., "2:15") */
  timestamp: string;
  /** Normalized engagement score (0-1) */
  engagementScore: number;
  /** Type of engagement moment: 'high' (above average) or 'low' (below average) */
  type: "high" | "low";
  /** Primary insight explaining the engagement pattern */
  insight: string;
  /** Optional actionable recommendation (present if insightType is 'actionable' or 'both') */
  recommendation?: string;
  /** Confidence score for this insight (0-1) based on clarity of evidence */
  confidence: number;
}

/** Overall engagement analysis across the entire video */
export interface OverallInsight {
  /** Summary of overall engagement patterns */
  summary: string;
  /** Key trends identified across the video */
  trends: string[];
  /** Recommended optimizations (if insightType is 'actionable' or 'both') */
  recommendations?: string[];
}

/** Statistics computed from heatmap data */
export interface HeatmapStatistics {
  average: number;
  peak: { index: number; value: number; timestamp: string };
  lowest: { index: number; value: number; timestamp: string };
  /** Segments where engagement drops >25% from local average */
  significantDrops: Array<{
    startIndex: number;
    endIndex: number;
    dropPercentage: number;
    timestamp: string;
  }>;
}

/** Transcript segment aligned with a hotspot */
interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  timestamp: string;
}

/** Structured return payload for engagement insights workflow. */
export interface EngagementInsightsResult {
  /** Asset ID passed into the workflow. */
  assetId: string;
  /** Per-moment insights for each hotspot */
  momentInsights: MomentInsight[];
  /** Overall engagement analysis */
  overallInsight: OverallInsight;
  /** Token usage from the AI provider (for efficiency/cost analysis). */
  usage?: TokenUsage;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** Zod schema for a single moment insight. */
export const momentInsightSchema = z.object({
  startMs: z.number(),
  endMs: z.number(),
  timestamp: z.string(),
  engagementScore: z.number(),
  type: z.enum(["high", "low"]),
  insight: z.string(),
  recommendation: z.string(),
  confidence: z.number(),
});

export type MomentInsightType = z.infer<typeof momentInsightSchema>;

/** Zod schema for overall insight. */
export const overallInsightSchema = z.object({
  summary: z.string(),
  trends: z.array(z.string()),
  recommendations: z.array(z.string()),
});

export type OverallInsightType = z.infer<typeof overallInsightSchema>;

/** Combined schema for AI response */
const engagementInsightsSchema = z.object({
  momentInsights: z.array(momentInsightSchema),
  overallInsight: overallInsightSchema,
});

export type EngagementInsightsType = z.infer<typeof engagementInsightsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = dedent`
  <role>
    You are a video engagement analyst specializing in understanding viewer behavior.
    Your job is to explain why specific moments in videos have high or low engagement
    based on visual content, audio/dialogue, and viewer watch patterns.
  </role>

  <context>
    You will receive:
    - Engagement data showing which segments are most/least re-watched (hotspots)
    - Thumbnail images at key timestamps
    - Transcript with timestamps (if available)
    - Overall engagement curve statistics

    Engagement scores are normalized (0-1) where higher values indicate more re-watching.
  </context>

  <task>
    For each engagement moment (hotspot), analyze:
    1. What visual or audio content is present
    2. Why viewers might find it engaging (or disengaging)
    3. Observable patterns that correlate with engagement

    Base your insights on OBSERVABLE EVIDENCE from visuals and transcript.
  </task>

  <constraints>
    - Only describe what you can see in thumbnails or read in transcripts
    - Do not fabricate details or make unsupported assumptions
    - Correlate engagement scores with observable content
    - Return structured data matching the requested schema exactly
  </constraints>

  <quality_guidelines>
    - Be specific: cite timestamps, visual elements, or transcript quotes
    - Focus on patterns: "demonstration moments", "pacing changes", etc.
    - Avoid generic statements like "interesting content"
    - Connect engagement data to content features
  </quality_guidelines>
`;

const AUDIO_ONLY_SYSTEM_PROMPT = dedent`
  <role>
    You are a video engagement analyst specializing in understanding viewer behavior for audio content.
    Your job is to explain why specific moments have high or low engagement based on audio/dialogue and viewer watch patterns.
  </role>

  <context>
    You will receive:
    - Engagement data showing which segments are most/least re-watched (hotspots)
    - Transcript with timestamps
    - Overall engagement curve statistics

    Note: This is audio-only content with no visual elements.
    Engagement scores are normalized (0-1) where higher values indicate more re-watching.
  </context>

  <task>
    For each engagement moment (hotspot), analyze:
    1. What audio content or dialogue is present
    2. Why listeners might find it engaging (or disengaging)
    3. Observable patterns that correlate with engagement

    Base your insights on OBSERVABLE EVIDENCE from the transcript.
  </task>

  <constraints>
    - Only describe what you can read in the transcript
    - Do not fabricate details or make unsupported assumptions
    - Correlate engagement scores with observable content
    - Return structured data matching the requested schema exactly
  </constraints>

  <quality_guidelines>
    - Be specific: cite timestamps or transcript quotes
    - Focus on patterns: "topic changes", "pacing", "dialogue style", etc.
    - Avoid generic statements like "interesting content"
    - Connect engagement data to content features
  </quality_guidelines>
`;

function buildInsightTypeGuidelines(insightType: "informational" | "actionable" | "both"): string {
  switch (insightType) {
    case "informational":
      return dedent`
        <insight_style>
          Provide explanatory insights that describe WHY moments are engaging.
          Focus on observable patterns and viewer behavior correlation.
          Example: "The cooking demonstration at 2:15 has 3x average engagement
          because it shows the key technique viewers are searching for."

          For the 'recommendation' field, provide an empty string ("") since we only want explanations.
          For the 'recommendations' array in overallInsight, provide an empty array ([]).
        </insight_style>
      `;

    case "actionable":
      return dedent`
        <insight_style>
          Provide actionable recommendations for content optimization.
          Focus on what could be improved or changed.
          Example: "Engagement drops 40% after the intro, suggesting the pacing
          could be improved by moving the demonstration earlier."

          For the 'insight' field, provide a brief context, then focus on the 'recommendation' field.
          Both fields are required - use 'insight' for context and 'recommendation' for the actionable advice.
        </insight_style>
      `;

    case "both":
      return dedent`
        <insight_style>
          Provide both explanation AND recommendations.
          First explain why engagement occurs (in the 'insight' field),
          then suggest optimizations (in the 'recommendation' field).
          Example insight: "The Q&A section at 5:30 has low engagement (0.3x average) because the questions are generic."
          Example recommendation: "Consider using viewer-submitted questions to increase relevance."

          Both 'insight' and 'recommendation' fields must be filled with meaningful content.
        </insight_style>
      `;
  }
}

type EngagementInsightsPromptSections = "task" | "insightGuidelines" | "outputFormat";

const engagementInsightsPromptBuilder = createPromptBuilder<EngagementInsightsPromptSections>({
  template: {
    task: {
      tag: "task",
      content: "Analyze the engagement data and visual/audio content to generate insights.",
    },
    insightGuidelines: {
      tag: "insight_guidelines",
      content: "", // Dynamically filled based on insightType
    },
    outputFormat: {
      tag: "output_format",
      content: dedent`
        Return valid JSON matching the provided schema.
        Include insights for each hotspot and overall engagement trends.
      `,
    },
  },
  sectionOrder: ["task", "insightGuidelines", "outputFormat"],
});

function buildUserPrompt(
  hotspots: Hotspot[],
  transcriptSegments: TranscriptSegment[],
  heatmapStats: HeatmapStatistics,
  insightType: "informational" | "actionable" | "both",
): string {
  // Build hotspot data
  const hotspotData = hotspots
    .map((h, idx) => {
      const transcript = transcriptSegments[idx]?.text || "(no transcript)";
      const startTimestamp = secondsToTimestamp(h.startMs / 1000);
      const endTimestamp = secondsToTimestamp(h.endMs / 1000);

      return dedent`
        Hotspot ${idx + 1}:
        - Time Range: ${startTimestamp} - ${endTimestamp}
        - Engagement Score: ${h.score.toFixed(2)} (0=low, 1=high)
        - Transcript: "${transcript}"
      `;
    })
    .join("\n\n");

  // Build heatmap statistics
  const heatmapData = dedent`
    Overall Engagement Statistics:
    - Average engagement level: ${heatmapStats.average.toFixed(2)}
    - Peak engagement: ${heatmapStats.peak.timestamp} (value: ${heatmapStats.peak.value.toFixed(2)})
    - Lowest engagement: ${heatmapStats.lowest.timestamp} (value: ${heatmapStats.lowest.value.toFixed(2)})
    - Significant drops: ${heatmapStats.significantDrops.length} detected
    ${heatmapStats.significantDrops.map(d => `  - ${d.timestamp}: ${d.dropPercentage.toFixed(1)}% drop`).join("\n")}
  `;

  const insightGuidelines = buildInsightTypeGuidelines(insightType);

  const contextSections = [
    {
      tag: "engagement_hotspots",
      content: hotspotData,
    },
    {
      tag: "heatmap_analysis",
      content: heatmapData,
    },
  ];

  return engagementInsightsPromptBuilder.buildWithContext({ insightGuidelines }, contextSections);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes statistics from heatmap data including average, peak, lowest,
 * and significant engagement drops.
 */
function computeHeatmapStatistics(heatmap: number[], durationSeconds: number): HeatmapStatistics {
  const average = heatmap.reduce((sum, val) => sum + val, 0) / heatmap.length;

  const peakIndex = heatmap.indexOf(Math.max(...heatmap));
  const lowestIndex = heatmap.indexOf(Math.min(...heatmap));

  const indexToTimestamp = (index: number) => {
    const seconds = (index / 100) * durationSeconds;
    return secondsToTimestamp(seconds);
  };

  // Detect significant drops (>25% drop from rolling average)
  const significantDrops: HeatmapStatistics["significantDrops"] = [];
  const windowSize = 5; // 5% of video

  for (let i = windowSize; i < heatmap.length - windowSize; i++) {
    const before = heatmap.slice(i - windowSize, i);
    const avgBefore = before.reduce((a, b) => a + b, 0) / before.length;
    const current = heatmap[i];

    if (avgBefore > 0 && current / avgBefore < 0.75) {
      // 25% drop
      significantDrops.push({
        startIndex: i,
        endIndex: i + 1,
        dropPercentage: ((avgBefore - current) / avgBefore) * 100,
        timestamp: indexToTimestamp(i),
      });
    }
  }

  return {
    average,
    peak: {
      index: peakIndex,
      value: heatmap[peakIndex],
      timestamp: indexToTimestamp(peakIndex),
    },
    lowest: {
      index: lowestIndex,
      value: heatmap[lowestIndex],
      timestamp: indexToTimestamp(lowestIndex),
    },
    significantDrops,
  };
}

/**
 * Generates thumbnail URLs for specific timestamps.
 */
async function getThumbnailsAtTimestamps(
  playbackId: string,
  timestamps: number[],
  options: {
    width?: number;
    shouldSign?: boolean;
    credentials?: WorkflowCredentialsInput;
  },
): Promise<string[]> {
  "use step";

  const { width = 640, shouldSign = false } = options;
  const baseUrl = `https://image.mux.com/${playbackId}/thumbnail.png`;

  // For simplicity, we're not implementing URL signing yet
  // This can be added later following the pattern in storyboards.ts
  if (shouldSign) {
    // TODO: Implement URL signing if needed
    throw new Error("Thumbnail URL signing not yet implemented");
  }

  return timestamps.map(time => `${baseUrl}?time=${time}&width=${width}`);
}

/**
 * Extracts transcript segments that align with hotspot time ranges.
 */
function extractTranscriptSegmentsForHotspots(
  vttContent: string,
  hotspots: Hotspot[],
): TranscriptSegment[] {
  if (!vttContent.trim())
    return [];

  const cues = parseVTTCues(vttContent);

  return hotspots.map((hotspot) => {
    const startSec = hotspot.startMs / 1000;
    const endSec = hotspot.endMs / 1000;

    // Find all cues that overlap with this hotspot
    const relevantCues = cues.filter(
      cue => cue.startTime < endSec && cue.endTime > startSec,
    );

    const text = relevantCues.map(c => c.text).join(" ");

    return {
      startMs: hotspot.startMs,
      endMs: hotspot.endMs,
      text,
      timestamp: secondsToTimestamp(startSec),
    };
  });
}

/**
 * Fetches engagement data (peaks, valleys, and heatmap) in parallel.
 */
async function fetchEngagementData(
  assetId: string,
  options: {
    hotspotLimit: number;
    timeframe: string;
    credentials?: WorkflowCredentialsInput;
  },
): Promise<{
  hotspots: Hotspot[];
  heatmap: HeatmapResponse;
}> {
  "use step";

  const { hotspotLimit, timeframe, credentials } = options;

  // Fetch peaks (desc), valleys (asc), and heatmap in parallel
  const [peaks, valleys, heatmap] = await Promise.all([
    getHotspotsForAsset(assetId, {
      limit: hotspotLimit,
      orderDirection: "desc",
      timeframe,
      credentials,
    }),
    getHotspotsForAsset(assetId, {
      limit: hotspotLimit,
      orderDirection: "asc",
      timeframe,
      credentials,
    }),
    getHeatmapForAsset(assetId, {
      timeframe,
      credentials,
    }),
  ]);

  // Combine peaks and valleys, sort by timestamp
  const allHotspots = [...peaks, ...valleys].sort((a, b) => a.startMs - b.startMs);

  return {
    hotspots: allHotspots,
    heatmap,
  };
}

interface AnalysisResponse {
  result: EngagementInsightsType;
  usage: TokenUsage;
}

/**
 * Generates insights using AI with structured output.
 */
async function generateInsightsWithAI(
  provider: SupportedProvider,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  thumbnailUrls: string[],
  credentials?: WorkflowCredentialsInput,
): Promise<AnalysisResponse> {
  "use step";

  const model = await createLanguageModelFromConfig(provider, modelId, credentials);

  const response = await generateText({
    model,
    output: Output.object({ schema: engagementInsightsSchema }),
    experimental_telemetry: { isEnabled: true },
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          ...thumbnailUrls.map(url => ({ type: "image" as const, image: url })),
        ],
      },
    ],
  });

  return {
    result: response.output,
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
 * Generate engagement insights for a Mux video asset.
 *
 * This workflow analyzes viewer engagement patterns to explain why certain moments
 * are engaging or disengaging. It combines hotspot data, heatmap statistics, visual
 * frames, and transcript analysis to generate AI-powered insights.
 *
 * @param assetId - The Mux asset ID to analyze
 * @param options - Configuration options for the workflow
 * @returns Structured insights with moment-by-moment and overall analysis
 *
 * @example
 * ```typescript
 * const result = await generateEngagementInsights("abc123", {
 *   insightType: 'both',
 *   hotspotLimit: 5,
 * });
 *
 * console.log(result.momentInsights[0]);
 * // {
 * //   timestamp: "2:15",
 * //   engagementScore: 0.875,
 * //   type: "high",
 * //   insight: "The cooking demonstration shows the key technique...",
 * //   recommendation: "Consider expanding technique demonstrations...",
 * //   confidence: 0.92
 * // }
 * ```
 */
export async function generateEngagementInsights(
  assetId: string,
  options: EngagementInsightsOptions = {},
): Promise<EngagementInsightsResult> {
  "use workflow";

  const {
    provider = "openai",
    model,
    hotspotLimit = 5,
    insightType = "informational",
    timeframe = "[7:days]",
    credentials,
  } = options;

  // Validate configuration
  if (hotspotLimit < 1 || hotspotLimit > 10) {
    throw new Error("hotspotLimit must be between 1 and 10");
  }

  // Resolve configuration
  const modelConfig = resolveLanguageModelConfig({
    ...options,
    model,
    provider: provider as SupportedProvider,
  });
  const muxClient = await resolveMuxClient(credentials);

  // Fetch asset metadata and playback ID
  const { asset, playbackId, policy } = await getPlaybackIdForAssetWithClient(
    assetId,
    muxClient,
  );
  const assetDurationSeconds = getAssetDurationSecondsFromAsset(asset);

  if (!assetDurationSeconds) {
    throw new Error(`Asset ${assetId} has no valid duration`);
  }

  // Check if audio-only
  const isAudioOnly =
    asset.aspect_ratio === null ||
    !asset.tracks?.some(track => track.type === "video");

  // Resolve signing context
  const signingContext = await resolveMuxSigningContext(credentials);
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. " +
      "Set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  const shouldSign = policy === "signed";

  // Step 1: Fetch engagement data (peaks, valleys, heatmap in parallel)
  const { hotspots, heatmap } = await fetchEngagementData(assetId, {
    hotspotLimit,
    timeframe,
    credentials,
  });

  // Validate engagement data exists
  if (hotspots.length === 0) {
    throw new Error(
      `No engagement data available for asset ${assetId} in timeframe ${timeframe}. ` +
      `Video may not have been viewed yet or engagement tracking is not enabled.`,
    );
  }

  // Step 2: Compute heatmap statistics
  const heatmapStats = computeHeatmapStatistics(heatmap.heatmap, assetDurationSeconds);

  // Step 3: Fetch transcript
  const transcriptResult = await fetchTranscriptForAsset(asset, playbackId, {
    cleanTranscript: false, // Keep timestamps
    shouldSign,
    credentials,
  });

  const transcriptText = transcriptResult.transcriptText || "";

  if (!transcriptText.trim()) {
    console.warn(
      `No transcript available for asset ${assetId}. ` +
      `Insights will be based solely on visual analysis and engagement patterns.`,
    );
  }

  // Step 4: Extract transcript segments for each hotspot
  const transcriptSegments = extractTranscriptSegmentsForHotspots(transcriptText, hotspots);

  // Step 5: Fetch thumbnails for hotspot timestamps
  let thumbnailUrls: string[] = [];

  if (isAudioOnly) {
    console.warn(
      `Asset ${assetId} is audio-only. Insights will be based solely on ` +
      `transcript and engagement data without visual analysis.`,
    );
  } else {
    const timestamps = hotspots.map(h => Math.floor(h.startMs / 1000));
    thumbnailUrls = await getThumbnailsAtTimestamps(playbackId, timestamps, {
      width: 640,
      shouldSign,
      credentials,
    });
  }

  // Step 6: Build prompts
  const systemPrompt = isAudioOnly ? AUDIO_ONLY_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const userPrompt = buildUserPrompt(hotspots, transcriptSegments, heatmapStats, insightType);

  // Step 7: Generate insights with AI
  const { result: insights, usage } = await generateInsightsWithAI(
    modelConfig.provider,
    modelConfig.modelId,
    systemPrompt,
    userPrompt,
    thumbnailUrls,
    credentials,
  );

  // Step 8: Validate and enrich results
  if (!insights.momentInsights || insights.momentInsights.length === 0) {
    throw new Error("Failed to generate insights from AI response");
  }

  const usageWithMetadata: TokenUsage = {
    ...usage,
    metadata: {
      assetDurationSeconds,
      thumbnailCount: thumbnailUrls.length,
    },
  };

  // Transform results: convert empty strings/arrays to undefined for optional fields
  const transformedMomentInsights = insights.momentInsights.map(insight => ({
    ...insight,
    recommendation: insight.recommendation === "" ? undefined : insight.recommendation,
  }));

  const transformedOverallInsight = {
    ...insights.overallInsight,
    recommendations:
      insights.overallInsight.recommendations.length === 0 ?
        undefined :
        insights.overallInsight.recommendations,
  };

  return {
    assetId,
    momentInsights: transformedMomentInsights,
    overallInsight: transformedOverallInsight,
    usage: usageWithMetadata,
  };
}
