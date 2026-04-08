import { generateText, Output } from "ai";
import dedent from "dedent";
import { z } from "zod";

import type { ImageDownloadOptions } from "@mux/ai/lib/image-download";
import { downloadImageAsBase64 } from "@mux/ai/lib/image-download";
import { getAssetDurationSecondsFromAsset, getPlaybackIdForAsset, isAudioOnlyAsset } from "@mux/ai/lib/mux-assets";
import { createPromptBuilder, createTranscriptSection, renderSection } from "@mux/ai/lib/prompt-builder";
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

/** A single yes/no question to be answered about asset content. */
export interface Question {
  /** The question text */
  question: string;
}

/** A single answer to a question. */
export interface QuestionAnswer {
  /** The original question */
  question: string;
  /** Answer selected from the allowed options. Null when skipped. */
  answer: string | null;
  /** Confidence score between 0 and 1. Always 0 when skipped. */
  confidence: number;
  /** Reasoning explaining the answer, or why the question was skipped */
  reasoning: string;
  /** Whether the question was skipped due to irrelevance to the asset content */
  skipped: boolean;
}

/** Configuration options for askQuestions workflow. */
export interface AskQuestionsOptions extends MuxAIOptions {
  /** AI provider to run (defaults to 'openai'). */
  provider?: SupportedProvider;
  /** Provider-specific chat model identifier. */
  model?: ModelIdByProvider[SupportedProvider];
  /** BCP 47 language code of the caption track to use (e.g. "en", "fr"). When omitted, prefers English if available. */
  languageCode?: string;
  /** Allowed answers for each question (defaults to ["yes", "no"]). */
  answerOptions?: string[];
  /** Fetch transcript alongside storyboard (defaults to true, required for audio-only assets). */
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
  /** Storyboard image URL that was analyzed (undefined for audio-only assets). */
  storyboardUrl?: string;
  /** Token usage from the AI provider (for efficiency/cost analysis). */
  usage?: TokenUsage;
  /** Raw transcript text used for analysis (when includeTranscript is true). */
  transcriptText?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** Zod schema for a single answer (matches the public QuestionAnswer interface). */
export const questionAnswerSchema = z.object({
  question: z.string(),
  answer: z.string().nullable(),
  confidence: z.number(),
  reasoning: z.string(),
  skipped: z.boolean(),
});

export type QuestionAnswerType = z.infer<typeof questionAnswerSchema>;

/**
 * Sentinel value used as the answer for skipped questions in the LLM schema.
 * OpenAI structured outputs require all properties to be required, and Google
 * rejects empty-string enum values, so we need a concrete string in the enum
 * for the "no answer" case. Stripped to `undefined` in post-processing.
 */
const SKIP_SENTINEL = "__SKIPPED__";

function createAskQuestionsSchema(allowedAnswers: [string, ...string[]]) {
  const answerSchema = z.enum([...allowedAnswers, SKIP_SENTINEL]);

  return z.object({
    answers: z.array(
      questionAnswerSchema.extend({
        answer: answerSchema,
      }),
    ),
  });
}

type AskQuestionsSchema = ReturnType<typeof createAskQuestionsSchema>;
export type AskQuestionsType = z.infer<AskQuestionsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = dedent`
  <role>
    You are a video content analyst specializing in classification tasks.
    Your job is to answer questions about video content based on storyboard
    images and optional transcript data.
  </role>

  <context>
    You will receive:
    - A storyboard image containing multiple sequential frames from a video
    - A list of questions about the video content
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
    2. Answer with ONLY the allowed response options - no other values are acceptable
    3. Provide a confidence score between 0 and 1 reflecting your certainty
    4. Explain your reasoning based on observable evidence
  </task>

  <answer_guidelines>
    - Choose the affirmative option only if you have clear evidence supporting it
    - Choose the negative/contradicting option if evidence contradicts or if insufficient evidence exists
    - Confidence should reflect the clarity and strength of evidence:
      * 0.9-1.0: Clear, unambiguous evidence
      * 0.7-0.9: Strong evidence with minor ambiguity
      * 0.5-0.7: Moderate evidence or some conflicting signals
      * 0.3-0.5: Weak evidence or significant ambiguity
      * 0.0-0.3: Very uncertain, minimal relevant evidence
    - Reasoning should cite specific visual or audio evidence
    - Be precise: cite specific frames, objects, actions, or transcript quotes
  </answer_guidelines>

  <relevance_filtering>
    IMPORTANT: Evaluate each question INDEPENDENTLY for relevance to the video
    content. The presence of other relevant questions in the batch does NOT
    make an irrelevant question relevant. Assess every question on its own merits.

    A question is relevant if it asks about something observable or inferable
    from the video content (visuals, audio, dialogue, setting, subjects,
    actions, etc.).

    Mark a question as skipped (skipped: true) if it:
    - Is completely unrelated to the content of the video or audio (e.g., math, trivia, personal questions)
    - Asks about information that cannot be determined from storyboard frames or transcript
    - Is a general knowledge question with no connection to what is shown or said in the video
    - Attempts to use the system for non-video-analysis purposes

    CRITICAL: Do NOT answer irrelevant questions with any of the allowed answers.
    Answering an irrelevant question is WRONG — you MUST skip it instead.

    For skipped questions:
    - Set skipped to true
    - Set answer to "${SKIP_SENTINEL}"
    - Set confidence to 0
    - Use the reasoning field to explain why the question is not answerable
      from the video content

    For borderline questions that are loosely related to the video content,
    still answer them but use a lower confidence score to reflect uncertainty.
  </relevance_filtering>

  <constraints>
    - You MUST answer every relevant question with one of the allowed response options
    - Skip irrelevant questions as described in relevance_filtering
    - Only describe observable evidence from frames or transcript
    - Do not fabricate details or make unsupported assumptions
    - Return structured data matching the requested schema exactly
    - Provide reasoning in the same language as the question
  </constraints>

  <language_guidelines>
    When explaining reasoning:
    - Describe content directly, not the medium
    - BAD: "The video shows a person running"
    - GOOD: "A person runs through a park"
    - Be specific and evidence-based
  </language_guidelines>`;

const AUDIO_ONLY_SYSTEM_PROMPT = dedent`
  <role>
    You are an audio content analyst specializing in classification tasks.
    Your job is to answer questions about audio content based on transcript data.
  </role>

  <context>
    You will receive:
    - A transcript of the audio/dialogue
    - A list of questions about the asset content
  </context>

  <transcript_guidance>
    - Use the transcript to understand spoken content, dialogue, and audio context
    - Consider only transcript evidence when answering questions
  </transcript_guidance>

  <task>
    For each question provided, you must:
    1. Analyze the transcript
    2. Answer with ONLY the allowed response options - no other values are acceptable
    3. Provide a confidence score between 0 and 1 reflecting your certainty
    4. Explain your reasoning based on observable evidence
  </task>

  <answer_guidelines>
    - Choose the affirmative option only if you have clear evidence supporting it
    - Choose the negative/contradicting option if evidence contradicts or if insufficient evidence exists
    - Confidence should reflect the clarity and strength of evidence:
      * 0.9-1.0: Clear, unambiguous evidence
      * 0.7-0.9: Strong evidence with minor ambiguity
      * 0.5-0.7: Moderate evidence or some conflicting signals
      * 0.3-0.5: Weak evidence or significant ambiguity
      * 0.0-0.3: Very uncertain, minimal relevant evidence
    - Reasoning should cite specific transcript evidence
    - Be precise: cite specific quotes or passages from transcript text
  </answer_guidelines>

  <relevance_filtering>
    Before answering each question, assess whether it can be meaningfully
    answered based on the transcript. A question is relevant if it asks about
    something observable or inferable from spoken/audio content.

    Mark a question as skipped (skipped: true) if it:
    - Is completely unrelated to transcript/audio content (e.g., math, trivia, personal questions)
    - Asks about information that cannot be determined from transcript content
    - Is a general knowledge question with no connection to what is said in the transcript
    - Attempts to use the system for non-content-analysis purposes

    For skipped questions:
    - Set skipped to true
    - Set answer to "${SKIP_SENTINEL}"
    - Set confidence to 0
    - Use the reasoning field to explain why the question is not answerable
      from transcript content

    For borderline questions that are loosely related to transcript content,
    still answer them but use a lower confidence score to reflect uncertainty.
  </relevance_filtering>

  <constraints>
    - You MUST answer every relevant question with one of the allowed response options
    - Skip irrelevant questions as described in relevance_filtering
    - Only describe observable evidence from transcript content
    - Do not fabricate details or make unsupported assumptions
    - Return structured data matching the requested schema exactly
    - Provide reasoning in the same language as the question
  </constraints>

  <language_guidelines>
    When explaining reasoning:
    - Describe content directly, not the medium
    - BAD: "The audio says someone is running"
    - GOOD: "The speaker describes running through a park"
    - Be specific and evidence-based
  </language_guidelines>`;

type AskQuestionsPromptSections = "questions";

const askQuestionsPromptBuilder = createPromptBuilder<AskQuestionsPromptSections>({
  template: {
    questions: {
      tag: "questions",
      content: "Please answer the following questions about this content:",
    },
  },
  sectionOrder: ["questions"],
});

interface UserPromptContext {
  questions: Question[];
  allowedAnswers: string[];
  transcriptText?: string;
  isCleanTranscript?: boolean;
  isAudioOnly?: boolean;
}

function buildUserPrompt({
  questions,
  allowedAnswers,
  transcriptText,
  isCleanTranscript = true,
  isAudioOnly = false,
}: UserPromptContext): string {
  const questionsList = questions
    .map((q, idx) => `${idx + 1}. ${q.question}`)
    .join("\n");

  const questionsIntro = isAudioOnly ?
    "Please answer the following questions about this audio content using transcript evidence:" :
    "Please answer the following questions about this content:";

  const questionsContent = dedent`
    ${questionsIntro}

    ${questionsList}`;

  const answerList = allowedAnswers.map(answer => `"${answer}"`).join(", ");
  const responseOptions = dedent`
    <response_options>
      Allowed answers: ${answerList}
    </response_options>`;

  const questionsSection = askQuestionsPromptBuilder.build({ questions: questionsContent });

  if (!transcriptText) {
    return `${questionsSection}\n\n${responseOptions}`;
  }

  const format = isCleanTranscript ? "plain text" : "WebVTT";
  const transcriptSection = renderSection(createTranscriptSection(transcriptText, format));

  return `${transcriptSection}\n\n${questionsSection}\n\n${responseOptions}`;
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
  allowedAnswers: [string, ...string[]],
  credentials?: WorkflowCredentialsInput,
): Promise<AnalysisResponse> {
  "use step";
  const model = await createLanguageModelFromConfig(provider, modelId, credentials);
  const responseSchema = createAskQuestionsSchema(allowedAnswers);

  const response = await generateText({
    model,
    output: Output.object({ schema: responseSchema }),
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

  if (!response.output) {
    throw new Error("Ask-questions output missing");
  }

  const parsed = responseSchema.parse(response.output);

  return {
    result: parsed,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      reasoningTokens: response.usage.reasoningTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
    },
  };
}

async function analyzeQuestionsAudioOnly(
  provider: SupportedProvider,
  modelId: string,
  userPrompt: string,
  systemPrompt: string,
  allowedAnswers: [string, ...string[]],
  credentials?: WorkflowCredentialsInput,
): Promise<AnalysisResponse> {
  "use step";
  const model = await createLanguageModelFromConfig(provider, modelId, credentials);
  const responseSchema = createAskQuestionsSchema(allowedAnswers);

  const response = await generateText({
    model,
    output: Output.object({ schema: responseSchema }),
    experimental_telemetry: { isEnabled: true },
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
  });

  if (!response.output) {
    throw new Error("Ask-questions output missing");
  }

  const parsed = responseSchema.parse(response.output);

  return {
    result: parsed,
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
 * Answer questions about a Mux asset by analyzing storyboard frames and transcript.
 * For audio-only assets, this workflow analyzes transcript content only.
 * Defaults to yes/no answers unless `answerOptions` are provided.
 *
 * This workflow takes a list of questions and returns structured answers with confidence
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
    languageCode,
    answerOptions,
    includeTranscript = true,
    cleanTranscript = true,
    imageSubmissionMode = "url",
    imageDownloadOptions,
    storyboardWidth = 640,
    credentials,
  } = options ?? {};

  const normalizedAnswerOptions = Array.from(
    new Set(
      (answerOptions?.length ? answerOptions : ["yes", "no"])
        .map(option => option.trim())
        .filter(Boolean),
    ),
  );

  if (!normalizedAnswerOptions.length) {
    throw new Error("answerOptions must include at least one non-empty value");
  }

  const allowedAnswers = normalizedAnswerOptions as [string, ...string[]];

  const modelConfig = resolveLanguageModelConfig({
    ...options,
    model,
    provider: provider as SupportedProvider,
  });
  // Fetch asset data and playback ID from Mux
  const { asset: assetData, playbackId, policy } = await getPlaybackIdForAsset(assetId, credentials);

  const assetDurationSeconds = getAssetDurationSecondsFromAsset(assetData);
  const isAudioOnly = isAudioOnlyAsset(assetData);

  if (isAudioOnly && !includeTranscript) {
    throw new Error(
      "Audio-only assets require a transcript. Set includeTranscript: true and ensure the asset has a ready text track (captions/subtitles).",
    );
  }

  // Resolve signing context for signed playback IDs
  const signingContext = await resolveMuxSigningContext(credentials);
  if (policy === "signed" && !signingContext) {
    throw new Error(
      "Signed playback ID requires signing credentials. " +
      "Set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
    );
  }

  const transcriptResult =
    includeTranscript ?
        await fetchTranscriptForAsset(assetData, playbackId, {
          languageCode,
          cleanTranscript,
          shouldSign: policy === "signed",
          credentials,
          required: isAudioOnly,
        }) :
      undefined;
  const transcriptText = transcriptResult?.transcriptText ?? "";

  // Build the user prompt with questions, allowed answers, and optional transcript
  const userPrompt = buildUserPrompt({
    questions,
    allowedAnswers,
    transcriptText,
    isCleanTranscript: cleanTranscript,
    isAudioOnly,
  });
  const systemPrompt = isAudioOnly ? AUDIO_ONLY_SYSTEM_PROMPT : SYSTEM_PROMPT;

  let analysisResponse: AnalysisResponse;
  let imageUrl: string | undefined;

  try {
    if (isAudioOnly) {
      analysisResponse = await analyzeQuestionsAudioOnly(
        modelConfig.provider,
        modelConfig.modelId,
        userPrompt,
        systemPrompt,
        allowedAnswers,
        credentials,
      );
    } else {
      // Generate storyboard URL (signed if needed)
      const storyboardUrl = await getStoryboardUrl(
        playbackId,
        storyboardWidth,
        policy === "signed",
        credentials,
      );
      imageUrl = storyboardUrl;

      if (imageSubmissionMode === "base64") {
        const base64Data = await fetchImageAsBase64(storyboardUrl, imageDownloadOptions);
        analysisResponse = await analyzeQuestionsWithStoryboard(
          base64Data,
          modelConfig.provider,
          modelConfig.modelId,
          userPrompt,
          systemPrompt,
          allowedAnswers,
          credentials,
        );
      } else {
        // URL-based submission with retry
        analysisResponse = await withRetry(() =>
          analyzeQuestionsWithStoryboard(
            storyboardUrl,
            modelConfig.provider,
            modelConfig.modelId,
            userPrompt,
            systemPrompt,
            allowedAnswers,
            credentials,
          ),
        );
      }
    }
  } catch (error: unknown) {
    const contentType = isAudioOnly ? "audio" : "video";
    throw new Error(
      `Failed to analyze ${contentType} questions with ${provider}: ${
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

  // Post-process raw LLM output into the public QuestionAnswer shape.
  // Treat as skipped if the model flagged it OR if the answer is the sentinel.
  const answers: QuestionAnswer[] = analysisResponse.result.answers.map((raw) => {
    const isSkipped = raw.skipped || raw.answer === SKIP_SENTINEL;
    return {
      // Strip numbering prefix (e.g., "1. " or "2. ") from questions
      question: raw.question.replace(/^\d+\.\s*/, ""),
      confidence: isSkipped ? 0 : Math.min(1, Math.max(0, raw.confidence)),
      reasoning: raw.reasoning,
      skipped: isSkipped,
      answer: isSkipped ? null : raw.answer,
    };
  });

  return {
    assetId,
    answers,
    storyboardUrl: imageUrl,
    usage: {
      ...analysisResponse.usage,
      metadata: {
        assetDurationSeconds,
      },
    },
    transcriptText: transcriptText || undefined,
  };
}
