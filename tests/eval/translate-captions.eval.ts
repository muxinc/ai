import { openai } from "@ai-sdk/openai";
import { evalite } from "evalite";
import { faithfulness } from "evalite/scorers";
import { reportTrace } from "evalite/traces";

import { isValidISO639_1, isValidISO639_3, toISO639_1, toISO639_3 } from "../../src/lib/language-codes";
import { calculateCost, DEFAULT_LANGUAGE_MODELS } from "../../src/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "../../src/lib/providers";
import type { TokenUsage } from "../../src/types";
import { translateCaptions } from "../../src/workflows";
import type { TranslationResult } from "../../src/workflows";

import "../../src/env";

/**
 * Caption Translation Evaluation
 *
 * This eval measures the efficacy, efficiency, and expense of the `translateCaptions`
 * function across multiple AI providers (OpenAI, Anthropic, Google) to ensure consistent,
 * high-quality, fast, and cost-effective VTT subtitle translation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EFFICACY GOALS — "Does it produce quality output?"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. VTT FORMAT PRESERVATION
 *    - Output must start with "WEBVTT"
 *    - Timestamps must be preserved in correct format (HH:MM:SS.mmm --> HH:MM:SS.mmm)
 *    - Cue structure must be maintained
 *
 * 2. TRANSLATION COMPLETENESS
 *    - All cues from original VTT must be present in translation
 *    - No missing or dropped content
 *
 * 3. TRANSLATION FAITHFULNESS
 *    - Translated text should faithfully represent the original content
 *    - No hallucinations or invented content
 *    - Semantic meaning must be preserved across languages
 *
 * 4. RESPONSE INTEGRITY
 *    - All required fields populated correctly
 *    - Language codes match request (ISO 639-1 and ISO 639-3)
 *    - Asset ID preserved
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EFFICIENCY GOALS — "How fast and scalable is it?"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. LATENCY
 *    - Wall clock time from request to response
 *    - Target: <8s for good UX, <15s for acceptable UX
 *    - Benchmark: OpenAI ~5-6s, Google ~5-7s, Anthropic ~8-10s
 *
 * 2. TOKEN EFFICIENCY
 *    - Total tokens consumed per translation
 *    - Target: <2500 tokens for efficient operation
 *    - Benchmark: OpenAI ~850-900, Anthropic ~1600, Google ~1700-2100
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXPENSE GOALS — "How much does it cost?"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. TOKEN CONSUMPTION
 *    - Track inputTokens, outputTokens, totalTokens per request
 *    - Compare token usage across providers
 *
 * 2. COST ESTIMATION
 *    - Calculate estimated USD cost per request
 *    - Target: <$0.012 per request for cost-effective operation
 *    - Benchmark: Google ~$0.002, OpenAI ~$0.005, Anthropic ~$0.011
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
 * Assets with existing English captions translated to Spanish, French, and Japanese.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum acceptable latency in milliseconds for "good" performance.
 * Benchmark: OpenAI ~5-6s, Google ~5-7s, Anthropic ~8-10s
 */
const LATENCY_THRESHOLD_GOOD_MS = 8000;

/**
 * Maximum acceptable latency in milliseconds for "acceptable" performance.
 * All providers consistently under 10s for short VTT files.
 */
const LATENCY_THRESHOLD_ACCEPTABLE_MS = 15000;

/**
 * Maximum total tokens considered efficient for this task.
 * Benchmark: OpenAI ~850-900, Anthropic ~1600, Google ~1700-2100
 */
const TOKEN_THRESHOLD_EFFICIENT = 2500;

/**
 * Maximum cost per request considered acceptable (USD).
 * Benchmark: Google ~$0.002, OpenAI ~$0.005, Anthropic ~$0.011
 */
const COST_THRESHOLD_USD = 0.012;

// ─────────────────────────────────────────────────────────────────────────────
// Source Transcript
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Original English transcript for the test asset.
 * Used as ground truth for faithfulness evaluation.
 */
