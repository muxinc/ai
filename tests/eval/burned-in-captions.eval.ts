import { evalite } from "evalite";
import { reportTrace } from "evalite/traces";

import { calculateCost, DEFAULT_LANGUAGE_MODELS } from "../../src/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "../../src/lib/providers";
import type { TokenUsage } from "../../src/types";
import { hasBurnedInCaptions } from "../../src/workflows";
import type { BurnedInCaptionsResult } from "../../src/workflows";

import "../../src/env";

/**
 * Burned-in Captions Detection Evaluation
 *
 * This eval measures the efficacy, efficiency, and expense of the `hasBurnedInCaptions`
 * function across multiple AI providers (OpenAI, Anthropic, Google) to ensure consistent,
 * accurate, fast, and cost-effective detection of hardcoded subtitles in video content.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EFFICACY GOALS — "Does it work correctly?"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. DETECTION ACCURACY
 *    - Correctly identify videos WITH burned-in captions (true positives)
 *    - Correctly identify videos WITHOUT burned-in captions (true negatives)
 *    - Minimize false positives (marketing text, end-cards misidentified as captions)
 *    - Minimize false negatives (missing actual captions)
 *
 * 2. CONFIDENCE CALIBRATION
 *    - High confidence (>0.8) when captions are definitively present
 *    - Confidence scores should reflect the rubric:
 *      • 1.0: Definitive captions across most frames
 *      • 0.7-0.9: Strong evidence with minor ambiguity
 *      • 0.4-0.6: Moderate/uncertain evidence
 *      • 0.1-0.3: Weak evidence, likely not captions
 *      • 0.0: No captions detected
 *
 * 3. RESPONSE INTEGRITY
 *    - All required fields populated correctly
 *    - Language detection returns valid values when captions present
 *    - Storyboard URL properly generated for debugging/verification
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EFFICIENCY GOALS — "How fast and scalable is it?"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. LATENCY
 *    - Wall clock time from request to response
 *    - Target: <15s for acceptable UX, <7s for good UX
 *    - Enables comparison across providers for speed optimization
 *
 * 2. TOKEN EFFICIENCY
 *    - Total tokens consumed per analysis
 *    - Target: <4000 tokens for efficient operation
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXPENSE GOALS — "How much does it cost?"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. TOKEN CONSUMPTION
 *    - Track inputTokens, outputTokens, totalTokens per request
 *    - Compare token usage across providers
 *    - Identify opportunities for prompt optimization
 *
 * 2. COST ESTIMATION
 *    - Calculate estimated USD cost per request using THIRD_PARTY_MODEL_PRICING
 *    - Compare costs across providers for budget optimization
 *    - Target: <$0.005 per request for cost-effective operation
 *
 * Model Pricing Sources (verify periodically):
 *    - OpenAI: https://openai.com/api/pricing
 *    - Anthropic: https://www.anthropic.com/pricing
 *    - Google: https://ai.google.dev/pricing
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TEST ASSETS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Assets WITH captions: Social media style videos with visible text overlays
 * showing dialogue/narration across multiple frames.
 *
 * Assets WITHOUT captions: Videos with no text, or only incidental text
 * (logos, end-cards, scene content) that should NOT be classified as captions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimum confidence required for flagging captions, and inversely the
 * confidence we expect when declaring a clip caption-free (~80%).
 */
const CONFIDENCE_THRESHOLD = 0.8;

/** Maximum acceptable latency in milliseconds for "good" performance. */
const LATENCY_THRESHOLD_GOOD_MS = 7000;

/** Maximum acceptable latency in milliseconds for "acceptable" performance. */
const LATENCY_THRESHOLD_ACCEPTABLE_MS = 20000;

/** Maximum total tokens considered efficient for this task. */
const TOKEN_THRESHOLD_EFFICIENT = 4000;

/** Maximum cost per request considered acceptable (USD). */
const COST_THRESHOLD_USD = 0.005;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Expected outcome for a test case. */
interface Expected {
  hasBurnedInCaptions: boolean;
  minConfidence?: number;
}

