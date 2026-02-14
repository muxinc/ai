import { openai } from "@ai-sdk/openai";
import dedent from "dedent";
import { evalite } from "evalite";
import { answerSimilarity } from "evalite/scorers";
import { reportTrace } from "evalite/traces";

import { calculateCost, DEFAULT_LANGUAGE_MODELS } from "../../src/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "../../src/lib/providers";
import type { TokenUsage } from "../../src/types";
import { getSummaryAndTags, SUMMARY_KEYWORD_LIMIT } from "../../src/workflows";
import type { SummaryAndTagsResult } from "../../src/workflows";
import { getLatencyPerformanceDescription, scoreLatencyPerformance } from "../helpers/latency-performance";
import { muxTestAssets } from "../helpers/mux-test-assets";

/**
 * Summarization Evaluation
 *
 * This eval measures the efficacy, efficiency, and expense of the `getSummaryAndTags`
 * function across multiple AI providers (OpenAI, Anthropic, Google) to ensure consistent,
 * high-quality, fast, and cost-effective video metadata generation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EFFICACY GOALS — "Does it produce quality output?"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. TITLE QUALITY
 *    - Non-empty, compelling headline
 *    - Reasonable length (typically under 10 words / 100 chars)
 *    - Does NOT start with "A video of" or similar phrasing
 *    - Uses active, specific language
 *
 * 2. DESCRIPTION QUALITY
 *    - Non-empty, meaningful summary
 *    - Reasonable length (2-4 sentences, up to 1000 chars)
 *    - Describes observable content
 *
 * 3. TAGS QUALITY
 *    - Non-empty array of keywords
 *    - Up to 10 tags (respects SUMMARY_KEYWORD_LIMIT)
 *    - No duplicates (case-insensitive)
 *    - Lowercase format (per prompt requirements)
 *    - Concrete nouns and action verbs over abstract concepts
 *
 * 4. TAGS SIMILARITY (embeddings)
 *    - Compares generated tags to reference tags using cosine similarity
 *    - Allows flexible phrasing - good when keywords vary but meaning aligns
 *
 * 5. RESPONSE INTEGRITY
 *    - All required fields populated correctly
 *    - Types match expected schema
 *    - Storyboard URL properly generated
 *
 * 6. NO FILLER PHRASES
 *    - Description should NOT contain "the image shows", "the video shows", etc.
 *    - Content should be described directly without meta-references to the medium
 *
 * 7. TITLE SIMILARITY (embeddings)
 *    - Compares generated title to reference title using cosine similarity
 *    - Allows flexible phrasing - good when multiple wordings are valid
 *
 * 8. DESCRIPTION SIMILARITY (embeddings)
 *    - Compares generated description to reference using cosine similarity
 *    - Allows flexible phrasing - good when multiple wordings are valid
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EFFICIENCY GOALS — "How fast and scalable is it?"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. LATENCY
 *    - Wall clock time from request to response
 *    - Target: <8s for good UX, <20s for acceptable UX
 *    - Benchmark: OpenAI ~5-12s, Anthropic ~8s, Google ~9-11s
 *
 * 2. TOKEN EFFICIENCY
 *    - Total tokens consumed per summarization
 *    - Target: <4000 tokens for efficient operation
 *    - Benchmark: OpenAI ~1700, Google ~2200, Anthropic ~3500
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
 *    - Benchmark: Google ~$0.0008, OpenAI ~$0.002, Anthropic ~$0.013
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
 * A variety of video content types to test metadata generation quality:
 * - Different durations and content types
 * - Videos with and without dialogue/narration
 * - Various visual styles and subjects
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum acceptable title length in characters. */
const TITLE_MAX_LENGTH = 100;

/** Maximum acceptable description length in characters. */
const DESCRIPTION_MAX_LENGTH = 1000;

/**
 * Maximum acceptable latency in milliseconds for "good" performance.
 * Benchmark: OpenAI ~5-12s, Anthropic ~8s
 */
const LATENCY_THRESHOLD_GOOD_MS = 8000;

/**
 * Maximum acceptable latency in milliseconds for "acceptable" performance.
 * Benchmark: All providers under 12s
 */
const LATENCY_THRESHOLD_ACCEPTABLE_MS = 20000;

/**
 * Maximum total tokens considered efficient for this task.
 */
const TOKEN_THRESHOLD_EFFICIENT = 4000;

/**
 * Maximum cost per request considered acceptable (USD).
 * Benchmark: Google ~$0.0008, OpenAI ~$0.002, Anthropic ~$0.013
 */
