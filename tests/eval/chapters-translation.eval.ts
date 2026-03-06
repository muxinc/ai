import { evalite } from "evalite";
import { reportTrace } from "evalite/traces";

import { calculateModelCost, EVAL_MODEL_CONFIGS } from "../../src/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "../../src/lib/providers";
import type { TokenUsage } from "../../src/types";
import { generateChapters } from "../../src/workflows";
import type { ChaptersResult } from "../../src/workflows";
import { getLatencyPerformanceDescription, scoreLatencyPerformance } from "../helpers/latency-performance";
import { muxTestAssets } from "../helpers/mux-test-assets";

/**
 * Chapters Language Cost Eval
 *
 * Measures the relative cost/performance impact of requesting chapter output
 * in a different language vs the baseline (no language specified) and vs
 * explicitly requesting the same language.
 *
 * Three variants per provider/model:
 *  - baseline:           outputLanguageCode omitted
 *  - same-language:      outputLanguageCode = "en"
 *  - different-language: outputLanguageCode = "es"
 */

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

const TITLE_MIN_LENGTH = 3;
const TITLE_MAX_LENGTH = 80;
const LATENCY_THRESHOLD_GOOD_MS = 8000;
const LATENCY_THRESHOLD_ACCEPTABLE_MS = 20000;
const TOKEN_THRESHOLD_EFFICIENT = 5000;
const COST_THRESHOLD_USD = 0.015;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type LanguageVariant = "baseline" | "same-language" | "different-language";

