import { evalite } from "evalite";
import { reportTrace } from "evalite/traces";

import { getModerationScores } from "../../src/workflows";
import type { ModerationProvider, ModerationResult } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

/**
 * Moderation Evaluation
 *
 * This eval measures efficacy, efficiency, and expense-oriented signals for
 * `getModerationScores` across supported moderation providers.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

/** Classification threshold used to score violent vs. non-violent expectations. */
const VIOLENCE_CLASSIFICATION_THRESHOLD = 0.5;

/** Maximum acceptable latency in milliseconds for "good" performance. */
const LATENCY_THRESHOLD_GOOD_MS = 6000;

/** Maximum acceptable latency in milliseconds for "acceptable" performance. */
const LATENCY_THRESHOLD_ACCEPTABLE_MS = 18000;

/** Request-count threshold considered efficient for unbounded transcript chunking. */
const REQUEST_COUNT_EFFICIENT = 6;

/** Hard budget for moderation request count used as an expense proxy. */
const REQUEST_COUNT_BUDGET = 12;

const OPENAI_MODERATION_MODEL = "omni-moderation-latest";

type ViolenceExpectation = "high" | "low";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface EvalInput {
  assetId: string;
  provider: ModerationProvider;
  scenario: string;
  maxSamples?: number;
}

interface EvalExpected {
  mode: ModerationResult["mode"];
  isAudioOnly: boolean;
  expectedViolence: ViolenceExpectation;
  expectedSexualMax: number;
  maxSampleCap?: number;
}

interface EvalOutput extends ModerationResult {
  provider: ModerationProvider;
  model: string;
  /** Wall clock latency in milliseconds. */
  latencyMs: number;
  /** Number of moderation requests performed (thumbnail count or transcript chunks). */
  requestCount: number;
}

