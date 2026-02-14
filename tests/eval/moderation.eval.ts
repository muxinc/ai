import { evalite } from "evalite";
import { reportTrace } from "evalite/traces";

import { getModerationScores } from "../../src/workflows";
import type { ModerationProvider, ModerationResult } from "../../src/workflows/moderation";
import { getLatencyPerformanceDescription, scoreLatencyPerformance } from "../helpers/latency-performance";
import { muxTestAssets } from "../helpers/mux-test-assets";

/**
 * Moderation Evaluation
 *
 * This eval measures the efficacy, efficiency, and expense of the `getModerationScores`
 * workflow using the OpenAI moderation API to ensure consistent, accurate, and
 * cost-effective content moderation of Mux video and audio-only assets.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EFFICACY GOALS — "Does it detect content correctly?"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. DETECTION ACCURACY
 *    - Correctly flag violent content as exceeding thresholds (true positives)
 *    - Correctly pass safe content as NOT exceeding thresholds (true negatives)
 *    - `exceedsThreshold` matches ground truth expectations
 *
 * 2. SCORE CALIBRATION
 *    - Safe content: sexual and violence scores remain below conservative ceiling
 *    - Violent content: violence score exceeds a meaningful floor
 *    - Ensures model outputs are well-calibrated, not just binary correct
 *
 * 3. MODE DETECTION
 *    - Video assets use "thumbnails" mode
 *    - Audio-only assets use "transcript" mode
 *    - `isAudioOnly` flag matches the asset type
 *
 * 4. RESPONSE INTEGRITY
 *    - All required fields populated and properly typed
 *    - `assetId` matches input
 *    - `thumbnailScores` is a non-empty array
 *    - `maxScores` contains valid numeric values (0-1)
 *    - `thresholds` contains valid numeric values (0-1)
 *
 * 5. NO THUMBNAIL ERRORS
 *    - None of the individual thumbnail/transcript moderation calls should error
 *    - All `thumbnailScores[*].error` should be false
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EFFICIENCY GOALS — "How fast and scalable is it?"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. LATENCY
 *    - Wall clock time from request to response
 *    - Multiple concurrent API calls per asset (one per thumbnail/chunk)
 *    - Target: <15s for good UX, <45s for acceptable UX
 *    - Highly dependent on thumbnail count and API latency
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXPENSE GOALS — "What does it cost?"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. USAGE METADATA
 *    - Validates that workflow returns asset duration and thumbnail count metadata
 *    - OpenAI's moderation API is free for most usage, so token-based cost
 *      estimation does not apply. Instead, we track the number of API calls
 *      (proxied by thumbnail count) for capacity planning.
 *
 * 2. THUMBNAIL COUNT EFFICIENCY
 *    - When using `maxSamples`, the thumbnail count should not exceed the limit
 *    - Reasonable sampling avoids unnecessary API calls
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TEST ASSETS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * - Safe video: General purpose asset (should NOT exceed moderation thresholds)
 * - Violent video: Asset likely to score above the violence threshold
 * - Safe audio-only: Audio asset moderated via transcript (should NOT exceed)
 *
 * Provider notes:
 * - Only "openai" is tested because it's the default provider, supports both
 *   image and text moderation, and doesn't require additional API keys beyond
 *   OPENAI_API_KEY. The "hive" provider could be added when HIVE_API_KEY is
 *   available in CI, but it does not support transcript moderation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum acceptable latency in milliseconds for "good" performance.
 * Moderation involves multiple concurrent API calls (one per thumbnail/chunk),
 * so latency is higher than single-call workflows.
 */
const LATENCY_THRESHOLD_GOOD_MS = 5000;

/**
 * Maximum acceptable latency in milliseconds for "acceptable" performance.
 */
const LATENCY_THRESHOLD_ACCEPTABLE_MS = 10000;

/**
 * Ceiling for safe-content sexual scores.
 * Safe assets should remain well below this value.
 */
const SAFE_SEXUAL_SCORE_CEILING = 0.05;

/**
 * Ceiling for safe-content violence scores.
 * Safe assets should remain below this value with headroom from observed runs.
 */
const SAFE_VIOLENCE_SCORE_CEILING = 0.25;

