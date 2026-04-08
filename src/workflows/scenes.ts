import { generateText, Output } from "ai";
import dedent from "dedent";
import { z } from "zod";

import { getLanguageName } from "@mux/ai/lib/language-codes";
import {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  isAudioOnlyAsset,
} from "@mux/ai/lib/mux-assets";
import type { PromptOverrides, PromptSection } from "@mux/ai/lib/prompt-builder";
import { createLanguageSection, createPromptBuilder } from "@mux/ai/lib/prompt-builder";
import { createLanguageModelFromConfig, resolveLanguageModelConfig } from "@mux/ai/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "@mux/ai/lib/providers";
import { withRetry } from "@mux/ai/lib/retry";
import { resolveMuxSigningContext } from "@mux/ai/lib/workflow-credentials";
import { waitForShotsForAsset } from "@mux/ai/primitives/shots";
import { fetchTranscriptForAsset, getReadyTextTracks, parseVTTCues, secondsToTimestamp } from "@mux/ai/primitives/transcripts";
import type { MuxAIOptions, TokenUsage, WorkflowCredentialsInput } from "@mux/ai/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export const sceneSchema = z.object({
  startTime: z.number(),
  endTime: z.number(),
  title: z.string(),
});

export type Scene = z.infer<typeof sceneSchema>;

export const scenesSchema = z.object({
  scenes: z.array(sceneSchema),
});

export type ScenesType = z.infer<typeof scenesSchema>;

/** Structured return payload from `generateScenes`. */
export interface ScenesResult {
  assetId: string;
  languageCode: string;
  scenes: Scene[];
  /** Token usage from the AI provider (for efficiency/cost analysis). */
  usage?: TokenUsage;
}

/**
 * Shot-aligned transcript window used to scaffold scene generation.
 * Exported for focused unit tests around temporal alignment logic.
 */
export interface SceneShotWindow {
  startTime: number;
  endTime: number;
  transcriptText: string;
  cueCount: number;
  shotCount: number;
}

/**
 * Sections of the scenes user prompt that can be overridden.
 * Use these to customize segmentation and titling behavior for your use case.
 */
export type ScenesPromptSections =
  "task" |
  "outputFormat" |
  "sceneGuidelines" |
  "boundaryGuidelines" |
  "titleGuidelines";

/**
 * Override specific sections of the scenes prompt.
 *
 * @example
 * ```typescript
 * const result = await generateScenes(assetId, "en", {
 *   promptOverrides: {
 *     titleGuidelines: "Use short, cinematic titles under 5 words.",
 *     boundaryGuidelines: "Prefer fewer, broader scenes unless the visual context clearly changes.",
 *   },
 * });
 * ```
 */
export type ScenesPromptOverrides = PromptOverrides<ScenesPromptSections>;

/** Configuration accepted by `generateScenes`. */
export interface ScenesOptions extends MuxAIOptions {
  /** AI provider used to interpret the shot-aligned transcript windows (defaults to 'openai'). */
  provider?: SupportedProvider;
  /** Provider-specific model identifier. */
  model?: ModelIdByProvider[SupportedProvider];
  /** Override specific sections of the user prompt. */
  promptOverrides?: ScenesPromptOverrides;
  /**
   * Minimum number of scenes to generate per hour of content.
   * Defaults to 6.
   */
  minScenesPerHour?: number;
  /**
   * Maximum number of scenes to generate per hour of content.
   * Defaults to 20.
   */
  maxScenesPerHour?: number;
  /**
   * BCP 47 language code for scene titles (e.g. "en", "fr", "ja").
   * When omitted, auto-detects from the transcript track's language.
   * Falls back to the requested transcript language if no metadata is available.
   */
  outputLanguageCode?: string;
  /** Poll interval forwarded to `waitForShotsForAsset()`. */
  pollIntervalMs?: number;
  /** Max poll attempts forwarded to `waitForShotsForAsset()`. */
  maxAttempts?: number;
  /** Whether to request shot generation before polling (default: true). */
  createShotsIfMissing?: boolean;
  /**
   * Minimum duration for a shot window before it is likely merged into a neighbor.
   * Defaults to 2 seconds.
   */
  minShotWindowDurationSeconds?: number;
}

