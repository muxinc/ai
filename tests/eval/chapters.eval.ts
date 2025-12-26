import { openai } from "@ai-sdk/openai";
import { evalite } from "evalite";
import { answerSimilarity } from "evalite/scorers";
import { reportTrace } from "evalite/traces";

import { calculateCost, DEFAULT_LANGUAGE_MODELS } from "../../src/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "../../src/lib/providers";
import type { TokenUsage } from "../../src/types";
import { generateChapters } from "../../src/workflows";
import type { ChaptersResult } from "../../src/workflows";

import "../../src/env";

/**
 * Chapters Evaluation
 *
 * This eval measures the efficacy, efficiency, and expense of the `generateChapters`
 * workflow across multiple AI providers (OpenAI, Anthropic, Google) to ensure consistent,
 * structured, and cost-effective chapter segmentation from transcripts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EFFICACY GOALS — "Does it produce valid chapters?"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. STRUCTURE & INTEGRITY
 *    - Chapters array is present and non-empty
 *    - Each chapter has a numeric startTime and non-empty title
 *    - Asset ID and language code are preserved
 *
 * 2. CHAPTER COUNT
 *    - 3-8 chapters (per prompt guidance)
 *
 * 3. CHRONOLOGICAL ORDER
 *    - startTime values are non-negative and non-decreasing
 *    - First chapter begins at 0
 *
 * 4. TITLE QUALITY
 *    - Titles are concise and descriptive (length bounds)
 *    - Titles contain letter characters (not just numbers/symbols)
 *
 * 5. CHAPTER OUTLINE SIMILARITY (embeddings)
 *    - Compares each generated chapter title to the closest reference chapter using cosine similarity
 *    - Allows flexible phrasing and slight timing variations
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EFFICIENCY GOALS — "How fast and scalable is it?"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. LATENCY
 *    - Wall clock time from request to response
 *    - Target: <8s for good UX, <20s for acceptable UX
 *
 * 2. TOKEN EFFICIENCY
 *    - Total tokens consumed per request
 *    - Target: <4000 tokens for efficient operation
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXPENSE GOALS — "How much does it cost?"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. TOKEN CONSUMPTION
 *    - Track inputTokens, outputTokens, totalTokens per request
 *
 * 2. COST ESTIMATION
 *    - Calculate estimated USD cost per request using model pricing
 *    - Target: <$0.015 per request for acceptable operation
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TEST ASSETS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Uses the same asset as summarization evals to align evaluation baselines.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum title length to avoid single-character or empty titles. */
const TITLE_MIN_LENGTH = 3;

/** Maximum acceptable chapter title length in characters. */
const TITLE_MAX_LENGTH = 80;

/**
 * Maximum acceptable latency in milliseconds for "good" performance.
 */
const LATENCY_THRESHOLD_GOOD_MS = 8000;

/**
 * Maximum acceptable latency in milliseconds for "acceptable" performance.
 */
const LATENCY_THRESHOLD_ACCEPTABLE_MS = 20000;

/** Maximum total tokens considered efficient for this task. */
const TOKEN_THRESHOLD_EFFICIENT = 4000;

