import { generateText, Output } from "ai";
import dedent from "dedent";
import { z } from "zod";

import {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  isAudioOnlyAsset,
} from "@mux/ai/lib/mux-assets";
import type { PromptOverrides } from "@mux/ai/lib/prompt-builder";
import { createPromptBuilder } from "@mux/ai/lib/prompt-builder";
import { createLanguageModelFromConfig, resolveLanguageModelConfig } from "@mux/ai/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "@mux/ai/lib/providers";
import { withRetry } from "@mux/ai/lib/retry";
import { resolveMuxSigningContext } from "@mux/ai/lib/workflow-credentials";
import type { HeatmapResponse, HeatmapStatistics } from "@mux/ai/primitives/heatmap";
import { computeHeatmapPercentile, computeHeatmapStatistics, getHeatmapForAsset } from "@mux/ai/primitives/heatmap";
import type { Hotspot } from "@mux/ai/primitives/hotspots";
import { getHotspotsForAsset } from "@mux/ai/primitives/hotspots";
import type { Shot } from "@mux/ai/primitives/shots";
import { getShotsForAsset } from "@mux/ai/primitives/shots";
import { getStoryboardUrl } from "@mux/ai/primitives/storyboards";
import { fetchTranscriptForAsset, parseVTTCues, secondsToTimestamp } from "@mux/ai/primitives/transcripts";
import type { MuxAIOptions, TokenUsage, WorkflowCredentialsInput } from "@mux/ai/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sections of the engagement insights user prompt that can be overridden.
 */
export type EngagementInsightsPromptSections =
  "task" |
  "insightGuidelines" |
  "outputFormat" |
  "visualContext";

export type EngagementInsightsPromptOverrides = PromptOverrides<EngagementInsightsPromptSections>;

/** Configuration options for engagement insights workflow. */
export interface EngagementInsightsOptions extends MuxAIOptions {
  /** AI provider to run (defaults to 'openai'). */
  provider?: SupportedProvider;
  /** Provider-specific chat model identifier. */
  model?: ModelIdByProvider[SupportedProvider];
  /**
   * Number of engagement moments to analyze per direction (default: 5, max: 10).
   * Note: actual moment count may be up to 2x this value since both peaks and valleys are fetched.
   */
  hotspotLimit?: number;
  /** Type of insights to generate (default: 'informational') */
  insightType?: "informational" | "actionable" | "both";
  /** Timeframe for engagement data (default: '7:days') */
  timeframe?: string;
  /**
   * Override specific sections of the prompt.
   * Note: overriding `insightGuidelines` will take precedence over the `insightType` option.
   */
  promptOverrides?: EngagementInsightsPromptOverrides;
  /**
   * Skip shots integration and use basic thumbnails instead (default: false).
   * Recommended for latency-sensitive use cases.
   */
  skipShots?: boolean;
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
  /** Percentile rank of this moment's engagement within the video (0-100) */
  percentile: number;
  /** Primary insight explaining the engagement pattern */
  insight: string;
  /** Optional actionable recommendation (present if insightType is 'actionable' or 'both') */
  recommendation?: string;
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
// Zod Schemas (given to AI — type and percentile are injected post-generation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for a single moment insight returned by the AI.
 * Note: recommendation and recommendations are required strings/arrays
 * (not optional) because OpenAI structured output requires all properties
 * in 'required'. The AI returns empty string / empty array when not
 * applicable, and we convert to undefined in the transform step.
 */
const aiMomentInsightSchema = z.object({
  hotspotIndex: z.number(),
  startMs: z.number(),
  endMs: z.number(),
  timestamp: z.string(),
  engagementScore: z.number(),
  insight: z.string(),
  recommendation: z.string(),
});

/** Zod schema for overall insight returned by the AI. */
const aiOverallInsightSchema = z.object({
  summary: z.string(),
  trends: z.array(z.string()),
  recommendations: z.array(z.string()),
});

/** Combined schema for AI response */
const engagementInsightsSchema = z.object({
  momentInsights: z.array(aiMomentInsightSchema),
  overallInsight: aiOverallInsightSchema,
});

type AIEngagementInsightsResult = z.infer<typeof engagementInsightsSchema>;

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
    - Images at key timestamps (shot frames or thumbnails)
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
    - Only describe what you can see in images or read in transcripts
    - Do not fabricate details or make unsupported assumptions
    - Correlate engagement scores with observable content
    - Return structured data matching the requested schema exactly
    - Each momentInsight MUST include the hotspotIndex from the input data
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
    - Each momentInsight MUST include the hotspotIndex from the input data
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