const DEFAULT_PROVIDER = "openai";
const DEFAULT_MIN_SCENES_PER_HOUR = 6;
const DEFAULT_MAX_SCENES_PER_HOUR = 20;
const DEFAULT_MIN_SHOT_WINDOW_DURATION_SECONDS = 2;

interface ScenesAnalysisResponse {
  scenes: ScenesType;
  usage: TokenUsage;
}

interface NormalizeScenesOptions {
  scenes: Scene[];
  sceneStartCandidates: number[];
  assetDurationSeconds: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function roundToMillisecondPrecision(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampTime(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatSecondsForPrompt(value: number): string {
  return `${roundToMillisecondPrecision(value)}s (${secondsToTimestamp(value)})`;
}

function cueOverlapsWindow(
  cue: { startTime: number; endTime: number },
  startTime: number,
  endTime: number,
): boolean {
  return cue.endTime > startTime && cue.startTime < endTime;
}

function snapToNearestCandidate(value: number, candidates: number[]): number {
  if (candidates.length === 0) {
    return value;
  }

  let nearest = candidates[0];
  let smallestDistance = Math.abs(value - nearest);

  for (const candidate of candidates.slice(1)) {
    const distance = Math.abs(value - candidate);
    if (distance < smallestDistance) {
      nearest = candidate;
      smallestDistance = distance;
    }
  }

  return nearest;
}

function formatShotWindowsForPrompt(shotWindows: SceneShotWindow[]): string {
  return shotWindows
    .map((window, index) => {
      const transcriptText = window.transcriptText || "(no overlapping transcript cues)";

      return dedent`
        Window ${index + 1}
        Start: ${formatSecondsForPrompt(window.startTime)}
        End: ${formatSecondsForPrompt(window.endTime)}
        Shots in window: ${window.shotCount}
        Overlapping cues: ${window.cueCount}
        Transcript: ${transcriptText}`;
    })
    .join("\n\n");
}

/**
 * Builds shot-aligned transcript windows from completed shot anchors and parsed VTT cues.
 * Exported for unit tests.
 */
export function buildShotWindowsForScenes(
  shots: Array<{ startTime: number }>,
  cues: Array<{ startTime: number; endTime: number; text: string }>,
  assetDurationSeconds: number,
): SceneShotWindow[] {
  const orderedAnchors = Array.from(new Set(
    [0, ...shots.map(shot => shot.startTime)]
      .filter(startTime => Number.isFinite(startTime))
      .map(startTime => clampTime(roundToMillisecondPrecision(startTime), 0, assetDurationSeconds)),
  )).sort((a, b) => a - b);

  if (orderedAnchors.length === 0 || orderedAnchors[0] !== 0) {
    orderedAnchors.unshift(0);
  }

  const windows: SceneShotWindow[] = [];

  for (let index = 0; index < orderedAnchors.length; index++) {
    const startTime = orderedAnchors[index];
    const endTime = orderedAnchors[index + 1] ?? assetDurationSeconds;

    if (endTime <= startTime) {
      continue;
    }

    const overlappingCues = cues.filter(cue => cueOverlapsWindow(cue, startTime, endTime));
    const transcriptText = normalizeWhitespace(
      overlappingCues
        .map(cue => cue.text)
        .filter(Boolean)
        .join(" "),
    );

    windows.push({
      startTime,
      endTime,
      transcriptText,
      cueCount: overlappingCues.length,
      shotCount: 1,
    });
  }

  return windows;
}

/**
 * Merges obviously low-signal shot windows to reduce prompt noise.
 * Exported for unit tests.
 */
export function mergeSceneShotWindows(
  shotWindows: SceneShotWindow[],
  minShotWindowDurationSeconds: number = DEFAULT_MIN_SHOT_WINDOW_DURATION_SECONDS,
): SceneShotWindow[] {
  const mergedWindows: SceneShotWindow[] = [];

  for (const shotWindow of shotWindows) {
    const previousWindow = mergedWindows.at(-1);
    if (!previousWindow) {
      mergedWindows.push({ ...shotWindow });
      continue;
    }

    const previousDuration = previousWindow.endTime - previousWindow.startTime;
    const currentDuration = shotWindow.endTime - shotWindow.startTime;
    const previousIsLowSignal = previousDuration < minShotWindowDurationSeconds || !previousWindow.transcriptText;
    const currentIsLowSignal = currentDuration < minShotWindowDurationSeconds && !shotWindow.transcriptText;

    if (previousIsLowSignal || currentIsLowSignal) {
      previousWindow.endTime = shotWindow.endTime;
      previousWindow.cueCount += shotWindow.cueCount;
      previousWindow.shotCount += shotWindow.shotCount;
      previousWindow.transcriptText = normalizeWhitespace(
        `${previousWindow.transcriptText} ${shotWindow.transcriptText}`,
      );
      continue;
    }

    mergedWindows.push({ ...shotWindow });
  }

  return mergedWindows;
}

/**
 * Normalizes model output into stable, ordered, non-overlapping scenes.
 * Exported for unit tests.
 */
export function normalizeScenesForAsset({
  scenes,
  sceneStartCandidates,
  assetDurationSeconds,
}: NormalizeScenesOptions): Scene[] {
  const validCandidates = Array.from(new Set(
    [0, ...sceneStartCandidates]
      .filter(candidate => Number.isFinite(candidate))
      .map(candidate => clampTime(roundToMillisecondPrecision(candidate), 0, assetDurationSeconds)),
  )).sort((a, b) => a - b);

  const scenesByStartTime = new Map<number, string>();

  for (const scene of scenes) {
    if (!Number.isFinite(scene.startTime) || typeof scene.title !== "string") {
      continue;
    }

    const snappedStartTime = snapToNearestCandidate(
      clampTime(scene.startTime, 0, assetDurationSeconds),
      validCandidates,
    );

    if (snappedStartTime >= assetDurationSeconds) {
      continue;
    }

    const title = scene.title.trim();
    if (!title) {
      continue;
    }

    if (!scenesByStartTime.has(snappedStartTime)) {
      scenesByStartTime.set(snappedStartTime, title);
    }
  }

  const normalizedStartEntries = Array.from(scenesByStartTime.entries())
    .map(([startTime, title]) => ({ startTime, title }))
    .sort((a, b) => a.startTime - b.startTime);

  if (normalizedStartEntries.length === 0) {
    throw new Error("No valid scenes found in AI response");
  }

  if (normalizedStartEntries[0].startTime !== 0) {
    normalizedStartEntries[0].startTime = 0;
  }

  const normalizedScenes: Scene[] = normalizedStartEntries
    .map((entry, index, allEntries) => {
      const nextStartTime = allEntries[index + 1]?.startTime ?? assetDurationSeconds;
      const endTime = clampTime(nextStartTime, entry.startTime, assetDurationSeconds);

      return {
        startTime: entry.startTime,
        endTime,
        title: entry.title,
      };
    })
    .filter(scene => scene.endTime > scene.startTime);

  if (normalizedScenes.length === 0) {
    throw new Error("No valid non-overlapping scenes found after normalization");
  }

  return normalizedScenes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

export type SceneSystemPromptSections = "role" | "context" | "constraints" | "qualityGuidelines";

const scenesSystemPromptBuilder = createPromptBuilder<SceneSystemPromptSections>({
  template: {
    role: {
      tag: "role",
      content: "You are a video editor and transcript analyst specializing in segmenting media into coherent scenes.",
    },
    context: {
      tag: "context",
      content: dedent`
        You receive ordered shot-aligned transcript windows.
        Each window starts at a shot boundary and includes the transcript cues that overlap that span.
        Shots are candidate visual anchors for scene starts, but not every shot boundary should become a new scene.
        A scene may contain multiple adjacent shot windows when they belong to the same narrative moment.`,
    },
    constraints: {
      tag: "constraints",
      content: dedent`
        - Only use information present in the provided shot windows and transcript text
        - Only use provided shot-window start times as scene start candidates
        - Return structured data that matches the requested JSON schema
        - Do not add commentary or extra text outside the JSON
        - When a <language> section is provided, all scene titles MUST be written in that language`,
    },
    qualityGuidelines: {
      tag: "quality_guidelines",
      content: dedent`
        - Merge adjacent shot windows when they represent one continuous moment
        - Prefer stable scene boundaries over overly granular cuts
        - Use transcript continuity to avoid splitting one coherent idea into many scenes
        - Use visual anchor changes to detect likely scene transitions`,
    },
  },
  sectionOrder: ["role", "context", "constraints", "qualityGuidelines"],
});

const scenesPromptBuilder = createPromptBuilder<ScenesPromptSections>({
  template: {
    task: {
      tag: "task",
      content: "Group the shot windows into coherent scenes and provide a concise title for each scene.",
    },
    outputFormat: {
      tag: "output_format",
      content: dedent`
        Return valid JSON in this exact shape:
        {
          "scenes": [
            {"startTime": 0, "endTime": 18.4, "title": "Opening Introduction"},
            {"startTime": 18.4, "endTime": 47.2, "title": "Product Overview"},
            {"startTime": 47.2, "endTime": 91.0, "title": "Hands-On Demonstration"}
          ]
        }`,
    },
    sceneGuidelines: {
      tag: "scene_guidelines",
      content: "",
    },
    boundaryGuidelines: {
      tag: "boundary_guidelines",
      content: dedent`
        - Start a new scene when there is a meaningful narrative transition, not just a camera cut
        - Keep adjacent windows in the same scene when the transcript shows one continuous moment
        - Use the shot-window start times as visual anchor candidates for scene boundaries
        - Ensure the first scene starts at 0 seconds`,
    },
    titleGuidelines: {
      tag: "title_guidelines",
      content: dedent`
        - Keep titles concise and descriptive
        - Avoid filler or generic labels like "Scene 1"
        - Use the transcript's terminology when it helps identify the moment`,
    },
  },
  sectionOrder: ["task", "outputFormat", "sceneGuidelines", "boundaryGuidelines", "titleGuidelines"],
});

function buildScenesUserPrompt({
  shotWindows,
  promptOverrides,
  minScenesPerHour = DEFAULT_MIN_SCENES_PER_HOUR,
  maxScenesPerHour = DEFAULT_MAX_SCENES_PER_HOUR,
  assetDurationSeconds,
  languageName,
}: {
  shotWindows: SceneShotWindow[];
  promptOverrides?: ScenesPromptOverrides;
  minScenesPerHour?: number;
  maxScenesPerHour?: number;
  assetDurationSeconds: number;
  languageName?: string;
}): string {
  const contextSections: PromptSection[] = [
    {
      tag: "asset_context",
      content: dedent`
        Duration: ${formatSecondsForPrompt(assetDurationSeconds)}
        Shot windows provided: ${shotWindows.length}`,
    },
    {
      tag: "shot_windows",
      content: formatShotWindowsForPrompt(shotWindows),
      attributes: { format: "time-aligned transcript windows" },
    },
  ];

  if (languageName) {
    contextSections.push(createLanguageSection(languageName));
  }

  const dynamicSceneGuidelines = dedent`
    - Create at least ${minScenesPerHour} and at most ${maxScenesPerHour} scenes per hour of content
    - Use start and end times in seconds (not HH:MM:SS)
    - Scene start times should be non-decreasing
    - Scene end times should be greater than their start times
    - Do not include text before or after the JSON`;

  const mergedOverrides: ScenesPromptOverrides = {
    sceneGuidelines: dynamicSceneGuidelines,
    ...promptOverrides,
  };

  return scenesPromptBuilder.buildWithContext(mergedOverrides, contextSections);
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

async function generateScenesWithAI({
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
}): Promise<ScenesAnalysisResponse> {
  "use step";

  const model = await createLanguageModelFromConfig(provider, modelId, credentials);

  const response = await withRetry(() =>
    generateText({
      model,
      output: Output.object({ schema: scenesSchema }),
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

  return {
    scenes: response.output,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      reasoningTokens: response.usage.reasoningTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
    },
  };
}

export async function generateScenes(
  assetId: string,
  languageCode: string,
  options: ScenesOptions = {},
): Promise<ScenesResult> {
  "use workflow";
  const {
    provider = DEFAULT_PROVIDER,
    model,
    promptOverrides,
    minScenesPerHour,
    maxScenesPerHour,
    outputLanguageCode,
    pollIntervalMs,
    maxAttempts,
    createShotsIfMissing = true,
    minShotWindowDurationSeconds = DEFAULT_MIN_SHOT_WINDOW_DURATION_SECONDS,
    credentials,
  } = options;

  const modelConfig = resolveLanguageModelConfig({
    ...options,
    model,
    provider: provider as SupportedProvider,
  });

  const { asset: assetData, playbackId, policy } = await getPlaybackIdForAsset(assetId, credentials);
  const assetDurationSeconds = getAssetDurationSecondsFromAsset(assetData);
  if (assetDurationSeconds === undefined) {
    throw new Error(`Could not determine duration for asset '${assetId}'`);
  }
  if (isAudioOnlyAsset(assetData)) {
    throw new Error("Scene generation is only supported for video assets");
  }

  const signingContext = await resolveMuxSigningContext(credentials);
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. " +
      "Set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  const readyTextTracks = getReadyTextTracks(assetData);
  const transcriptResult = await fetchTranscriptForAsset(assetData, playbackId, {
    languageCode,
    cleanTranscript: false,
    shouldSign: policy === "signed",
    credentials,
    required: true,
  });

  if (!transcriptResult.track || !transcriptResult.transcriptText) {
    const availableLanguages = readyTextTracks
      .map(track => track.language_code)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `No caption track found for language '${languageCode}'. Available languages: ${availableLanguages || "none"}`,
    );
  }

  const cues = parseVTTCues(transcriptResult.transcriptText);
  if (cues.length === 0) {
    throw new Error("No usable VTT cues found in caption track");
  }

  const shotsResult = await waitForShotsForAsset(assetId, {
    pollIntervalMs,
    maxAttempts,
    createIfMissing: createShotsIfMissing,
    credentials,
  });

  const rawShotWindows = buildShotWindowsForScenes(shotsResult.shots, cues, assetDurationSeconds);
  const shotWindows = mergeSceneShotWindows(rawShotWindows, minShotWindowDurationSeconds);
  if (shotWindows.length === 0) {
    throw new Error("No shot windows available for scene generation");
  }

  const resolvedLanguageCode = outputLanguageCode && outputLanguageCode !== "auto" ?
    outputLanguageCode :
      (transcriptResult.track.language_code ?? languageCode);
  const languageName = resolvedLanguageCode ? getLanguageName(resolvedLanguageCode) : undefined;

  const userPrompt = buildScenesUserPrompt({
    shotWindows,
    promptOverrides,
    minScenesPerHour,
    maxScenesPerHour,
    assetDurationSeconds,
    languageName,
  });

  let scenesData: ScenesAnalysisResponse | null = null;

  try {
    scenesData = await generateScenesWithAI({
      provider: modelConfig.provider,
      modelId: modelConfig.modelId,
      userPrompt,
      systemPrompt: scenesSystemPromptBuilder.build(),
      credentials,
    });
  } catch (error) {
    throw new Error(
      `Failed to generate scenes with ${provider}: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  if (!scenesData?.scenes) {
    throw new Error("No scenes generated from AI response");
  }

  const normalizedScenes = normalizeScenesForAsset({
    scenes: scenesData.scenes.scenes,
    sceneStartCandidates: shotWindows.map(shotWindow => shotWindow.startTime),
    assetDurationSeconds,
  });

  const usageWithMetadata: TokenUsage = {
    ...scenesData.usage,
    metadata: {
      ...scenesData.usage?.metadata,
      assetDurationSeconds,
    },
  };

  return {
    assetId,
    languageCode,
    scenes: normalizedScenes,
    usage: usageWithMetadata,
  };
}
