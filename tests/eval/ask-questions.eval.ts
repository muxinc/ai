import { evalite } from "evalite";
import { reportTrace } from "evalite/traces";

import { calculateModelCost, EVAL_MODEL_CONFIGS } from "../../src/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "../../src/lib/providers";
import type { TokenUsage } from "../../src/types";
import { askQuestions } from "../../src/workflows";
import type { AskQuestionsResult, Question } from "../../src/workflows";
import { muxTestAssets } from "../helpers/mux-test-assets";

/**
 * Ask Questions Evaluation
 *
 * This eval measures the efficacy, efficiency, and expense of the `askQuestions`
 * workflow across provider/model combinations to ensure the
 * model returns consistent yes/no answers with grounded reasoning.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum acceptable latency in milliseconds for "good" performance. */
const LATENCY_THRESHOLD_GOOD_MS = 8000;

/** Maximum acceptable latency in milliseconds for "acceptable" performance. */
const LATENCY_THRESHOLD_ACCEPTABLE_MS = 12000;

/** Maximum total tokens considered efficient for this task. */
const TOKEN_THRESHOLD_EFFICIENT = 2900;

/** Maximum cost per request considered acceptable (USD). */
const COST_THRESHOLD_USD = 0.012;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Extended output including provider/model metadata and performance metrics. */
interface EvalOutput extends AskQuestionsResult {
  provider: SupportedProvider;
  model: ModelIdByProvider[SupportedProvider];
  /** Wall clock latency in milliseconds. */
  latencyMs: number;
  /** Token usage from the AI provider. */
  usage: TokenUsage;
  /** Estimated cost in USD based on token usage and model-specific pricing. */
  estimatedCostUsd: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Assets
// ─────────────────────────────────────────────────────────────────────────────

interface TestAsset {
  assetId: string;
  questions: Question[];
  expectedAnswers: string[];
}

const testAssets: TestAsset[] = [
  {
    assetId: muxTestAssets.assetId,
    questions: [
      { question: "Is this video about an API?" },
      { question: "Is this video about dogs?" },
    ],
    expectedAnswers: ["yes", "no"],
  },
];

/** Model configurations to test for cross-provider and cross-model consistency. */
const data = EVAL_MODEL_CONFIGS.flatMap(({ provider, modelId }) =>
  testAssets.map(asset => ({
    input: {
      assetId: asset.assetId,
      provider,
      model: modelId,
      questions: asset.questions,
    },
    expected: {
      expectedAnswers: asset.expectedAnswers,
      allowedAnswers: ["yes", "no"],
    },
  })),
);

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

evalite("Ask Questions", {
  data,
  task: async ({
    assetId,
    provider,
    model,
    questions,
  }: {
    assetId: string;
    provider: SupportedProvider;
    model: ModelIdByProvider[SupportedProvider];
    questions: Question[];
  }): Promise<EvalOutput> => {
    const startTime = performance.now();
    const result = await askQuestions(assetId, questions, {
      provider,
      model,
      includeTranscript: true,
    });
    const latencyMs = performance.now() - startTime;

    const usage = result.usage ?? {};
    const estimatedCostUsd = calculateModelCost(
      model,
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      usage.cachedInputTokens ?? 0,
    );

    reportTrace({
      input: { assetId, provider, model, questions },
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
      model,
      latencyMs,
      usage,
      estimatedCostUsd,
    };
  },

  scorers: [
    {
      name: "answer-accuracy",
      description: "Validates that answers match expected yes/no outputs.",
      scorer: ({
        output,
        expected,
      }: {
        output: EvalOutput;
        expected: { expectedAnswers: string[] };
      }) => {
        const expectedAnswers = expected.expectedAnswers;
        const answers = output.answers.map(answer => answer.answer);
        const correctCount = answers.reduce((count, answer, idx) =>
          count + (answer === expectedAnswers[idx] ? 1 : 0), 0);
        return correctCount / expectedAnswers.length;
      },
    },
    {
      name: "response-integrity",
      description: "Validates required fields and answer structure.",
      scorer: ({
        output,
        input,
        expected,
      }: {
        output: EvalOutput;
        input: { assetId: string; questions: Question[] };
        expected: { allowedAnswers: string[] };
      }) => {
        const assetIdValid = output.assetId === input.assetId;
        const storyboardValid = typeof output.storyboardUrl === "string" &&
          output.storyboardUrl.startsWith("https://");
        const answersValid = Array.isArray(output.answers) &&
          output.answers.length === input.questions.length;
        const answerFieldsValid = output.answers.every((answer, idx) =>
          answer.question === input.questions[idx].question &&
          expected.allowedAnswers.includes(answer.answer) &&
          typeof answer.confidence === "number" &&
          typeof answer.reasoning === "string");

        const checks = [assetIdValid, storyboardValid, answersValid, answerFieldsValid];
        return checks.filter(Boolean).length / checks.length;
      },
    },
    {
      name: "confidence-range",
      description: "Ensures confidence scores are between 0 and 1.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const answers = output.answers;
        if (answers.length === 0) {
          return 0;
        }
        const withinRangeCount = answers.filter(answer =>
          answer.confidence >= 0 && answer.confidence <= 1,
        ).length;
        return withinRangeCount / answers.length;
      },
    },
    {
      name: "reasoning-present",
      description: "Ensures reasoning strings are non-empty.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const answers = output.answers;
        if (answers.length === 0) {
          return 0;
        }
        const withReasoningCount = answers.filter(answer =>
          typeof answer.reasoning === "string" && answer.reasoning.trim().length > 0,
        ).length;
        return withReasoningCount / answers.length;
      },
    },
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
      name: "token-efficiency",
      description: `Scores token usage: 1.0 for <${TOKEN_THRESHOLD_EFFICIENT} tokens, scaled down for higher usage.`,
      scorer: ({ output }: { output: EvalOutput }) => {
        const totalTokens = output.usage?.totalTokens ?? 0;
        if (totalTokens === 0) {
          return 0;
        }
        if (totalTokens <= TOKEN_THRESHOLD_EFFICIENT) {
          return 1;
        }
        return Math.max(0, 1 - (totalTokens - TOKEN_THRESHOLD_EFFICIENT) / TOKEN_THRESHOLD_EFFICIENT);
      },
    },
    {
      name: "usage-data-present",
      description: "Ensures token usage data is returned for cost analysis.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const { usage } = output;
        if (!usage) {
          return 0;
        }
        if (typeof usage.inputTokens !== "number" || usage.inputTokens <= 0) {
          return 0;
        }
        if (typeof usage.outputTokens !== "number" || usage.outputTokens <= 0) {
          return 0;
        }
        return 1;
      },
    },
    {
      name: "cost-within-budget",
      description: `Scores cost efficiency: 1.0 for <${COST_THRESHOLD_USD}USD, scaled down for higher costs.`,
      scorer: ({ output }: { output: EvalOutput }) => {
        const { estimatedCostUsd } = output;
        if (estimatedCostUsd <= COST_THRESHOLD_USD) {
          return 1;
        }
        return Math.max(0, 1 - (estimatedCostUsd - COST_THRESHOLD_USD) / COST_THRESHOLD_USD);
      },
    },
  ],

  columns: async ({
    input,
    output,
    expected,
  }: {
    input: { assetId: string; provider: SupportedProvider; model: ModelIdByProvider[SupportedProvider]; questions: Question[] };
    output: EvalOutput;
    expected?: { expectedAnswers: string[]; allowedAnswers: string[] };
  }) => {
    const expectedAnswers = expected?.expectedAnswers ?? [];
    const answered = output.answers.map(answer => answer.answer);
    const correctCount = answered.reduce((count, answer, idx) =>
      count + (answer === expectedAnswers[idx] ? 1 : 0), 0);

    return [
      { label: "Asset ID", value: input.assetId },
      { label: "Provider", value: output.provider },
      { label: "Model", value: output.model },
      { label: "Questions", value: input.questions.length },
      { label: "Correct", value: `${correctCount}/${expectedAnswers.length}` },
      { label: "Latency", value: `${Math.round(output.latencyMs)}ms` },
      { label: "Tokens", value: output.usage?.totalTokens ?? 0 },
      { label: "Cost", value: `$${output.estimatedCostUsd.toFixed(6)}` },
    ];
  },
});