/** Maximum cost per request considered acceptable (USD). */
const COST_THRESHOLD_USD = 0.015;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Extended output including provider/model metadata and performance metrics. */
interface EvalOutput extends ChaptersResult {
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

interface TestAsset {
  assetId: string;
  languageCode: string;
  minChapters: number;
  maxChapters: number;
  referenceChapters: string[];
}

const testAssets: TestAsset[] = [
  {
    assetId: "1XIUcA9k02nqRxCLpjHGzMYNIopCdSogkYrs98CThBrc",
    languageCode: "en",
    minChapters: 3,
    maxChapters: 8,
    referenceChapters: [
      "0:00 - Intro And Talk Context",
      "0:35 - Defining Agents Vs Workflows",
      "1:26 - Accountability Agent Example",
      "2:21 - Designing The State Machine",
      "3:41 - Planning And Task Routing",
      "4:25 - LLMs, Memory And Tools",
      "5:22 - Execution Loop And Completion",
      "6:37 - Benefits, Evaluation And Wrapup",
    ],
  },
];

/** AI providers to test for cross-provider consistency. */
const providers: SupportedProvider[] = [
  "openai",
  "anthropic",
  "google",
];

const data = providers.flatMap(provider =>
  testAssets.map(asset => ({
    input: {
      assetId: asset.assetId,
      provider,
      languageCode: asset.languageCode,
    },
    expected: {
      languageCode: asset.languageCode,
      minChapters: asset.minChapters,
      maxChapters: asset.maxChapters,
      referenceChapters: asset.referenceChapters,
    },
  })),
);

function getReferenceChapterCount(assetId: string) {
  return testAssets.find(asset => asset.assetId === assetId)?.referenceChapters.length ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

evalite("Chapters", {
  data,
  task: async ({ assetId, provider, languageCode }): Promise<EvalOutput> => {
    const startTime = performance.now();
    const result = await generateChapters(assetId, languageCode, { provider });
    const latencyMs = performance.now() - startTime;

    console.warn(
      `[chapters][${provider}] ${assetId}`,
      result.chapters.map(chapter => ({
        startTime: chapter.startTime,
        title: chapter.title,
      })),
    );

    const usage = result.usage ?? {};
    const estimatedCostUsd = calculateCost(
      provider,
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      usage.cachedInputTokens ?? 0,
    );

    reportTrace({
      input: { assetId, provider, languageCode },
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

  scorers: [
    // ─────────────────────────────────────────────────────────────────────────
    // EFFICACY SCORERS
    // ─────────────────────────────────────────────────────────────────────────

    {
      name: "response-integrity",
      description: "Validates asset/language integrity and chapter shape.",
      scorer: ({
        output,
        input,
        expected,
      }: {
        output: EvalOutput;
        input: { assetId: string };
        expected: { languageCode: string };
      }) => {
        const assetIdValid = output.assetId === input.assetId;
        const languageValid = output.languageCode === expected.languageCode;
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
      name: "chapter-count",
      description: "Ensures the chapter count is within expected bounds.",
      scorer: ({
        output,
        expected,
      }: {
        output: EvalOutput;
        expected: { minChapters: number; maxChapters: number };
      }) => {
        const count = output.chapters.length;
        return count >= expected.minChapters && count <= expected.maxChapters ? 1 : 0;
      },
    },

    {
      name: "start-time-ordering",
      description: "Ensures chapters are chronological and start at 0.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const { chapters } = output;
        if (chapters.length === 0) {
          return 0;
        }

        if (chapters[0].startTime !== 0) {
          return 0;
        }

        let hasIncrease = false;
        let hasDuplicate = false;

        for (let i = 1; i < chapters.length; i += 1) {
          if (chapters[i].startTime < chapters[i - 1].startTime) {
            return 0;
          }
          if (chapters[i].startTime === chapters[i - 1].startTime) {
            hasDuplicate = true;
          }
          if (chapters[i].startTime > chapters[i - 1].startTime) {
            hasIncrease = true;
          }
        }

        if (!hasIncrease) {
          return 0;
        }

        return hasDuplicate ? 0.5 : 1;
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

    {
      name: "chapter-similarity",
      description: "Scores each generated chapter against the closest reference chapter using embeddings.",
      scorer: async ({
        output,
        expected,
      }: {
        output: EvalOutput;
        expected: { referenceChapters: string[] };
      }) => {
        const referenceTitles = expected.referenceChapters
          .map(chapter => chapter.replace(/^\s*\d{1,2}:\d{2}\s*-\s*/u, "").trim())
          .filter(Boolean);
        const generatedTitles = output.chapters
          .map(chapter => chapter.title.trim())
          .filter(Boolean);

        // We don't require the same number of chapters as the reference. Instead, each generated
        // chapter title is compared to all reference titles, and we keep the best match per title.
        if (referenceTitles.length === 0 || generatedTitles.length === 0) {
          return { score: 0 };
        }

        const embeddingModel = openai.embedding("text-embedding-3-small");
        const perChapterScores = await Promise.all(
          generatedTitles.map(async (title) => {
            const comparisons = await Promise.all(
              referenceTitles.map(reference =>
                answerSimilarity({
                  answer: title,
                  reference,
                  embeddingModel,
                }),
              ),
            );
            // Reward the closest semantic match for each generated chapter.
            return Math.max(...comparisons.map(result => result.score));
          }),
        );

        // Average similarity across generated chapters to get the final score.
        const totalScore = perChapterScores.reduce((sum, score) => sum + score, 0);

        return {
          score: totalScore / perChapterScores.length,
        };
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // EFFICIENCY SCORERS
    // ─────────────────────────────────────────────────────────────────────────

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
        return 1 - 0.5 * ((latencyMs - LATENCY_THRESHOLD_GOOD_MS) / (LATENCY_THRESHOLD_ACCEPTABLE_MS - LATENCY_THRESHOLD_GOOD_MS));
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

    // ─────────────────────────────────────────────────────────────────────────
    // EXPENSE SCORERS
    // ─────────────────────────────────────────────────────────────────────────

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

  columns: async ({ input, output }: { input: { assetId: string }; output: EvalOutput }) => {
    const firstChapter = output.chapters[0];
    const lastChapter = output.chapters[output.chapters.length - 1];

    return [
      { label: "Asset ID", value: input.assetId },
      { label: "Provider", value: output.provider },
      { label: "Model", value: output.model },
      { label: "Chapters", value: output.chapters.length },
      { label: "Reference Chapters", value: getReferenceChapterCount(input.assetId) },
      { label: "Similarity Model", value: "text-embedding-3-small" },
      { label: "First Start", value: firstChapter ? `${firstChapter.startTime}s` : "n/a" },
      { label: "Last Start", value: lastChapter ? `${lastChapter.startTime}s` : "n/a" },
      { label: "Latency", value: `${Math.round(output.latencyMs)}ms` },
      { label: "Tokens", value: output.usage?.totalTokens ?? 0 },
      { label: "Cost", value: `$${output.estimatedCostUsd.toFixed(6)}` },
    ];
  },
});