interface EvalOutput extends ChaptersResult {
  provider: SupportedProvider;
  model: ModelIdByProvider[SupportedProvider];
  variant: LanguageVariant;
  latencyMs: number;
  usage: TokenUsage;
  estimatedCostUsd: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test matrix
// ─────────────────────────────────────────────────────────────────────────────

const variants: { label: LanguageVariant; outputLanguageCode?: string }[] = [
  { label: "baseline" },
  { label: "same-language", outputLanguageCode: "en" },
  { label: "different-language", outputLanguageCode: "es" },
];

/** Baseline token counts keyed by "provider/model", populated during task execution. */
const baselineTokens = new Map<string, number>();

/** All results collected for the end-of-run summary. */
const allResults: { provider: string; model: string; variant: LanguageVariant; totalTokens: number; estimatedCostUsd: number }[] = [];

const data = EVAL_MODEL_CONFIGS.flatMap(({ provider, modelId }) =>
  variants.map(variant => ({
    input: {
      assetId: muxTestAssets.chaptersAssetId,
      provider,
      model: modelId,
      languageCode: "en",
      variant: variant.label,
      outputLanguageCode: variant.outputLanguageCode,
    },
    expected: {},
  })),
);

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

function printSummary() {
  const overheads: Record<LanguageVariant, number[]> = {
    "baseline": [],
    "same-language": [],
    "different-language": [],
  };

  for (const r of allResults) {
    if (r.variant === "baseline")
      continue;
    const base = baselineTokens.get(`${r.provider}/${r.model}`);
    if (base && base > 0) {
      const pct = ((r.totalTokens - base) / base) * 100;
      overheads[r.variant].push(pct);
    }
  }

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  console.warn("\n── Chapters Translation Summary ──");
  console.warn(`  Same language (en) avg token overhead: ${avg(overheads["same-language"]).toFixed(1)}%`);
  console.warn(`  Different language (es) avg token overhead: ${avg(overheads["different-language"]).toFixed(1)}%`);
  console.warn("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

evalite("Chapters Translation", {
  data,
  task: async ({ assetId, provider, model, languageCode, variant, outputLanguageCode }): Promise<EvalOutput> => {
    const startTime = performance.now();
    const result = await generateChapters(assetId, languageCode, {
      provider,
      model,
      outputLanguageCode,
    });
    const latencyMs = performance.now() - startTime;

    console.warn(
      `[chapters-language][${provider}/${model}][${variant}] ${assetId}`,
      result.chapters.map(chapter => ({
        startTime: chapter.startTime,
        title: chapter.title,
      })),
    );

    const usage = result.usage ?? {};
    const estimatedCostUsd = calculateModelCost(
      model,
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      usage.cachedInputTokens ?? 0,
    );

    reportTrace({
      input: { assetId, provider, model, languageCode, variant, outputLanguageCode },
      output: result,
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        totalTokens: usage.totalTokens ?? 0,
      },
      start: startTime,
      end: startTime + latencyMs,
    });

    const totalTokens = usage.totalTokens ?? 0;
    const key = `${provider}/${model}`;

    if (variant === "baseline") {
      baselineTokens.set(key, totalTokens);
    }

    allResults.push({ provider, model, variant, totalTokens, estimatedCostUsd });

    if (allResults.length === data.length) {
      printSummary();
    }

    return {
      ...result,
      provider,
      model,
      variant,
      latencyMs,
      usage,
      estimatedCostUsd,
    };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Scorers
  // ─────────────────────────────────────────────────────────────────────────

  scorers: [
    // EFFICACY — sanity checks

    {
      name: "response-integrity",
      description: "Validates asset/language integrity and chapter shape.",
      scorer: ({ output, input }: { output: EvalOutput; input: { assetId: string; languageCode: string } }) => {
        const assetIdValid = output.assetId === input.assetId;
        const languageValid = output.languageCode === input.languageCode;
        const chaptersValid = Array.isArray(output.chapters) && output.chapters.length > 0;
        const chapterShapeValid = output.chapters.every(chapter =>
          typeof chapter.startTime === "number" &&
          Number.isFinite(chapter.startTime) &&
          chapter.startTime >= 0 &&
          typeof chapter.title === "string" &&
          chapter.title.trim().length > 0,
        );

        return assetIdValid && languageValid && chaptersValid && chapterShapeValid ? 1 : 0;
      },
    },

    {
      name: "title-quality",
      description: "Scores chapter titles for length and descriptive content.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const { chapters } = output;
        if (chapters.length === 0) {
          return 0;
        }

        const seenTitles = new Set<string>();
        const genericTitlePattern = /^(?:chapter|segment|part)\s*\d+/i;
        let validCount = 0;

        for (const chapter of chapters) {
          const title = chapter.title.trim();
          const hasLetters = /[a-z]/i.test(title);
          const lowerTitle = title.toLowerCase();
          const isDuplicate = seenTitles.has(lowerTitle);
          const isGeneric = genericTitlePattern.test(title);

          if (
            title.length >= TITLE_MIN_LENGTH &&
            title.length <= TITLE_MAX_LENGTH &&
            hasLetters &&
            !isDuplicate &&
            !isGeneric
          ) {
            validCount += 1;
          }

          if (!isDuplicate) {
            seenTitles.add(lowerTitle);
          }
        }

        return validCount / chapters.length;
      },
    },

    // EFFICIENCY

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

    // EXPENSE

    {
      name: "usage-data-present",
      description: "Ensures token usage data is returned for cost analysis.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const { usage } = output;

        if (!usage) {
          return { score: 0, metadata: { reason: "No usage object returned" } };
        }

        const { inputTokens, outputTokens, totalTokens } = usage;

        if (typeof inputTokens !== "number" || inputTokens <= 0) {
          return { score: 0, metadata: { reason: "inputTokens missing or zero", inputTokens } };
        }

        if (typeof outputTokens !== "number" || outputTokens <= 0) {
          return { score: 0, metadata: { reason: "outputTokens missing or zero", outputTokens } };
        }

        if (typeof totalTokens === "number" && totalTokens < inputTokens + outputTokens) {
          return { score: 0.5, metadata: { reason: "totalTokens inconsistent with input + output" } };
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

  columns: async ({ input, output }: {
    input: { assetId: string; model: ModelIdByProvider[SupportedProvider] };
    output: EvalOutput;
  }) => {
    return [
      { label: "Asset ID", value: input.assetId },
      { label: "Provider", value: output.provider },
      { label: "Model", value: output.model },
      { label: "Variant", value: output.variant },
      { label: "Chapters", value: output.chapters.length },
      { label: "Latency", value: `${Math.round(output.latencyMs)}ms` },
      { label: "Tokens", value: output.usage?.totalTokens ?? 0 },
      { label: "Token Delta", value: (() => {
        if (output.variant === "baseline")
          return "N/A";
        const base = baselineTokens.get(`${output.provider}/${output.model}`);
        if (!base || base === 0)
          return "N/A";
        const pct = ((output.usage?.totalTokens ?? 0) - base) / base * 100;
        return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
      })() },
      { label: "Cost", value: `$${output.estimatedCostUsd.toFixed(6)}` },
    ];
  },
});
