import { generateText, Output } from "ai";
import dedent from "dedent";
import { z } from "zod";

import type { ImageDownloadOptions } from "@mux/ai/lib/image-download";
import { downloadImageAsBase64 } from "@mux/ai/lib/image-download";
import { getPlaybackIdForAsset } from "@mux/ai/lib/mux-assets";
import { createTranscriptSection, renderSection } from "@mux/ai/lib/prompt-builder";
import { createLanguageModelFromConfig, resolveLanguageModelConfig } from "@mux/ai/lib/providers";
import type { ModelIdByProvider, SupportedProvider } from "@mux/ai/lib/providers";
import { withRetry } from "@mux/ai/lib/retry";
import { resolveMuxSigningContext } from "@mux/ai/lib/workflow-credentials";
import { getStoryboardUrl } from "@mux/ai/primitives/storyboards";
import { fetchTranscriptForAsset } from "@mux/ai/primitives/transcripts";
import type { ImageSubmissionMode, MuxAIOptions, TokenUsage, WorkflowCredentialsInput } from "@mux/ai/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A single yes/no question to be answered about video content. */
export interface Question {
  /** The question text */
  question: string;
}

/** A single answer to a yes/no question. */
export interface QuestionAnswer {
  /** The original question */
  question: string;
  /** Yes or no answer (strict) */
  answer: "yes" | "no";
  /** Confidence score between 0 and 1 */
  confidence: number;
  /** Reasoning explaining the answer based on observable evidence */
  reasoning: string;
}

/** Configuration options for askQuestions workflow. */
export interface AskQuestionsOptions extends MuxAIOptions {
  /** AI provider to run (defaults to 'openai'). */
  provider?: SupportedProvider;
  /** Provider-specific chat model identifier. */
  model?: ModelIdByProvider[SupportedProvider];
  /** Fetch transcript alongside storyboard (defaults to true). */
  includeTranscript?: boolean;
  /** Strip timestamps/markup from transcripts (defaults to true). */
  cleanTranscript?: boolean;
  /** How storyboard should be delivered to the provider (defaults to 'url'). */
  imageSubmissionMode?: ImageSubmissionMode;
  /** Fine-tune storyboard downloads when imageSubmissionMode === 'base64'. */
  imageDownloadOptions?: ImageDownloadOptions;
  /** Storyboard width in pixels (defaults to 640). */
  storyboardWidth?: number;
}