interface TestAsset {
  scenario: string;
  assetId: string;
  providers: ModerationProvider[];
  mode: ModerationResult["mode"];
  isAudioOnly: boolean;
  expectedViolence: ViolenceExpectation;
  expectedSexualMax: number;
  maxSamples?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Assets
// ─────────────────────────────────────────────────────────────────────────────

const testAssets: TestAsset[] = [
  {
    scenario: "safe-video",
    assetId: muxTestAssets.assetId,
    providers: ["openai", "hive"],
    mode: "thumbnails",
    isAudioOnly: false,
    expectedViolence: "low",
    expectedSexualMax: 0.5,
    maxSamples: 5,
  },
  {
    scenario: "violent-video",
    assetId: muxTestAssets.violentAssetId,
    providers: ["openai", "hive"],
    mode: "thumbnails",
    isAudioOnly: false,
    expectedViolence: "high",
    expectedSexualMax: 0.5,
    maxSamples: 5,
  },
  {
    scenario: "safe-audio-transcript",
    assetId: muxTestAssets.audioOnlyAssetId,
    providers: ["openai"],
    mode: "transcript",
    isAudioOnly: true,
    expectedViolence: "low",
    expectedSexualMax: 0.5,
  },
  {
    scenario: "violent-audio-transcript",
    assetId: muxTestAssets.violentAudioOnlyAssetId,
    providers: ["openai"],
    mode: "transcript",
    isAudioOnly: true,
    expectedViolence: "high",
    expectedSexualMax: 0.5,
  },
];

const PROVIDER_MODEL_LABEL: Record<ModerationProvider, string> = {
  openai: OPENAI_MODERATION_MODEL,
  hive: "hive-sync-v2",
};

const data = testAssets.flatMap(asset =>
  asset.providers.map(provider => ({
    input: {
      assetId: asset.assetId,
      provider,
      scenario: asset.scenario,
      ...(typeof asset.maxSamples === "number" ? { maxSamples: asset.maxSamples } : {}),
    } satisfies EvalInput,
    expected: {
      mode: asset.mode,
      isAudioOnly: asset.isAudioOnly,
      expectedViolence: asset.expectedViolence,
      expectedSexualMax: asset.expectedSexualMax,
      maxSampleCap: asset.maxSamples,
    } satisfies EvalExpected,
  })),
);

function scoreHigherIsBetter(actual: number, threshold: number): number {
  if (actual >= threshold) {
    return 1;
  }
  return Math.max(0, actual / threshold);
}

function scoreLowerIsBetter(actual: number, threshold: number): number {
  if (actual <= threshold) {
    return 1;
  }
  return Math.max(0, 1 - (actual - threshold) / Math.max(0.0001, 1 - threshold));
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

evalite("Moderation", {
  data,
  task: async ({ assetId, provider, maxSamples, scenario }: EvalInput): Promise<EvalOutput> => {
    const startTime = performance.now();
    const result = await getModerationScores(assetId, {
      provider,
      ...(provider === "openai" ? { model: OPENAI_MODERATION_MODEL } : {}),
      ...(typeof maxSamples === "number" ? { maxSamples } : {}),
    });
    const latencyMs = performance.now() - startTime;

    const usage = result.usage ?? {};
    const requestCount = result.thumbnailScores.length;

    reportTrace({
      input: { assetId, provider, maxSamples, scenario },
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
      model: PROVIDER_MODEL_LABEL[provider],
      latencyMs,
      requestCount,
    };
  },

  scorers: [
    // EFFICACY SCORERS
    {
      name: "violence-detection-calibration",
      description: "Scores whether violence maxima align with expected safe/violent behavior.",
      scorer: ({ output, expected }: { output: EvalOutput; expected: EvalExpected }) => {
        const actual = output.maxScores.violence;
        if (expected.expectedViolence === "high") {
          return scoreHigherIsBetter(actual, VIOLENCE_CLASSIFICATION_THRESHOLD);
        }
        return scoreLowerIsBetter(actual, VIOLENCE_CLASSIFICATION_THRESHOLD);
      },
    },
    {
      name: "sexual-score-bound",
      description: "Penalizes outputs whose sexual score exceeds the expected upper bound.",
      scorer: ({ output, expected }: { output: EvalOutput; expected: EvalExpected }) =>
        scoreLowerIsBetter(output.maxScores.sexual, expected.expectedSexualMax),
    },
    {
      name: "response-integrity",
      description: "Validates mode-specific shape, score ranges, and threshold consistency.",
      scorer: ({
        output,
        input,
        expected,
      }: {
        output: EvalOutput;
        input: EvalInput;
        expected: EvalExpected;
      }) => {
        const checks: boolean[] = [];
        const scores = output.thumbnailScores;

        checks.push(output.assetId === input.assetId);
        checks.push(output.mode === expected.mode);
        checks.push(output.isAudioOnly === expected.isAudioOnly);
        checks.push(Array.isArray(scores) && scores.length > 0);
        checks.push(scores.every(score => !score.error));
        checks.push(scores.every(score =>
          score.sexual >= 0 &&
          score.sexual <= 1 &&
          score.violence >= 0 &&
          score.violence <= 1
        ));
        checks.push(output.maxScores.sexual >= 0 && output.maxScores.sexual <= 1);
        checks.push(output.maxScores.violence >= 0 && output.maxScores.violence <= 1);
        checks.push(output.thresholds.sexual >= 0 && output.thresholds.sexual <= 1);
        checks.push(output.thresholds.violence >= 0 && output.thresholds.violence <= 1);

        const urlsMatchMode = output.mode === "transcript" ?
            scores.every(score => score.url.startsWith("transcript:")) :
            scores.every(score => score.url.startsWith("http"));
        checks.push(urlsMatchMode);

        const expectedExceedsThreshold = output.maxScores.sexual > output.thresholds.sexual ||
          output.maxScores.violence > output.thresholds.violence;
        checks.push(output.exceedsThreshold === expectedExceedsThreshold);

        return checks.filter(Boolean).length / checks.length;
      },
    },

    // EFFICIENCY SCORERS
    {
      name: "latency-performance",
      description: `Scores latency: 1.0 for <${LATENCY_THRESHOLD_GOOD_MS}ms, scaled down to 0 for >${LATENCY_THRESHOLD_ACCEPTABLE_MS}ms.`,
      scorer: ({ output }: { output: EvalOutput }) => {
        const { latencyMs } = output;
        if (latencyMs <= LATENCY_THRESHOLD_GOOD_MS) {
          return 1;
        }
        if (latencyMs >= LATENCY_THRESHOLD_ACCEPTABLE_MS) {
          return Math.max(0, 1 - (latencyMs - LATENCY_THRESHOLD_ACCEPTABLE_MS) / LATENCY_THRESHOLD_ACCEPTABLE_MS);
        }
        return 1 - 0.5 * ((latencyMs - LATENCY_THRESHOLD_GOOD_MS) /
          (LATENCY_THRESHOLD_ACCEPTABLE_MS - LATENCY_THRESHOLD_GOOD_MS));
      },
    },
    {
      name: "request-count-efficiency",
      description: "Scores moderation request volume against expected sample caps and chunk budgets.",
      scorer: ({ output, expected }: { output: EvalOutput; expected: EvalExpected }) => {
        const requestCount = output.requestCount;
        if (requestCount <= 0) {
          return 0;
        }

        if (typeof expected.maxSampleCap === "number") {
          if (requestCount <= expected.maxSampleCap) {
            return 1;
          }
          return Math.max(0, 1 - (requestCount - expected.maxSampleCap) / expected.maxSampleCap);
        }

        if (requestCount <= REQUEST_COUNT_EFFICIENT) {
          return 1;
        }
        return Math.max(0, 1 - (requestCount - REQUEST_COUNT_EFFICIENT) / REQUEST_COUNT_EFFICIENT);
      },
    },

    // EXPENSE SCORERS
    {
      name: "usage-metadata-present",
      description: "Ensures workflow metadata is returned for duration and sampling-based expense analysis.",
      scorer: ({ output, expected }: { output: EvalOutput; expected: EvalExpected }) => {
        const checks: boolean[] = [];
        const metadata = output.usage?.metadata;

        checks.push(
          typeof metadata?.assetDurationSeconds === "number" &&
          metadata.assetDurationSeconds > 0,
        );

        if (expected.mode === "thumbnails") {
          checks.push(
            typeof metadata?.thumbnailCount === "number" &&
            metadata.thumbnailCount > 0,
          );
          checks.push(metadata?.thumbnailCount === output.thumbnailScores.length);
        } else {
          checks.push(metadata?.thumbnailCount == null);
        }

        return checks.filter(Boolean).length / checks.length;
      },
    },
    {
      name: "request-count-within-budget",
      description: `Scores moderation request count against a hard budget of ${REQUEST_COUNT_BUDGET} calls.`,
      scorer: ({ output }: { output: EvalOutput }) => {
        const requestCount = output.requestCount;
        if (requestCount <= 0) {
          return 0;
        }
        if (requestCount <= REQUEST_COUNT_BUDGET) {
          return 1;
        }
        return Math.max(0, 1 - (requestCount - REQUEST_COUNT_BUDGET) / REQUEST_COUNT_BUDGET);
      },
    },
  ],

  columns: async ({
    input,
    output,
    expected,
  }: {
    input: EvalInput;
    output: EvalOutput;
    expected?: EvalExpected;
  }) => {
    const mode = expected?.mode ?? output.mode;
    const assetDuration = output.usage?.metadata?.assetDurationSeconds;

    return [
      { label: "Scenario", value: input.scenario },
      { label: "Asset ID", value: input.assetId },
      { label: "Provider", value: output.provider },
      { label: "Model", value: output.model },
      { label: "Mode", value: mode },
      { label: "Requests", value: output.requestCount },
      { label: "Max Violence", value: output.maxScores.violence.toFixed(3) },
      { label: "Max Sexual", value: output.maxScores.sexual.toFixed(3) },
      { label: "Exceeds Threshold", value: output.exceedsThreshold ? "yes" : "no" },
      { label: "Duration (s)", value: assetDuration ? assetDuration.toFixed(2) : "n/a" },
      { label: "Latency", value: `${Math.round(output.latencyMs)}ms` },
    ];
  },
});