          For the 'recommendation' field, return an empty string ("") since we only want explanations.
          For the 'recommendations' array in overallInsight, return an empty array ([]).
        </insight_style>
      `;

    case "actionable":
      return dedent`
        <insight_style>
          Provide actionable recommendations for content optimization.
          Focus on what could be improved or changed.
          Example: "Engagement drops 40% after the intro, suggesting the pacing
          could be improved by moving the demonstration earlier."

          Use 'insight' for brief context, and 'recommendation' for actionable advice.
          Both fields should have meaningful content.
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
        Each momentInsight must include the hotspotIndex matching the input.
      `,
    },
    visualContext: {
      tag: "visual_context",
      content: dedent`
        Images are provided for each hotspot timestamp.
        A storyboard overview image may also be included showing the full video timeline.
        Use visual evidence from these images to support your engagement analysis.
      `,
    },
  },
  sectionOrder: ["task", "insightGuidelines", "visualContext", "outputFormat"],
});

function buildUserPrompt(
  hotspots: Hotspot[],
  transcriptSegments: TranscriptSegment[],
  heatmapStats: HeatmapStatistics,
  insightType: "informational" | "actionable" | "both",
  isAudioOnly: boolean,
  overrides?: EngagementInsightsPromptOverrides,
): string {
  const hotspotData = hotspots
    .map((h, idx) => {
      const transcript = transcriptSegments[idx]?.text || "(no transcript)";
      const startTimestamp = secondsToTimestamp(h.startMs / 1000);
      const endTimestamp = secondsToTimestamp(h.endMs / 1000);

      return dedent`
        Hotspot ${idx} (hotspotIndex: ${idx}):
        - Time Range: ${startTimestamp} - ${endTimestamp}
        - Engagement Score: ${h.score.toFixed(2)} (0=low, 1=high)
        - Transcript: "${transcript}"
      `;
    })
    .join("\n\n");

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

  // Suppress visual context section for audio-only assets to avoid
  // contradicting the audio-only system prompt ("no visual elements")
  const visualContextOverride = isAudioOnly ? { visualContext: "" } : {};

  return engagementInsightsPromptBuilder.buildWithContext(
    { insightGuidelines, ...visualContextOverride, ...overrides },
    contextSections,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts transcript segments that align with hotspot time ranges.
 */
export function extractTranscriptSegmentsForHotspots(
  vttContent: string,
  hotspots: Hotspot[],
): TranscriptSegment[] {
  if (!vttContent.trim()) {
    return [];
  }

  const cues = parseVTTCues(vttContent);

  return hotspots.map((hotspot) => {
    const startSec = hotspot.startMs / 1000;
    const endSec = hotspot.endMs / 1000;

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
 * Deduplicates hotspots by startMs, keeping the first occurrence.
 */
export function deduplicateHotspots(hotspots: Hotspot[]): Hotspot[] {
  const seen = new Set<number>();
  return hotspots.filter((h) => {
    if (seen.has(h.startMs)) {
      return false;
    }
    seen.add(h.startMs);
    return true;
  });
}

/**
 * Maps each hotspot to its nearest shot image.
 *
 * Algorithm: for each hotspot, find all shots whose startTime falls within
 * [hotspot.startMs/1000, hotspot.endMs/1000]. If any exist, pick the one
 * closest to the midpoint. Otherwise, pick the shot with the nearest
 * startTime to hotspot.startMs/1000.
 */
export function mapShotsToHotspots(shots: Shot[], hotspots: Hotspot[]): string[] {
  if (shots.length === 0) {
    return [];
  }

  return hotspots.map((hotspot) => {
    const startSec = hotspot.startMs / 1000;
    const endSec = hotspot.endMs / 1000;
    const midpoint = (startSec + endSec) / 2;

    // Find shots within the hotspot's time range
    const inRange = shots.filter(
      s => s.startTime >= startSec && s.startTime <= endSec,
    );

    if (inRange.length > 0) {
      // Pick closest to midpoint
      const closest = inRange.reduce((best, s) =>
        Math.abs(s.startTime - midpoint) < Math.abs(best.startTime - midpoint) ? s : best,
      );
      return closest.imageUrl;
    }

    // No shot in range — pick nearest to startMs
    const nearest = shots.reduce((best, s) =>
      Math.abs(s.startTime - startSec) < Math.abs(best.startTime - startSec) ? s : best,
    );
    return nearest.imageUrl;
  });
}

/**
 * Generates basic thumbnail URLs as a fallback when shots are unavailable.
 */
function getThumbnailUrlsForHotspots(
  playbackId: string,
  hotspots: Hotspot[],
  width: number = 640,
): string[] {
  const baseUrl = `https://image.mux.com/${playbackId}/thumbnail.png`;
  return hotspots.map(h => `${baseUrl}?time=${Math.floor(h.startMs / 1000)}&width=${width}`);
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