const COST_THRESHOLD_USD = 0.015;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Extended output including provider/model metadata and performance metrics. */
interface EvalOutput extends SummaryAndTagsResult {
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
 * Video assets for summarization testing with reference answers for similarity evaluation.
 * Selected to represent different content types and complexities.
 */
interface TestAsset {
  assetId: string;
  /** Reference title for answerCorrectness evaluation */
  referenceTitle: string;
  /** Reference description for answerCorrectness evaluation */
  referenceDescription: string;
  /** Reference tags for semantic similarity evaluation */
  referenceTags: string[];
}

const testAssets: TestAsset[] = [
  {
    // Mux thumbnail and GIF demo video
    assetId: muxTestAssets.assetId,
    referenceTitle: "Mux API thumbnail and GIF demo",
    referenceDescription: dedent`
      A presenter demonstrates how to use the Mux API to grab thumbnails and GIFs from video.
      The demonstration shows using query parameters and a simple GET request to create stills and animated GIFs.
      The presenter sits at a desk with headphones, gestures while explaining the features, and gives a thumbs-up.
      The video promotes Mux's video capabilities with the tagline 'video is fun with Mux'.`,
    referenceTags: [
      "mux api",
      "thumbnail generation",
      "gif creation",
      "video api",
      "developer demo",
      "api tutorial",
      "video stills",
      "software demonstration",
      "technical presentation",
      "video processing",
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
    input: { assetId: asset.assetId, provider },
    expected: {
      referenceTitle: asset.referenceTitle,
      referenceDescription: asset.referenceDescription,
      referenceTags: asset.referenceTags,
    },
  })),
);

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