/** Extended output including provider/model metadata and performance metrics. */
interface EvalOutput extends BurnedInCaptionsResult {
  provider: SupportedProvider;
  model: ModelIdByProvider[SupportedProvider];
  /** Wall clock latency in milliseconds. */
  latencyMs: number;
  /** Token usage from the AI provider. */
  usage: TokenUsage;
  /** Estimated cost in USD based on token usage and provider pricing. */
  estimatedCostUsd: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Assets
// ─────────────────────────────────────────────────────────────────────────────

/** Videos with clear burned-in captions (should detect: true, confidence: >0.8) */
const assetsWithCaptions = [
  "atuutlT45YbyucKU15u0100p45fG2CoXfJOd02VWMg4m004",
  "gEvCHSJRioaSMHtsJxT4DA02ee3xbgVL02sDGZJuqt01vs",
];

/** Videos without burned-in captions (should detect: false) */
const assetsWithoutCaptions = [
  "gIRjPqMSRcdk200kIKvsUo2K4JQr6UjNg7qKZc02egCcM",
];

/** AI providers to test for cross-provider consistency. */
const providers: SupportedProvider[] = [
  "openai",
  "anthropic",
  "google",
];

const data = [
  ...providers.flatMap(provider =>
    assetsWithCaptions.map(assetId => ({
      input: { assetId, provider, groundTruth: "Has Burned-in Captions" },
      expected: { hasBurnedInCaptions: true, minConfidence: CONFIDENCE_THRESHOLD } as Expected,
    })),
  ),
  ...providers.flatMap(provider =>
    assetsWithoutCaptions.map(assetId => ({
      input: { assetId, provider, groundTruth: "No Burned-in Captions" },
      expected: { hasBurnedInCaptions: false } as Expected,
    })),
  ),
];

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

evalite("Burned-in Captions", {
  data,
  task: async ({ assetId, provider }): Promise<EvalOutput> => {
    const startTime = performance.now();
    const result = await hasBurnedInCaptions(assetId, { provider });
    const latencyMs = performance.now() - startTime;

    const usage = result.usage ?? {};
    const estimatedCostUsd = calculateCost(
      provider,
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      usage.cachedInputTokens ?? 0,
    );

    reportTrace({
      input: { assetId, provider },
      output: result,
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        totalTokens: usage.totalTokens ?? 0,
      },
      start: startTime,
      end: startTime + latencyMs,
    });

    return {
      ...result,
      provider,
      model: DEFAULT_LANGUAGE_MODELS[provider],
      latencyMs,
      usage,
      estimatedCostUsd,
    };
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Scorers
  // ───────────────────────────────────────────────────────────────────────────
  //
  // Each scorer returns a value between 0 and 1. The eval framework aggregates
  // these scores across all test cases and providers.
  //
  // EFFICACY METRICS (binary pass/fail):
  // - Detection Accuracy: Does hasBurnedInCaptions match ground truth?
  // - Confidence Calibration: Is confidence high enough for true positives?
  // - Response Integrity: Are all fields valid and properly formatted?
  //
  // EFFICIENCY METRICS (continuous 0-1 scale):
  // - Latency: How fast is the response? (normalized against thresholds)
  // - Token Efficiency: How many tokens consumed? (normalized against threshold)
  //
  // EXPENSE METRICS (raw values for cost analysis):
  // - Token usage breakdown for cost estimation
  // ───────────────────────────────────────────────────────────────────────────

  scorers: [
    // ─────────────────────────────────────────────────────────────────────────
    // EFFICACY SCORERS
    // ─────────────────────────────────────────────────────────────────────────

    // DETECTION ACCURACY: Core efficacy metric
    // Measures: True positive rate + True negative rate
    // Failure indicates: Model misclassifying captions or non-captions
    {
      name: "matches-expected-caption-detection",
      description: "Checks that caption presence matches the expected label.",
      scorer: ({ output, expected, input }: { output: EvalOutput; expected: Expected; input: { assetId: string } }) => {
        const assetMatches = output.assetId === input.assetId;
        const detectionMatches = output.hasBurnedInCaptions === expected.hasBurnedInCaptions;
        return assetMatches && detectionMatches ? 1 : 0;
      },
    },

    // CONFIDENCE CALIBRATION: Ensures high certainty for positive detections
    // Measures: Whether confidence exceeds threshold when captions ARE present
    // Failure indicates: Model is uncertain even when captions are obvious
    {
      name: `confidence-exceeds-${CONFIDENCE_THRESHOLD}-when-positive`,
      description: `Requires confidence >${CONFIDENCE_THRESHOLD} whenever captions should be present.`,
      scorer: ({ output, expected }: { output: EvalOutput; expected: Expected }) => {
        if (!expected.hasBurnedInCaptions)
          return 1;
        return output.confidence > (expected.minConfidence ?? CONFIDENCE_THRESHOLD) ? 1 : 0;
      },
    },

    // RESPONSE INTEGRITY: Schema and shape validation
    // Measures: Whether output conforms to expected types and bounds
    // Failure indicates: Schema violation, model output error, or URL generation failure
    {
      name: "response-integrity",
      description: "Validates confidence is 0-1, detectedLanguage is null or string, and storyboardUrl is a valid HTTPS URL.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const confidenceValid = output.confidence >= 0 && output.confidence <= 1;
        const languageValid = output.detectedLanguage === null || typeof output.detectedLanguage === "string";
        const storyboardValid = typeof output.storyboardUrl === "string" && output.storyboardUrl.startsWith("https://");
        return confidenceValid && languageValid && storyboardValid ? 1 : 0;
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // EFFICIENCY SCORERS
    // ─────────────────────────────────────────────────────────────────────────

    // LATENCY: Wall clock time performance
    // Measures: Time from request initiation to response completion
    // Score: 1.0 for <7s, linear decline to 0.5 at 15s, continues declining toward 0 beyond 15s
    {
      name: "latency-performance",
      description: `Scores latency: 1.0 for <${LATENCY_THRESHOLD_GOOD_MS}ms, scaled down to 0 for >${LATENCY_THRESHOLD_ACCEPTABLE_MS}ms.`,
      scorer: ({ output }: { output: EvalOutput }) => {
        const { latencyMs } = output;
        if (latencyMs <= LATENCY_THRESHOLD_GOOD_MS)
          return 1;
        if (latencyMs >= LATENCY_THRESHOLD_ACCEPTABLE_MS)
          return Math.max(0, 1 - (latencyMs - LATENCY_THRESHOLD_ACCEPTABLE_MS) / LATENCY_THRESHOLD_ACCEPTABLE_MS);
        // Linear interpolation between good and acceptable
        return 1 - 0.5 * ((latencyMs - LATENCY_THRESHOLD_GOOD_MS) / (LATENCY_THRESHOLD_ACCEPTABLE_MS - LATENCY_THRESHOLD_GOOD_MS));
      },
    },

    // TOKEN EFFICIENCY: Total token consumption
    // Measures: Whether total tokens are within efficient range
    // Score: 1.0 for under threshold, scaled down for over
    {
      name: "token-efficiency",
      description: `Scores token usage: 1.0 for <${TOKEN_THRESHOLD_EFFICIENT} tokens, scaled down for higher usage.`,
      scorer: ({ output }: { output: EvalOutput }) => {
        const totalTokens = output.usage?.totalTokens ?? 0;
        if (totalTokens === 0)
          return 0; // No usage data is a problem
        if (totalTokens <= TOKEN_THRESHOLD_EFFICIENT)
          return 1;
        // Gradual decline for over-threshold usage
        return Math.max(0, 1 - (totalTokens - TOKEN_THRESHOLD_EFFICIENT) / TOKEN_THRESHOLD_EFFICIENT);
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // EXPENSE SCORERS
    // ─────────────────────────────────────────────────────────────────────────

    // USAGE DATA PRESENCE: Validates that usage metrics are available
    // Measures: Whether the provider returned token usage data
    // Required for cost analysis and optimization
    {
      name: "usage-data-present",
      description: "Ensures token usage data is returned for cost analysis.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const hasUsage = output.usage &&
          typeof output.usage.totalTokens === "number" &&
          output.usage.totalTokens > 0;
        return hasUsage ? 1 : 0;
      },
    },

    // COST ANALYSIS: Estimated cost per request
    // Measures: Whether estimated cost is within acceptable threshold
    // Score: 1.0 for under threshold, scaled down for over
    {
      name: "cost-within-budget",
      description: `Scores cost efficiency: 1.0 for <$${COST_THRESHOLD_USD}, scaled down for higher costs.`,
      scorer: ({ output }: { output: EvalOutput }) => {
        const { estimatedCostUsd } = output;
        if (estimatedCostUsd <= COST_THRESHOLD_USD)
          return 1;
        // Gradual decline for over-budget costs
        return Math.max(0, 1 - (estimatedCostUsd - COST_THRESHOLD_USD) / COST_THRESHOLD_USD);
      },
    },
  ],

  columns: async ({ input, output }: { input: { assetId: string; groundTruth: string }; output: EvalOutput }) => {
    return [
      { label: "Ground Truth", value: input.groundTruth },
      { label: "Asset ID", value: input.assetId },
      { label: "Provider", value: output.provider },
      { label: "Model", value: output.model },
      { label: "Detected", value: `${output.hasBurnedInCaptions} (${output.confidence})` },
      { label: "Latency", value: `${Math.round(output.latencyMs)}ms` },
      { label: "Tokens", value: output.usage?.totalTokens ?? 0 },
      { label: "Cost", value: `$${output.estimatedCostUsd.toFixed(6)}` },
    ];
  },
});