/** Structured return payload for askQuestions workflow. */
export interface AskQuestionsResult {
  /** Asset ID passed into the workflow. */
  assetId: string;
  /** Array of answers for each question. */
  answers: QuestionAnswer[];
  /** Storyboard image URL that was analyzed. */
  storyboardUrl: string;
  /** Token usage from the AI provider (for efficiency/cost analysis). */
  usage?: TokenUsage;
  /** Raw transcript text used for analysis (when includeTranscript is true). */
  transcriptText?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** Zod schema for a single answer. */
export const questionAnswerSchema = z.object({
  question: z.string(),
  answer: z.enum(["yes", "no"]),
  confidence: z.number(),
  reasoning: z.string(),
});

export type QuestionAnswerType = z.infer<typeof questionAnswerSchema>;

/** Zod schema for the complete response. */
export const askQuestionsSchema = z.object({
  answers: z.array(questionAnswerSchema),
});

export type AskQuestionsType = z.infer<typeof askQuestionsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = dedent`
  <role>
    You are a video content analyst specializing in binary classification tasks.
    Your job is to answer yes/no questions about video content based on storyboard
    images and optional transcript data.
  </role>

  <context>
    You will receive:
    - A storyboard image containing multiple sequential frames from a video
    - A list of yes/no questions about the video content
    - Optionally, a transcript of the audio/dialogue

    The storyboard frames are arranged in a grid and represent the visual
    progression of the content over time. Read frames left-to-right,
    top-to-bottom to understand the temporal sequence.
  </context>

  <transcript_guidance>
    When a transcript is provided:
    - Use it to understand spoken content, dialogue, and audio context
    - Correlate transcript with visual frames for comprehensive analysis
    - Consider both visual and audio evidence when answering questions
    - If transcript and visuals conflict, trust the visual evidence
  </transcript_guidance>

  <task>
    For each question provided, you must:
    1. Analyze the storyboard frames and transcript (if provided)
    2. Answer with ONLY "yes" or "no" - no other values are acceptable
    3. Provide a confidence score between 0 and 1 reflecting your certainty
    4. Explain your reasoning based on observable evidence
  </task>

  <answer_guidelines>
    - Answer "yes" only if you have clear evidence supporting the affirmative
    - Answer "no" if evidence contradicts or if insufficient evidence exists
    - Confidence should reflect the clarity and strength of evidence:
      * 0.9-1.0: Clear, unambiguous evidence
      * 0.7-0.9: Strong evidence with minor ambiguity
      * 0.5-0.7: Moderate evidence or some conflicting signals
      * 0.3-0.5: Weak evidence or significant ambiguity
      * 0.0-0.3: Very uncertain, minimal relevant evidence
    - Reasoning should cite specific visual or audio evidence
    - Be precise: cite specific frames, objects, actions, or transcript quotes
  </answer_guidelines>

  <constraints>
    - You MUST answer every question with either "yes" or "no"
    - Only describe observable evidence from frames or transcript
    - Do not fabricate details or make unsupported assumptions
    - Return structured data matching the requested schema exactly
  </constraints>

  <language_guidelines>
    When explaining reasoning:
    - Describe content directly, not the medium
    - BAD: "The video shows a person running"
    - GOOD: "A person runs through a park"
    - Be specific and evidence-based
  </language_guidelines>`;

function buildUserPrompt(
  questions: Question[],
  transcriptText?: string,
  isCleanTranscript: boolean = true,
): string {
  const questionsList = questions
    .map((q, idx) => `${idx + 1}. ${q.question}`)
    .join("\n");

  let prompt = dedent`
    <questions>
      Please answer the following yes/no questions about this video:

      ${questionsList}
    </questions>`;

  if (transcriptText) {
    const format = isCleanTranscript ? "plain text" : "WebVTT";
    const transcriptSection = createTranscriptSection(transcriptText, format);
    prompt = `${prompt}\n\n${renderSection(transcriptSection)}`;
  }

  return prompt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

interface AnalysisResponse {
  result: AskQuestionsType;
  usage: TokenUsage;
}

async function fetchImageAsBase64(
  imageUrl: string,
  imageDownloadOptions?: ImageDownloadOptions,
): Promise<string> {
  "use step";

  const downloadResult = await downloadImageAsBase64(imageUrl, imageDownloadOptions);
  return downloadResult.base64Data;
}

async function analyzeQuestionsWithStoryboard(
  imageDataUrl: string,
  provider: SupportedProvider,
  modelId: string,
  userPrompt: string,
  systemPrompt: string,
  credentials?: WorkflowCredentialsInput,
): Promise<AnalysisResponse> {
  "use step";
  const model = await createLanguageModelFromConfig(provider, modelId, credentials);

  const response = await generateText({
    model,
    output: Output.object({ schema: askQuestionsSchema }),
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
          { type: "image", image: imageDataUrl },
        ],
      },
    ],
  });

  return {
    result: {
      answers: response.output.answers.map(answer => ({
        ...answer,
        // Strip numbering prefix (e.g., "1. " or "2. ") from questions
        question: answer.question.replace(/^\d+\.\s*/, ""),
        confidence: Math.min(1, Math.max(0, answer.confidence)),
      })),
    },
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      reasoningTokens: response.usage.reasoningTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
    },
  };
}