/**
 * Floor for violence scores when the asset is known to contain violent content.
 * The violent test asset should produce a violence score meaningfully above this value.
 */
const VIOLENT_SCORE_FLOOR = 0.85;

/**
 * Maximum number of thumbnail samples to request per asset.
 * Keeps eval runs fast while still providing meaningful coverage.
 */
const MAX_SAMPLES = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Expected {
  /** Whether the asset should exceed moderation thresholds. */
  exceedsThreshold: boolean;
  /** Expected moderation mode for the asset. */
  mode: "thumbnails" | "transcript";
  /** Whether the asset is audio-only. */
  isAudioOnly: boolean;
}

/** Extended output including provider metadata and performance metrics. */
interface EvalOutput extends ModerationResult {
  provider: ModerationProvider;
  /** Wall clock latency in milliseconds. */
  latencyMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Assets
// ─────────────────────────────────────────────────────────────────────────────

interface TestCase {
  assetId: string;
  groundTruth: string;
  expected: Expected;
}

/** Video assets tested via thumbnail image moderation. */
const videoTestCases: TestCase[] = [
  {
    assetId: muxTestAssets.assetId,
    groundTruth: "Safe Video",
    expected: {
      exceedsThreshold: false,
      mode: "thumbnails",
      isAudioOnly: false,
    },
  },
  {
    assetId: muxTestAssets.violentAssetId,
    groundTruth: "Violent Video",
    expected: {
      exceedsThreshold: true,
      mode: "thumbnails",
      isAudioOnly: false,
    },
  },
];

/** Audio-only assets tested via transcript text moderation. */
const audioOnlyTestCases: TestCase[] = [
  {
    assetId: muxTestAssets.audioOnlyAssetId,
    groundTruth: "Safe Audio-Only",
    expected: {
      exceedsThreshold: false,
      mode: "transcript",
      isAudioOnly: true,
    },
  },
];

/** Moderation providers to test. */
const providers: ModerationProvider[] = ["openai"];

const data = [
  ...providers.flatMap(provider =>
    videoTestCases.map(tc => ({
      input: { assetId: tc.assetId, provider, groundTruth: tc.groundTruth },
      expected: tc.expected,
    })),
  ),
  ...providers.flatMap(provider =>
    audioOnlyTestCases.map(tc => ({
      input: { assetId: tc.assetId, provider, groundTruth: tc.groundTruth },
      expected: tc.expected,
    })),
  ),
];

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

evalite("Moderation", {
  data,
  task: async ({ assetId, provider }): Promise<EvalOutput> => {
    const startTime = performance.now();
    const result = await getModerationScores(assetId, {
      provider,
      maxSamples: MAX_SAMPLES,
    });
    const latencyMs = performance.now() - startTime;

    console.warn(
      `[moderation][${provider}] ${assetId}`,
      {
        mode: result.mode,
        isAudioOnly: result.isAudioOnly,
        exceedsThreshold: result.exceedsThreshold,
        maxScores: result.maxScores,
        thresholds: result.thresholds,
        thumbnailCount: result.thumbnailScores.length,
      },
    );

    reportTrace({
      input: { assetId, provider },
      output: result,
      start: startTime,
      end: startTime + latencyMs,
    });

    return {
      ...result,
      provider,
      latencyMs,
    };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Scorers
  // ───────────────────────────────────────────────────────────────────────────
  //
  // Each scorer returns a value between 0 and 1. The eval framework aggregates
  // these scores across all test cases and providers.
  //
  // EFFICACY METRICS:
  // - Detection Accuracy: Does exceedsThreshold match ground truth?
  // - Score Calibration (Safe): Are scores low for safe content?
  // - Score Calibration (Violent): Is violence score high for violent content?
  // - Mode Detection: Correct mode (thumbnails vs transcript)?
  // - Response Integrity: Are all fields valid and properly typed?
  // - No Thumbnail Errors: Did all moderation calls succeed?
  //
  // EFFICIENCY METRICS:
  // - Latency: How fast is the response? (normalized against thresholds)
  //
  // EXPENSE METRICS:
  // - Usage Metadata Present: Does the workflow return asset metadata?
  // - Thumbnail Count Efficiency: Is the sample count reasonable?
  // ───────────────────────────────────────────────────────────────────────────

  scorers: [
    // ─────────────────────────────────────────────────────────────────────────
    // EFFICACY SCORERS
    // ─────────────────────────────────────────────────────────────────────────

    // DETECTION ACCURACY: Core binary metric — does the flag match ground truth?
    {
      name: "detection-accuracy",
      description: "Checks that exceedsThreshold matches the expected ground truth label.",
      scorer: ({ output, expected }: { output: EvalOutput; expected: Expected }) => {
        return output.exceedsThreshold === expected.exceedsThreshold ? 1 : 0;
      },
    },

    // SCORE CALIBRATION (SAFE): For safe assets, both scores should remain low
    {
      name: "safe-content-score-calibration",
      description: `For safe content, validates sexual maxScore < ${SAFE_SEXUAL_SCORE_CEILING} and violence maxScore < ${SAFE_VIOLENCE_SCORE_CEILING}. Skips for expected-flagged content.`,
      scorer: ({ output, expected }: { output: EvalOutput; expected: Expected }) => {
        // Only applies to assets expected to be safe
        if (expected.exceedsThreshold) {
          return 1;
        }

        const sexualOk = output.maxScores.sexual < SAFE_SEXUAL_SCORE_CEILING;
        const violenceOk = output.maxScores.violence < SAFE_VIOLENCE_SCORE_CEILING;

        if (sexualOk && violenceOk) {
          return 1;
        }

        // Partial credit: one category is fine, the other is borderline
        if (sexualOk || violenceOk) {
          return 0.5;
        }

        return 0;
      },
    },

    // SCORE CALIBRATION (VIOLENT): For violent assets, violence score should be meaningfully elevated
    {
      name: "violent-content-score-calibration",
      description: `For violent content, validates that the violence maxScore exceeds ${VIOLENT_SCORE_FLOOR}. Skips for expected-safe content.`,
      scorer: ({ output, expected }: { output: EvalOutput; expected: Expected }) => {
        // Only applies to assets expected to be flagged
        if (!expected.exceedsThreshold) {
          return 1;
        }

        return output.maxScores.violence > VIOLENT_SCORE_FLOOR ? 1 : 0;
      },
    },

    // MODE DETECTION: Validates the correct moderation mode based on asset type
    {
      name: "mode-detection",
      description: "Validates the correct moderation mode (thumbnails vs transcript) and isAudioOnly flag for the asset.",
      scorer: ({ output, expected }: { output: EvalOutput; expected: Expected }) => {
        const modeMatch = output.mode === expected.mode;
        const audioOnlyMatch = output.isAudioOnly === expected.isAudioOnly;
        return modeMatch && audioOnlyMatch ? 1 : 0;
      },
    },

    // RESPONSE INTEGRITY: Schema and shape validation
    {
      name: "response-integrity",
      description: "Validates all required fields are present, properly typed, and within valid ranges.",
      scorer: ({ output, input }: { output: EvalOutput; input: { assetId: string } }) => {
        const checks = [
          // assetId matches input
          output.assetId === input.assetId,
          // mode is valid
          output.mode === "thumbnails" || output.mode === "transcript",
          // isAudioOnly is boolean
          typeof output.isAudioOnly === "boolean",
          // thumbnailScores is a non-empty array
          Array.isArray(output.thumbnailScores) && output.thumbnailScores.length > 0,
          // maxScores contains valid numbers in 0-1 range
          typeof output.maxScores.sexual === "number" &&
          output.maxScores.sexual >= 0 &&
          output.maxScores.sexual <= 1,
          typeof output.maxScores.violence === "number" &&
          output.maxScores.violence >= 0 &&
          output.maxScores.violence <= 1,
          // exceedsThreshold is boolean
          typeof output.exceedsThreshold === "boolean",
          // thresholds contain valid numbers in 0-1 range
          typeof output.thresholds.sexual === "number" &&
          output.thresholds.sexual >= 0 &&
          output.thresholds.sexual <= 1,
          typeof output.thresholds.violence === "number" &&
          output.thresholds.violence >= 0 &&
          output.thresholds.violence <= 1,
        ];

        const passed = checks.filter(Boolean).length;
        return passed / checks.length;
      },
    },

    // NO THUMBNAIL ERRORS: All individual moderation calls should succeed
    {
      name: "no-thumbnail-errors",
      description: "Validates that none of the individual thumbnail/transcript moderation results have errors.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const { thumbnailScores } = output;
        if (!Array.isArray(thumbnailScores) || thumbnailScores.length === 0) {
          return 0;
        }

        const errorCount = thumbnailScores.filter(s => s.error).length;
        if (errorCount === 0) {
          return 1;
        }

        // Partial credit: most succeeded
        return Math.max(0, 1 - errorCount / thumbnailScores.length);
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // EFFICIENCY SCORERS
    // ─────────────────────────────────────────────────────────────────────────

    // LATENCY: Wall clock time performance
    {
      name: "latency-performance",
      description: getLatencyPerformanceDescription(LATENCY_THRESHOLD_GOOD_MS, LATENCY_THRESHOLD_ACCEPTABLE_MS),
      scorer: ({ output }: { output: EvalOutput }) => {
        return scoreLatencyPerformance(
          output.latencyMs,
          LATENCY_THRESHOLD_GOOD_MS,
          LATENCY_THRESHOLD_ACCEPTABLE_MS,
        );
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // EXPENSE SCORERS
    // ─────────────────────────────────────────────────────────────────────────

    // USAGE METADATA: Validates that workflow returns useful metadata for capacity planning
    // Note: OpenAI's moderation API is free for most usage, so traditional
    // token-based cost estimation does not apply. Instead we validate that the
    // workflow returns operational metadata (asset duration, thumbnail count)
    // needed for capacity planning and monitoring.
    {
      name: "usage-metadata-present",
      description: "Ensures workflow returns usage metadata with asset duration for operational tracking.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const { usage } = output;

        if (!usage) {
          return { score: 0, metadata: { reason: "No usage object returned" } };
        }

        if (!usage.metadata) {
          return { score: 0, metadata: { reason: "No metadata in usage object" } };
        }

        const hasDuration =
          typeof usage.metadata.assetDurationSeconds === "number" &&
          usage.metadata.assetDurationSeconds > 0;

        if (!hasDuration) {
          return { score: 0, metadata: { reason: "assetDurationSeconds missing or zero" } };
        }

        // For thumbnail mode, also check thumbnailCount
        if (output.mode === "thumbnails") {
          const hasThumbnailCount =
            typeof usage.metadata.thumbnailCount === "number" &&
            usage.metadata.thumbnailCount > 0;

          if (!hasThumbnailCount) {
            return { score: 0.5, metadata: { reason: "thumbnailCount missing for thumbnail mode" } };
          }
        }

        return 1;
      },
    },

    // THUMBNAIL COUNT EFFICIENCY: Sample count should not exceed maxSamples
    {
      name: "thumbnail-count-efficiency",
      description: `For thumbnail mode, validates that the sample count does not exceed the configured maxSamples (${MAX_SAMPLES}).`,
      scorer: ({ output }: { output: EvalOutput }) => {
        // For transcript mode, this scorer is not applicable
        if (output.mode === "transcript") {
          return 1;
        }

        const count = output.thumbnailScores.length;
        if (count <= MAX_SAMPLES) {
          return 1;
        }

        // Penalize proportionally for exceeding the limit
        return Math.max(0, 1 - (count - MAX_SAMPLES) / MAX_SAMPLES);
      },
    },
  ],

  columns: async ({ input, output }: { input: { assetId: string; groundTruth: string }; output: EvalOutput }) => {
    return [
      { label: "Ground Truth", value: input.groundTruth },
      { label: "Asset ID", value: input.assetId },
      { label: "Provider", value: output.provider },
      { label: "Mode", value: output.mode },
      { label: "Exceeds Threshold", value: String(output.exceedsThreshold) },
      { label: "Max Sexual", value: output.maxScores.sexual.toFixed(4) },
      { label: "Max Violence", value: output.maxScores.violence.toFixed(4) },
      { label: "Samples", value: output.thumbnailScores.length },
      { label: "Latency", value: `${Math.round(output.latencyMs)}ms` },
      { label: "Duration", value: output.usage?.metadata?.assetDurationSeconds ? `${output.usage.metadata.assetDurationSeconds}s` : "n/a" },
    ];
  },
});