  // Merge, deduplicate by startMs, sort by timestamp
  const merged = [...peaks, ...valleys].sort((a, b) => a.startMs - b.startMs);
  const allHotspots = deduplicateHotspots(merged);

  return {
    hotspots: allHotspots,
    heatmap,
  };
}

/**
 * Generates insights using AI with structured output and retry logic.
 */
async function generateInsightsWithAI(
  provider: SupportedProvider,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  imageUrls: string[],
  credentials?: WorkflowCredentialsInput,
): Promise<{ result: AIEngagementInsightsResult; usage: TokenUsage }> {
  "use step";

  const model = await createLanguageModelFromConfig(provider, modelId, credentials);

  const response = await withRetry(() =>
    generateText({
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
            ...imageUrls.map(url => ({ type: "image" as const, image: url })),
          ],
        },
      ],
    }),
  );

  if (!response.output) {
    throw new Error("AI returned empty or unparseable response");
  }

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

// ─────────────────────────────────────────────────────────────────────────────
// Main Workflow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate engagement insights for a Mux video asset.
 *
 * This workflow analyzes viewer engagement patterns to explain why certain moments
 * are engaging or disengaging. It combines hotspot data, heatmap statistics, visual
 * frames (from shots or thumbnails), and transcript analysis to generate AI-powered insights.
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
 * result.momentInsights.forEach(m => {
 *   console.log(`${m.timestamp} (${m.type}, p${m.percentile}): ${m.insight}`);
 * });
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
    timeframe = "7:days",
    credentials,
    promptOverrides,
    skipShots = false,
  } = options;

  if (!Number.isInteger(hotspotLimit) || hotspotLimit < 1 || hotspotLimit > 10) {
    throw new Error("hotspotLimit must be an integer between 1 and 10");
  }

  const modelConfig = resolveLanguageModelConfig({
    ...options,
    model,
    provider: provider as SupportedProvider,
  });

  // Step 1: Fetch asset metadata
  const { asset, playbackId, policy } = await getPlaybackIdForAsset(assetId, credentials);
  const assetDurationSeconds = getAssetDurationSecondsFromAsset(asset);

  if (!assetDurationSeconds) {
    throw new Error(`Asset ${assetId} has no valid duration`);
  }

  const audioOnly = isAudioOnlyAsset(asset);

  const signingContext = await resolveMuxSigningContext(credentials);
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. " +
      "Set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  const shouldSign = policy === "signed";

  // Step 2: Parallel data fetching
  //
  //   ┌── fetchEngagementData (peaks + valleys + heatmap)
  //   ├── getShotsForAsset (single GET, no polling) OR skip
  //   ├── fetchTranscriptForAsset
  //   └── getStoryboardUrl
  //
  // All fired in parallel via Promise.allSettled. If engagement data
  // returns empty or a fetch fails, we handle after all settle.

  const shouldFetchShots = !skipShots && !audioOnly;

  let shotsPromise: Promise<Awaited<ReturnType<typeof getShotsForAsset>> | null>;
  if (shouldFetchShots) {
    shotsPromise = getShotsForAsset(assetId, { credentials });
  } else {
    shotsPromise = Promise.resolve(null);
  }

  let storyboardPromise: Promise<string | null>;
  if (!audioOnly) {
    storyboardPromise = getStoryboardUrl(playbackId, 640, shouldSign, credentials);
  } else {
    storyboardPromise = Promise.resolve(null);
  }

  const [engagementResult, shotsResult, transcriptResult, storyboardResult] =
    await Promise.allSettled([
      fetchEngagementData(assetId, { hotspotLimit, timeframe, credentials }),
      shotsPromise,
      fetchTranscriptForAsset(asset, playbackId, {
        cleanTranscript: false,
        shouldSign,
        credentials,
      }),
      storyboardPromise,
    ]);

  // Validate engagement data — check for rejected promise first (upstream error),
  // then check for empty data
  if (engagementResult.status === "rejected") {
    throw new Error(
      `Failed to fetch engagement data for asset ${assetId}: ${engagementResult.reason}`,
    );
  }

  const { hotspots, heatmap } = engagementResult.value;

  if (hotspots.length === 0) {
    throw new Error(
      `No engagement data available for asset ${assetId} in timeframe ${timeframe}. ` +
      `Video may not have been viewed yet or engagement tracking is not enabled.`,
    );
  }

  // Step 3: Data correlation
  const heatmapStats = computeHeatmapStatistics(heatmap.heatmap, assetDurationSeconds);

  // Compute engagement type deterministically from heatmap average
  const engagementTypes = hotspots.map(h =>
    h.score > heatmapStats.average ? "high" as const : "low" as const,
  );

  // Compute percentile for each hotspot
  const percentiles = hotspots.map(h =>
    computeHeatmapPercentile(h.score, heatmap.heatmap),
  );

  // Extract transcript segments
  let transcriptText = "";
  if (transcriptResult.status === "fulfilled") {
    transcriptText = transcriptResult.value.transcriptText || "";
  }

  if (!transcriptText.trim()) {
    console.warn(
      `No transcript available for asset ${assetId}. ` +
      `Insights will be based solely on visual analysis and engagement patterns.`,
    );
  }

  const transcriptSegments = extractTranscriptSegmentsForHotspots(transcriptText, hotspots);

  // Resolve images: prefer shots, fall back to thumbnails
  let imageUrls: string[] = [];

  if (audioOnly) {
    console.warn(
      `Asset ${assetId} is audio-only. Insights will be based solely on ` +
      `transcript and engagement data without visual analysis.`,
    );
  } else {
    // Try shots first
    if (shotsResult.status === "fulfilled" && shotsResult.value?.status === "completed") {
      const shotImageUrls = mapShotsToHotspots(shotsResult.value.shots, hotspots);
      if (shotImageUrls.length > 0) {
        imageUrls = shotImageUrls;
      }
    }

    // Fall back to thumbnails if shots unavailable
    if (imageUrls.length === 0) {
      if (shouldFetchShots && shotsResult.status === "fulfilled" && shotsResult.value?.status !== "completed") {
        console.warn(
          `Shots not ready for asset ${assetId} (status: ${shotsResult.value?.status}). Falling back to thumbnails.`,
        );
      } else if (shouldFetchShots && shotsResult.status === "rejected") {
        console.warn(
          `Shots fetch failed for asset ${assetId}. Falling back to thumbnails.`,
        );
      }
      imageUrls = getThumbnailUrlsForHotspots(playbackId, hotspots);
    }

    // Append storyboard as overview context
    if (storyboardResult.status === "fulfilled" && storyboardResult.value) {
      imageUrls.push(storyboardResult.value);
    }
  }

  // Step 4: Build prompts
  const systemPrompt = audioOnly ? AUDIO_ONLY_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const userPrompt = buildUserPrompt(
    hotspots,
    transcriptSegments,
    heatmapStats,
    insightType,
    audioOnly,
    promptOverrides,
  );

  // Step 5: Generate insights with AI
  const { result: aiInsights, usage } = await generateInsightsWithAI(
    modelConfig.provider,
    modelConfig.modelId,
    systemPrompt,
    userPrompt,
    imageUrls,
    credentials,
  );

  if (!aiInsights.momentInsights || aiInsights.momentInsights.length === 0) {
    throw new Error("Failed to generate insights from AI response");
  }

  // Step 6: Transform — re-associate by hotspotIndex, inject type + percentile
  const momentInsights: MomentInsight[] = [];

  for (const aiMoment of aiInsights.momentInsights) {
    const idx = aiMoment.hotspotIndex;
    if (idx < 0 || idx >= hotspots.length) {
      console.warn(
        `AI returned hotspotIndex ${idx} which is out of range (0-${hotspots.length - 1}). Skipping.`,
      );
      continue;
    }

    // Use ground-truth data from hotspots array, not AI-generated values
    const hotspot = hotspots[idx];
    momentInsights.push({
      startMs: hotspot.startMs,
      endMs: hotspot.endMs,
      timestamp: secondsToTimestamp(hotspot.startMs / 1000),
      engagementScore: hotspot.score,
      type: engagementTypes[idx],
      percentile: percentiles[idx],
      insight: aiMoment.insight,
      recommendation: aiMoment.recommendation || undefined,
    });
  }

  if (momentInsights.length === 0) {
    throw new Error(
      "AI returned insights but none matched valid hotspot indices. " +
      "This may indicate a prompt or model issue.",
    );
  }

  const usageWithMetadata: TokenUsage = {
    ...usage,
    metadata: {
      assetDurationSeconds,
      thumbnailCount: imageUrls.length,
    },
  };

  return {
    assetId,
    momentInsights,
    overallInsight: {
      summary: aiInsights.overallInsight.summary,
      trends: aiInsights.overallInsight.trends,
      recommendations: aiInsights.overallInsight.recommendations.length > 0 ?
        aiInsights.overallInsight.recommendations :
        undefined,
    },
    usage: usageWithMetadata,
  };
}