const ORIGINAL_TRANSCRIPT = `Ouch! Dang thumbs. You know, there is an easier way to get thumbnails. Quickly grab a still from anywhere in your video with the Mux API. All it takes is some query params. Thumbnail. What about GIFs? What? Not you, Jeff. GIFs. I thought it was GIFs. GIFs, GIFS, it's all the same to Mux with a simple get request. Because video is fun with Mux.`;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Extended output including provider/model metadata and performance metrics. */
interface EvalOutput extends TranslationResult {
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

/**
 * Video assets for translation testing.
 */
interface TestAsset {
  assetId: string;
  /** ISO 639-1 (2-letter) source language code */
  sourceLanguage: string;
  /** ISO 639-1 (2-letter) target language code */
  targetLanguage: string;
  /** Expected ISO 639-3 (3-letter) source language code */
  expectedSourceISO639_3: string;
  /** Expected ISO 639-3 (3-letter) target language code */
  expectedTargetISO639_3: string;
  /** Human-readable target language name for display */
  targetLanguageName: string;
}

const testAssets: TestAsset[] = [
  // Spanish translation
  {
    assetId: "88Lb01qNUqFJrOFMITk00Ck201F00Qmcbpc5qgopNV4fCOk",
    sourceLanguage: "en",
    targetLanguage: "es",
    expectedSourceISO639_3: "eng",
    expectedTargetISO639_3: "spa",
    targetLanguageName: "Spanish",
  },
  // French translation
  {
    assetId: "88Lb01qNUqFJrOFMITk00Ck201F00Qmcbpc5qgopNV4fCOk",
    sourceLanguage: "en",
    targetLanguage: "fr",
    expectedSourceISO639_3: "eng",
    expectedTargetISO639_3: "fra",
    targetLanguageName: "French",
  },
  // Japanese translation
  {
    assetId: "88Lb01qNUqFJrOFMITk00Ck201F00Qmcbpc5qgopNV4fCOk",
    sourceLanguage: "en",
    targetLanguage: "ja",
    expectedSourceISO639_3: "eng",
    expectedTargetISO639_3: "jpn",
    targetLanguageName: "Japanese",
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
      sourceLanguage: asset.sourceLanguage,
      targetLanguage: asset.targetLanguage,
      targetLanguageName: asset.targetLanguageName,
    },
    expected: {
      sourceLanguage: asset.sourceLanguage,
      targetLanguage: asset.targetLanguage,
      expectedSourceISO639_3: asset.expectedSourceISO639_3,
      expectedTargetISO639_3: asset.expectedTargetISO639_3,
    },
  })),
);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Regex to match VTT timestamp lines (e.g., "00:00:00.000 --> 00:00:05.000") */
const VTT_TIMESTAMP_REGEX = /\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}/g;

/**
 * Count the number of cues in a VTT file by counting timestamp lines.
 */
function countVttCues(vttContent: string): number {
  const matches = vttContent.match(VTT_TIMESTAMP_REGEX);
  return matches?.length ?? 0;
}

/**
 * Extract text content from VTT (excluding headers, timestamps, and cue identifiers).
 */
function extractVttTextContent(vttContent: string): string {
  const lines = vttContent.split("\n");
  const textLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip WEBVTT header, empty lines, timestamps, and numeric cue identifiers
    if (
      trimmed === "" ||
      trimmed.startsWith("WEBVTT") ||
      trimmed.startsWith("NOTE") ||
      VTT_TIMESTAMP_REGEX.test(trimmed) ||
      /^\d+$/.test(trimmed)
    ) {
      continue;
    }
    textLines.push(trimmed);
  }

  return textLines.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