evalite("Summarization", {
  data,
  task: async ({ assetId, provider }): Promise<EvalOutput> => {
    const startTime = performance.now();
    const result = await getSummaryAndTags(assetId, {
      provider,
      includeTranscript: true,
    });
    const latencyMs = performance.now() - startTime;

    console.warn(
      `[summarization][${provider}] ${assetId}`,
      {
        title: result.title,
        description: result.description,
        tags: result.tags,
      },
    );

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
  // EFFICACY METRICS (content quality):
  // - Title Quality: Is the title well-formed and compelling?
  // - Title Similarity: Is title semantically similar to reference? (embeddings)
  // - Description Quality: Is the description informative?
  // - Tags Quality: Are tags relevant, unique, and properly formatted?
  // - Tags Similarity: Are tags semantically similar to reference? (embeddings)
  // - Response Integrity: Are all fields valid and properly formatted?
  // - No Filler Phrases: Does description avoid "the image shows" etc.?
  // - Description Similarity: Is description semantically similar to reference? (embeddings)
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

    // TITLE QUALITY: Non-empty, reasonable length, doesn't start with filler phrases
    {
      name: "title-quality",
      description: "Validates title is non-empty, under 100 chars, and doesn't start with 'A video of'.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const { title } = output;

        // Must be non-empty
        if (!title || title.trim().length === 0) {
          return 0;
        }

        // Must be reasonable length
        if (title.length > TITLE_MAX_LENGTH) {
          return 0.5;
        }

        // Should NOT start with filler phrases
        const fillerPhrases = [
          "a video of",
          "this video shows",
          "the video shows",
          "video of",
          "this is a video",
        ];
        const lowerTitle = title.toLowerCase().trim();
        if (fillerPhrases.some(phrase => lowerTitle.startsWith(phrase))) {
          return 0.5;
        }

        return 1;
      },
    },

    // TITLE SIMILARITY: Compare title against reference using semantic similarity
    {
      name: "title-similarity",
      description: "Evaluates title similarity to reference using embeddings (allows flexible phrasing).",
      scorer: async ({ output, expected }: { output: EvalOutput; expected: { referenceTitle: string } }) => {
        const result = await answerSimilarity({
          answer: output.title,
          reference: expected.referenceTitle,
          embeddingModel: openai.embedding("text-embedding-3-small"),
        });

        return {
          score: result.score,
        };
      },
    },

    // DESCRIPTION QUALITY: Non-empty, reasonable length
    {
      name: "description-quality",
      description: "Validates description is non-empty and under 1000 chars.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const { description } = output;

        // Must be non-empty
        if (!description || description.trim().length === 0) {
          return 0;
        }

        // Must be reasonable length
        if (description.length > DESCRIPTION_MAX_LENGTH) {
          return 0.5;
        }

        return 1;
      },
    },

    // TAGS QUALITY: Array with valid items, no duplicates, respects limit
    {
      name: "tags-quality",
      description: `Validates tags are an array of unique strings, up to ${SUMMARY_KEYWORD_LIMIT} items.`,
      scorer: ({ output }: { output: EvalOutput }) => {
        const { tags } = output;

        // Must be an array
        if (!Array.isArray(tags)) {
          return 0;
        }

        // Must have at least one tag
        if (tags.length === 0) {
          return 0;
        }

        // Must not exceed limit
        if (tags.length > SUMMARY_KEYWORD_LIMIT) {
          return 0.5;
        }

        // Check for duplicates (case-insensitive)
        const lowerTags = tags.map(t => (typeof t === "string" ? t.toLowerCase() : ""));
        const uniqueTags = new Set(lowerTags);
        if (uniqueTags.size !== tags.length) {
          return 0.5;
        }

        // All items must be non-empty strings
        const allValid = tags.every(tag => typeof tag === "string" && tag.trim().length > 0);
        if (!allValid) {
          return 0.5;
        }

        return 1;
      },
    },

    // TAGS SIMILARITY: Compare tags against reference using semantic similarity
    {
      name: "tags-similarity",
      description: "Evaluates tags similarity to reference using embeddings (allows flexible keyword phrasing).",
      scorer: async ({ output, expected }: { output: EvalOutput; expected: { referenceTags: string[] } }) => {
        const { tags } = output;

        // Join tags into comma-separated strings for semantic comparison
        const generatedTagsString = tags.join(", ");
        const referenceTagsString = expected.referenceTags.join(", ");

        const result = await answerSimilarity({
          answer: generatedTagsString,
          reference: referenceTagsString,
          embeddingModel: openai.embedding("text-embedding-3-small"),
        });

        return {
          score: result.score,
        };
      },
    },

    // RESPONSE INTEGRITY: Schema and shape validation
    {
      name: "response-integrity",
      description: "Validates all required fields are present and properly typed.",
      scorer: ({ output, input }: { output: EvalOutput; input: { assetId: string } }) => {
        const assetIdValid = output.assetId === input.assetId;
        const titleValid = typeof output.title === "string" && output.title.length > 0;
        const descriptionValid = typeof output.description === "string" && output.description.length > 0;
        const tagsValid = Array.isArray(output.tags);
        const storyboardValid = typeof output.storyboardUrl === "string" && output.storyboardUrl.startsWith("https://");

        return assetIdValid && titleValid && descriptionValid && tagsValid && storyboardValid ? 1 : 0;
      },
    },

    // NO FILLER PHRASES: Description should describe content directly without meta-references
    {
      name: "no-filler-phrases",
      description: "Validates description doesn't use meta-descriptive phrases like 'the image shows' or 'the video shows'.",
      scorer: ({ output }: { output: EvalOutput }) => {
        const { description, title } = output;

        // Filler phrases that reference the medium rather than describe content directly
        const fillerPhrases = [
          "the image shows",
          "the storyboard shows",
          "the video shows",
          "this video shows",
          "in this video",
          "this video features",
          "the frames depict",
          "the footage shows",
          "we can see",
          "you can see",
          "the clip shows",
          "the scene shows",
          "the image depicts",
          "the video depicts",
        ];

        const lowerDescription = description.toLowerCase();
        const lowerTitle = title.toLowerCase();
        const matchedPhrases: string[] = [];

        for (const phrase of fillerPhrases) {
          if (lowerDescription.includes(phrase) || lowerTitle.includes(phrase)) {
            matchedPhrases.push(phrase);
          }
        }

        if (matchedPhrases.length > 0) {
          return {
            score: 0,
            metadata: { matchedPhrases, message: "Found meta-descriptive filler phrases" },
          };
        }

        return 1;
      },
    },

    // DESCRIPTION SIMILARITY: Compare description against reference using semantic similarity
    {
      name: "description-similarity",
      description: "Evaluates description similarity to reference using embeddings (allows flexible phrasing).",
      scorer: async ({ output, expected }: { output: EvalOutput; expected: { referenceDescription: string } }) => {
        const result = await answerSimilarity({
          answer: output.description,
          reference: expected.referenceDescription,
          embeddingModel: openai.embedding("text-embedding-3-small"),
        });

        return {
          score: result.score,
        };
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
    // This catches bugs where undefined tokens would fall back to 0, inflating cost scores
    {
      name: "usage-data-present",
      description: "Ensures token usage data is returned for cost analysis (inputTokens and outputTokens must be > 0).",
      scorer: ({ output }: { output: EvalOutput }) => {
        const { usage } = output;

        // Must have usage object
        if (!usage) {
          return { score: 0, metadata: { reason: "No usage object returned" } };
        }

        const { inputTokens, outputTokens, totalTokens } = usage;

        // inputTokens must be present and > 0 (we always send input to the model)
        if (typeof inputTokens !== "number" || inputTokens <= 0) {
          return { score: 0, metadata: { reason: "inputTokens missing or zero", inputTokens } };
        }

        // outputTokens must be present and > 0 (model always generates output)
        if (typeof outputTokens !== "number" || outputTokens <= 0) {
          return { score: 0, metadata: { reason: "outputTokens missing or zero", outputTokens } };
        }

        // totalTokens should be consistent (if present)
        if (typeof totalTokens === "number" && totalTokens < inputTokens + outputTokens) {
          return { score: 0.5, metadata: { reason: "totalTokens inconsistent with input + output" } };
        }

        return 1;
      },
    },

    // COST ANALYSIS: Estimated cost per request
    {
      name: "cost-within-budget",
      description: `Scores cost efficiency: 1.0 for <${COST_THRESHOLD_USD}USD, scaled down for higher costs.`,
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

  columns: async ({ input, output }: { input: { assetId: string }; output: EvalOutput }) => {
    return [
      { label: "Asset ID", value: input.assetId },
      { label: "Provider", value: output.provider },
      { label: "Model", value: output.model },
      { label: "Title", value: output.title },
      { label: "Description", value: output.description },
      { label: "Tags Count", value: output.tags.length },
      { label: "Latency", value: `${Math.round(output.latencyMs)}ms` },
      { label: "Tokens", value: output.usage?.totalTokens ?? 0 },
      { label: "Cost", value: `$${output.estimatedCostUsd.toFixed(6)}` },
    ];
  },
});