/**
 * Answer yes/no questions about a Mux video asset by analyzing storyboard frames and transcript.
 *
 * This workflow takes a list of yes/no questions and returns structured answers with confidence
 * scores and reasoning for each question. All questions are processed in a single LLM call for
 * efficiency.
 *
 * @param assetId - The Mux asset ID to analyze
 * @param questions - Array of questions to answer (each must have a 'question' field)
 * @param options - Configuration options for the workflow
 * @returns Structured answers with confidence scores and reasoning
 *
 * @example
 * ```typescript
 * const result = await askQuestions("abc123", [
 *   { question: "Does this video contain cooking?" },
 *   { question: "Are there people visible in the video?" },
 * ]);
 *
 * console.log(result.answers[0]);
 * // {
 * //   question: "Does this video contain cooking?",
 * //   answer: "yes",
 * //   confidence: 0.95,
 * //   reasoning: "A chef prepares ingredients and cooks in a kitchen throughout the video."
 * // }
 * ```
 */
export async function askQuestions(
  assetId: string,
  questions: Question[],
  options?: AskQuestionsOptions,
): Promise<AskQuestionsResult> {
  "use workflow";

  // Validate questions array is non-empty
  if (!questions || questions.length === 0) {
    throw new Error("At least one question must be provided");
  }

  // Validate each question has valid text
  questions.forEach((q, idx) => {
    if (!q.question || typeof q.question !== "string" || !q.question.trim()) {
      throw new Error(
        `Question at index ${idx} is invalid: must have non-empty 'question' field`,
      );
    }
  });

  const {
    provider = "openai",
    model,
    includeTranscript = true,
    cleanTranscript = true,
    imageSubmissionMode = "url",
    imageDownloadOptions,
    storyboardWidth = 640,
    credentials,
  } = options ?? {};

  const modelConfig = resolveLanguageModelConfig({
    ...options,
    model,
    provider: provider as SupportedProvider,
  });

  // Fetch asset data and playback ID from Mux
  const { asset: assetData, playbackId, policy } = await getPlaybackIdForAsset(assetId, credentials);

  // Resolve signing context for signed playback IDs
  const signingContext = await resolveMuxSigningContext(credentials);
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. " +
      "Set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  const transcriptText =
    includeTranscript ?
        (await fetchTranscriptForAsset(assetData, playbackId, {
          cleanTranscript,
          shouldSign: policy === "signed",
        })).transcriptText :
      "";

  // Build the user prompt with questions and optional transcript
  const userPrompt = buildUserPrompt(questions, transcriptText, cleanTranscript);

  // Generate storyboard URL (signed if needed)
  const imageUrl = await getStoryboardUrl(
    playbackId,
    storyboardWidth,
    policy === "signed",
    credentials,
  );

  let analysisResponse: AnalysisResponse;

  try {
    if (imageSubmissionMode === "base64") {
      const base64Data = await fetchImageAsBase64(imageUrl, imageDownloadOptions);
      analysisResponse = await analyzeQuestionsWithStoryboard(
        base64Data,
        modelConfig.provider,
        modelConfig.modelId,
        userPrompt,
        SYSTEM_PROMPT,
        credentials,
      );
    } else {
      // URL-based submission with retry
      analysisResponse = await withRetry(() =>
        analyzeQuestionsWithStoryboard(
          imageUrl,
          modelConfig.provider,
          modelConfig.modelId,
          userPrompt,
          SYSTEM_PROMPT,
          credentials,
        ),
      );
    }
  } catch (error: unknown) {
    throw new Error(
      `Failed to analyze questions with ${provider}: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }

  if (!analysisResponse.result?.answers) {
    throw new Error(`Failed to get answers for asset ${assetId}`);
  }

  // Validate we got answers for all questions
  if (analysisResponse.result.answers.length !== questions.length) {
    throw new Error(
      `Expected ${questions.length} answers but received ${analysisResponse.result.answers.length}`,
    );
  }

  return {
    assetId,
    answers: analysisResponse.result.answers,
    storyboardUrl: imageUrl,
    usage: analysisResponse.usage,
    transcriptText: transcriptText || undefined,
  };
}