evalite("Caption Translation", {
  data,
  task: async ({ assetId, provider, sourceLanguage, targetLanguage }): Promise<EvalOutput> => {
    const startTime = performance.now();
    const result = await translateCaptions(assetId, sourceLanguage, targetLanguage, {
      provider,
      uploadToMux: false, // Don't upload during evals
    });
    const latencyMs = performance.now() - startTime;

    const usage = result.usage ?? {};
    const estimatedCostUsd = calculateCost(
      provider,
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      usage.cachedInputTokens ?? 0,
    );

    reportTrace({
      input: { assetId, provider, sourceLanguage, targetLanguage },
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
  // EFFICACY METRICS (translation quality):
  // - VTT Format: Is the output valid VTT format?
  // - Timestamp Preservation: Are timestamps correctly preserved?
  // - Cue Count Consistency: Does translation have same number of cues?
  // - Translation Faithfulness: Is the translation faithful to the original?
  // - Response Integrity: Are all fields valid and properly formatted?
  //
  // EFFICIENCY METRICS (continuous 0-1 scale):
  // - Latency: How fast is the response? (normalized against thresholds)
  // - Token Efficiency: How many tokens consumed? (normalized against threshold)
  //
  // EXPENSE METRICS:
  // - Token usage presence for cost analysis
  // - Cost within budget
  // ───────────────────────────────────────────────────────────────────────────

  scorers: [
    // ─────────────────────────────────────────────────────────────────────────
    // EFFICACY SCORERS
    // ─────────────────────────────────────────────────────────────────────────

    // VTT FORMAT: Output must be valid VTT format
    {
      name: "vtt-format",
      description: "Validates that the translated output starts with WEBVTT and contains valid VTT structure.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const { translatedVtt } = output;

        if (!translatedVtt || translatedVtt.trim().length === 0) {
          return 0;
        }

        // Must start with WEBVTT
        if (!translatedVtt.trim().startsWith("WEBVTT")) {
          return 0;
        }

        // Must contain at least one timestamp line
        if (!VTT_TIMESTAMP_REGEX.test(translatedVtt)) {
          return 0.5;
        }

        return 1;
      },
    },

    // TIMESTAMP PRESERVATION: Timestamps must be correctly formatted
    {
      name: "timestamp-preservation",
      description: "Validates that timestamps are preserved in the correct VTT format.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const { originalVtt, translatedVtt } = output;

        const originalTimestamps = originalVtt.match(VTT_TIMESTAMP_REGEX) ?? [];
        const translatedTimestamps = translatedVtt.match(VTT_TIMESTAMP_REGEX) ?? [];

        if (originalTimestamps.length === 0) {
          return 0; // No timestamps to compare
        }

        // Check if all original timestamps are present in translation
        const originalSet = new Set(originalTimestamps);
        const translatedSet = new Set(translatedTimestamps);

        let matchCount = 0;
        for (const ts of originalSet) {
          if (translatedSet.has(ts)) {
            matchCount++;
          }
        }

        return matchCount / originalSet.size;
      },
    },

    // CUE COUNT CONSISTENCY: Translation should have same number of cues
    {
      name: "cue-count-consistency",
      description: "Validates that the translated VTT has the same number of cues as the original.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const { originalVtt, translatedVtt } = output;

        const originalCues = countVttCues(originalVtt);
        const translatedCues = countVttCues(translatedVtt);

        if (originalCues === 0) {
          return 0;
        }

        if (translatedCues === originalCues) {
          return 1;
        }

        // Partial credit for close match
        const ratio = Math.min(translatedCues, originalCues) / Math.max(translatedCues, originalCues);
        return ratio;
      },
    },

    // TRANSLATION FAITHFULNESS: Verify translation is faithful to original content
    {
      name: "translation-faithfulness",
      description: "Evaluates whether the translation faithfully represents the original content without hallucinations.",
      scorer: async ({
        output,
        input,
      }: {
        output: EvalOutput;
        input: { targetLanguage: string; targetLanguageName: string };
      }) => {
        const translatedText = extractVttTextContent(output.translatedVtt);

        // Use faithfulness scorer to check if translation is grounded in the original
        const result = await faithfulness({
          question: `Translate the following English transcript to ${input.targetLanguageName}: "${ORIGINAL_TRANSCRIPT}"`,
          answer: translatedText,
          groundTruth: [ORIGINAL_TRANSCRIPT],
          model: openai("gpt-5.1"),
        });

        return {
          score: result.score,
          metadata: result.metadata,
        };
      },
    },

    // RESPONSE INTEGRITY: Schema and shape validation
    {
      name: "response-integrity",
      description: "Validates all required fields are present and properly typed.",
      scorer: ({
        output,
        input,
        expected,
      }: {
        output: EvalOutput;
        input: { assetId: string };
        expected: { sourceLanguage: string; targetLanguage: string };
      }) => {
        const assetIdValid = output.assetId === input.assetId;
        const sourceValid = output.sourceLanguageCode === expected.sourceLanguage;
        const targetValid = output.targetLanguageCode === expected.targetLanguage;
        const originalVttValid = typeof output.originalVtt === "string" && output.originalVtt.length > 0;
        const translatedVttValid = typeof output.translatedVtt === "string" && output.translatedVtt.length > 0;

        const validFields = [assetIdValid, sourceValid, targetValid, originalVttValid, translatedVttValid];
        const validCount = validFields.filter(Boolean).length;

        return validCount / validFields.length;
      },
    },

    // TRANSLATION IS DIFFERENT: Ensure translation is actually different from original
    {
      name: "translation-is-different",
      description: "Validates that the translated content is different from the original.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const { originalVtt, translatedVtt } = output;

        // Exact match means no translation happened
        if (originalVtt === translatedVtt) {
          return 0;
        }

        // Extract text content and compare
        const originalText = extractVttTextContent(originalVtt).toLowerCase();
        const translatedText = extractVttTextContent(translatedVtt).toLowerCase();

        // If text content is identical, translation likely failed
        if (originalText === translatedText) {
          return 0;
        }

        return 1;
      },
    },

    // LANGUAGE CODE FORMAT: Validate ISO 639-1 and ISO 639-3 codes are correct
    {
      name: "language-code-format",
      description: "Validates that both ISO 639-1 (2-letter) and ISO 639-3 (3-letter) codes are returned correctly.",
      scorer: ({
        output,
        expected,
      }: {
        output: EvalOutput;
        expected: {
          sourceLanguage: string;
          targetLanguage: string;
          expectedSourceISO639_3: string;
          expectedTargetISO639_3: string;
        };
      }) => {
        const checks: { name: string; passed: boolean }[] = [];

        // Check sourceLanguage structure exists
        const hasSourceLanguage = output.sourceLanguage &&
          typeof output.sourceLanguage.iso639_1 === "string" &&
          typeof output.sourceLanguage.iso639_3 === "string";
        checks.push({ name: "sourceLanguage structure", passed: hasSourceLanguage });

        // Check targetLanguage structure exists
        const hasTargetLanguage = output.targetLanguage &&
          typeof output.targetLanguage.iso639_1 === "string" &&
          typeof output.targetLanguage.iso639_3 === "string";
        checks.push({ name: "targetLanguage structure", passed: hasTargetLanguage });

        if (hasSourceLanguage) {
          // Validate source ISO 639-1 format (2 letters)
          const sourceISO639_1Valid = output.sourceLanguage.iso639_1.length === 2 &&
            output.sourceLanguage.iso639_1 === expected.sourceLanguage;
          checks.push({ name: "source ISO 639-1", passed: sourceISO639_1Valid });

          // Validate source ISO 639-3 format (3 letters)
          const sourceISO639_3Valid = output.sourceLanguage.iso639_3.length === 3 &&
            output.sourceLanguage.iso639_3 === expected.expectedSourceISO639_3;
          checks.push({ name: "source ISO 639-3", passed: sourceISO639_3Valid });

          // Validate source codes are consistent (can convert between them)
          const sourceConsistent = toISO639_3(output.sourceLanguage.iso639_1) === output.sourceLanguage.iso639_3 &&
            toISO639_1(output.sourceLanguage.iso639_3) === output.sourceLanguage.iso639_1;
          checks.push({ name: "source code consistency", passed: sourceConsistent });
        }

        if (hasTargetLanguage) {
          // Validate target ISO 639-1 format (2 letters)
          const targetISO639_1Valid = output.targetLanguage.iso639_1.length === 2 &&
            output.targetLanguage.iso639_1 === expected.targetLanguage;
          checks.push({ name: "target ISO 639-1", passed: targetISO639_1Valid });

          // Validate target ISO 639-3 format (3 letters)
          const targetISO639_3Valid = output.targetLanguage.iso639_3.length === 3 &&
            output.targetLanguage.iso639_3 === expected.expectedTargetISO639_3;
          checks.push({ name: "target ISO 639-3", passed: targetISO639_3Valid });

          // Validate target codes are consistent (can convert between them)
          const targetConsistent = toISO639_3(output.targetLanguage.iso639_1) === output.targetLanguage.iso639_3 &&
            toISO639_1(output.targetLanguage.iso639_3) === output.targetLanguage.iso639_1;
          checks.push({ name: "target code consistency", passed: targetConsistent });
        }

        const passedCount = checks.filter(c => c.passed).length;
        const failedChecks = checks.filter(c => !c.passed).map(c => c.name);

        return {
          score: passedCount / checks.length,
          metadata: failedChecks.length > 0 ? { failedChecks } : undefined,
        };
      },
    },

    // LANGUAGE CODE VALIDITY: Validate codes are recognized ISO standards
    {
      name: "language-code-validity",
      description: "Validates that language codes are recognized ISO 639-1 and ISO 639-3 standards.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const checks: boolean[] = [];

        if (output.sourceLanguage) {
          checks.push(isValidISO639_1(output.sourceLanguage.iso639_1));
          checks.push(isValidISO639_3(output.sourceLanguage.iso639_3));
        }

        if (output.targetLanguage) {
          checks.push(isValidISO639_1(output.targetLanguage.iso639_1));
          checks.push(isValidISO639_3(output.targetLanguage.iso639_3));
        }

        if (checks.length === 0) {
          return 0;
        }

        return checks.filter(Boolean).length / checks.length;
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // EFFICIENCY SCORERS
    // ─────────────────────────────────────────────────────────────────────────

    // LATENCY: Wall clock time performance
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
        // Linear interpolation between good and acceptable
        return 1 - 0.5 * ((latencyMs - LATENCY_THRESHOLD_GOOD_MS) / (LATENCY_THRESHOLD_ACCEPTABLE_MS - LATENCY_THRESHOLD_GOOD_MS));
      },
    },

    // TOKEN EFFICIENCY: Total token consumption
    {
      name: "token-efficiency",
      description: `Scores token usage: 1.0 for <${TOKEN_THRESHOLD_EFFICIENT} tokens, scaled down for higher usage.`,
      scorer: ({ output }: { output: EvalOutput }) => {
        const totalTokens = output.usage?.totalTokens ?? 0;
        if (totalTokens === 0) {
          return 0; // No usage data is a problem
        }
        if (totalTokens <= TOKEN_THRESHOLD_EFFICIENT) {
          return 1;
        }
        // Gradual decline for over-threshold usage
        return Math.max(0, 1 - (totalTokens - TOKEN_THRESHOLD_EFFICIENT) / TOKEN_THRESHOLD_EFFICIENT);
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // EXPENSE SCORERS
    // ─────────────────────────────────────────────────────────────────────────

    // USAGE DATA PRESENCE: Validates that usage metrics are available
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
    {
      name: "cost-within-budget",
      description: `Scores cost efficiency: 1.0 for <$${COST_THRESHOLD_USD}, scaled down for higher costs.`,
      scorer: ({ output }: { output: EvalOutput }) => {
        const { estimatedCostUsd } = output;
        if (estimatedCostUsd <= COST_THRESHOLD_USD) {
          return 1;
        }
        // Gradual decline for over-budget costs
        return Math.max(0, 1 - (estimatedCostUsd - COST_THRESHOLD_USD) / COST_THRESHOLD_USD);
      },
    },
  ],

  columns: async ({
    input,
    output,
  }: {
    input: { assetId: string; sourceLanguage: string; targetLanguage: string; targetLanguageName: string };
    output: EvalOutput;
  }) => {
    const srcLang = output.sourceLanguage;
    const tgtLang = output.targetLanguage;

    return [
      { label: "Asset ID", value: input.assetId },
      { label: "Provider", value: output.provider },
      { label: "Model", value: output.model },
      { label: "Source (ISO 639-1/3)", value: srcLang ? `${srcLang.iso639_1}/${srcLang.iso639_3}` : "N/A" },
      { label: "Target (ISO 639-1/3)", value: tgtLang ? `${tgtLang.iso639_1}/${tgtLang.iso639_3}` : "N/A" },
      { label: "Original Cues", value: countVttCues(output.originalVtt) },
      { label: "Translated Cues", value: countVttCues(output.translatedVtt) },
      { label: "Latency", value: `${Math.round(output.latencyMs)}ms` },
      { label: "Tokens", value: output.usage?.totalTokens ?? 0 },
      { label: "Cost", value: `$${output.estimatedCostUsd.toFixed(6)}` },
    ];
  },
});
