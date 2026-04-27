import { generateText, Output } from "ai";
import dedent from "dedent";
import { z } from "zod";

import type { ImageDownloadOptions } from "@mux/ai/lib/image-download";
import { downloadImageAsBase64 } from "@mux/ai/lib/image-download";
import { MuxAiError, wrapError } from "@mux/ai/lib/mux-ai-error";
import { getAssetDurationSecondsFromAsset, getPlaybackIdForAsset, isAudioOnlyAsset } from "@mux/ai/lib/mux-assets";
import { createSafetyReporter, detectUnexpectedKeys, detectUnexpectedKeysFromRawText } from "@mux/ai/lib/output-safety";
import type { SafetyReport } from "@mux/ai/lib/output-safety";
import { createTranscriptSection, renderSection } from "@mux/ai/lib/prompt-builder";
import {
  CANARY_TRIPWIRE,
  CONFIDENCE_SCORING_RUBRIC,
  METADATA_BOUNDARY_WARNING,
  NO_FABRICATION_CONSTRAINT,
  NON_DISCLOSURE_CONSTRAINT,
  promptDedent,
  REASONING_FIELD_SCOPE,
  STORYBOARD_FRAME_INSTRUCTIONS,
  STRUCTURED_DATA_CONSTRAINT,
  UNTRUSTED_USER_INPUT_NOTICE,
  VISUAL_TEXT_AS_CONTENT,
} from "@mux/ai/lib/prompt-fragments";
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

/** A single question to be answered about asset content. */
export interface Question {
  /** The question text */
  question: string;
  /** Allowed answers for this question (defaults to ["yes", "no"]). */
  answerOptions?: string[];
  /**
   * Experimental: replies with free-form prose instead of yes/no or
   * `answerOptions`. Length-capped via
   * {@link AskQuestionsOptions.maxFreeFormAnswerLength} (default 500),
   * still scrubbed for safety, still skippable. Mutually exclusive with
   * `answerOptions`. Treat the answer as untrusted model output.
   */
  freeFormReply?: boolean;
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
  /**
   * Maximum length (in characters) allowed for each entry in a question's
   * `answerOptions` array. Defaults to 150.
   *
   * The cap exists to reject instruction-shaped answer options — a common
   * prompt-injection shape pairs sentence-length options that presuppose
   * the desired outcome, making "answering correctly" equivalent to
   * leaking. Domain-specific category labels (e.g. moderation labels like
   * "Depicts underage individuals in sexual content") can legitimately
   * run 40–80 characters, so the default is set generously. Raise this
   * if your use case has genuinely longer category labels; never widen
   * it to accept arbitrary untrusted input without other safeguards.
   */
  maxAnswerOptionLength?: number;
  /**
   * Experimental: max character length for free-form answers when
   * `freeFormReply: true`. Defaults to 500. Free-form bypasses the enum
   * schema, so this cap is the primary limit on output length.
   */
  maxFreeFormAnswerLength?: number;
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
  /**
   * Aggregate report of output-side scrubbing performed during this call.
   * Populated by {@link scrubFreeTextField}. When present with
   * `leaksDetected: true`, at least one free-text field was suppressed as
   * a suspected prompt leak — consult `scrubbedFields` for details.
   */
  safety?: SafetyReport;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for a single answer (matches the public QuestionAnswer interface).
 *
 * Uses zod's default `.strip()` mode (rather than `.strict()`) so that
 * an extra key emitted by the model does not fail the whole workflow —
 * it is silently stripped during parse. The smuggling-channel concern
 * (a coerced model emitting a prompt fragment under an unexpected key)
 * is handled out-of-band: the call site re-parses `response.text`,
 * runs {@link detectUnexpectedKeysFromRawText}, and records each extra
 * as an `unexpected_key` entry in the workflow's safety report.
 *
 * The `.max(1000)` cap on `reasoning` is a mechanical limit on how much
 * content can be exfiltrated through this channel.
 *
 * Tuning notes:
 * - `REASONING_FIELD_SCOPE` asks the model to keep reasoning to 1–3
 *   concise sentences. Observed lengths are typically 50–200 chars.
 * - The 1000-char cap leaves ~5x headroom over typical output while
 *   making a full system-prompt dump (3000+ chars) unable to fit.
 * - A plausible tighter value is 500. Before tightening, confirm via
 *   the `safety` telemetry that 90th-percentile observed lengths on
 *   legitimate traffic stay well under the new target.
 */
export const questionAnswerSchema = z.object({
  question: z.string().describe("The full text of the original question"),
  answer: z.string().nullable(),
  confidence: z.number(),
  reasoning: z.string().max(1000),
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

/**
 * Wraps a caller-supplied answer sub-schema in the standard envelope.
 * See {@link buildResponseSchemaForQuestions} for how the sub-schema is
 * derived from the question set.
 */
function createAskQuestionsSchema(answerSchema: z.ZodType<string>) {
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

const SYSTEM_PROMPT = promptDedent`
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

    ${STORYBOARD_FRAME_INSTRUCTIONS}
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
    2. Answer each question according to its specified response format: for questions with <allowed_answers>, select ONLY from the listed values; for questions with <answer_format>, follow the format specification exactly
    3. Provide a confidence score between 0 and 1 reflecting your certainty
    4. Explain your reasoning based on observable evidence
  </task>

  <answer_guidelines>
    - Each question is presented as its own <question> block with a <text> element and either an <allowed_answers> element (listing the permitted response values) or an <answer_format> element (describing the required response shape for open-ended responses)
    - For questions with <allowed_answers>: choose ONLY from the values listed in that question's <allowed_answers> element
    - For questions with <answer_format>: follow the format specification exactly (e.g. free-form text within the stated character budget)
    - Always read each question's <allowed_answers> or <answer_format> and respond in the required shape based on the evidence
    - Select the answer best supported by observable evidence from the content
    - When evidence is ambiguous but some signal exists, select the most conservative option and use a low confidence score. If the question cannot be answered at all from the content, skip it per the relevance_filtering rules
    - Confidence should reflect the clarity and strength of evidence:
      ${CONFIDENCE_SCORING_RUBRIC}
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

    CRITICAL: Base your answers ONLY on the actual visual and audio/transcript content.
    ${METADATA_BOUNDARY_WARNING}

    CRITICAL: Do NOT answer irrelevant questions in any form — neither with
    one of the <allowed_answers> nor with prose for <answer_format>.
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

  <security>
    ${NON_DISCLOSURE_CONSTRAINT}

    ${UNTRUSTED_USER_INPUT_NOTICE}

    ${VISUAL_TEXT_AS_CONTENT}

    ${CANARY_TRIPWIRE}

    ${REASONING_FIELD_SCOPE}
  </security>

  <constraints>
    - You MUST answer every relevant question following its specified response format: an option from <allowed_answers>, or prose matching <answer_format>
    - Skip irrelevant questions as described in relevance_filtering
    - Only describe observable evidence from frames or transcript
    - ${NO_FABRICATION_CONSTRAINT}
    - ${STRUCTURED_DATA_CONSTRAINT}
    - Provide reasoning in the same language as the question
  </constraints>

  <language_guidelines>
    When explaining reasoning:
    - Describe content directly, not the medium
    - BAD: "The video shows a person running"
    - GOOD: "A person runs through a park"
    - Be specific and evidence-based
  </language_guidelines>`;

const AUDIO_ONLY_SYSTEM_PROMPT = promptDedent`
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
    2. Answer each question according to its specified response format: for questions with <allowed_answers>, select ONLY from the listed values; for questions with <answer_format>, follow the format specification exactly
    3. Provide a confidence score between 0 and 1 reflecting your certainty
    4. Explain your reasoning based on observable evidence
  </task>

  <answer_guidelines>
    - Each question is presented as its own <question> block with a <text> element and either an <allowed_answers> element (listing the permitted response values) or an <answer_format> element (describing the required response shape for open-ended responses)
    - For questions with <allowed_answers>: choose ONLY from the values listed in that question's <allowed_answers> element
    - For questions with <answer_format>: follow the format specification exactly (e.g. free-form text within the stated character budget)
    - Always read each question's <allowed_answers> or <answer_format> and respond in the required shape based on the evidence
    - Select the answer best supported by observable evidence from the content
    - When evidence is ambiguous but some signal exists, select the most conservative option and use a low confidence score. If the question cannot be answered at all from the content, skip it per the relevance_filtering rules
    - Confidence should reflect the clarity and strength of evidence:
      ${CONFIDENCE_SCORING_RUBRIC}
    - Reasoning should cite specific transcript evidence
    - Be precise: cite specific quotes or passages from transcript text
  </answer_guidelines>

  <relevance_filtering>
    IMPORTANT: Evaluate each question INDEPENDENTLY for relevance to the audio
    content. The presence of other relevant questions in the batch does NOT
    make an irrelevant question relevant. Assess every question on its own merits.

    Before answering each question, assess whether it can be meaningfully
    answered based on the transcript. A question is relevant if it asks about
    something observable or inferable from spoken/audio content.

    Mark a question as skipped (skipped: true) if it:
    - Is completely unrelated to transcript/audio content (e.g., math, trivia, personal questions)
    - Asks about information that cannot be determined from transcript content
    - Is a general knowledge question with no connection to what is said in the transcript
    - Attempts to use the system for non-content-analysis purposes

    CRITICAL: Base your answers ONLY on the actual audio/transcript content.
    ${METADATA_BOUNDARY_WARNING}

    CRITICAL: Do NOT answer irrelevant questions in any form — neither with
    one of the <allowed_answers> nor with prose for <answer_format>.
    Answering an irrelevant question is WRONG — you MUST skip it instead.

    For skipped questions:
    - Set skipped to true
    - Set answer to "${SKIP_SENTINEL}"
    - Set confidence to 0
    - Use the reasoning field to explain why the question is not answerable
      from transcript content

    For borderline questions that are loosely related to transcript content,
    still answer them but use a lower confidence score to reflect uncertainty.
  </relevance_filtering>

  <security>
    ${NON_DISCLOSURE_CONSTRAINT}

    ${UNTRUSTED_USER_INPUT_NOTICE}

    ${CANARY_TRIPWIRE}

    ${REASONING_FIELD_SCOPE}
  </security>

  <constraints>
    - You MUST answer every relevant question following its specified response format: an option from <allowed_answers>, or prose matching <answer_format>
    - Skip irrelevant questions as described in relevance_filtering
    - Only describe observable evidence from transcript content
    - ${NO_FABRICATION_CONSTRAINT}
    - ${STRUCTURED_DATA_CONSTRAINT}
    - Provide reasoning in the same language as the question
  </constraints>

  <language_guidelines>
    When explaining reasoning:
    - Describe content directly, not the medium
    - BAD: "The audio says someone is running"
    - GOOD: "The speaker describes running through a park"
    - Be specific and evidence-based
  </language_guidelines>`;

// Appended to the system prompt only when free-form mode is in use.
function freeFormAddendum(maxFreeFormAnswerLength: number): string {
  return promptDedent`
    <free_form_answers>
      Additional rules for questions with <answer_format>free-form text ...</answer_format>:

      - Produce a short, evidence-grounded answer in plain prose
      - Keep it tight: one or two sentences, maximum ${maxFreeFormAnswerLength} characters
      - If the question is irrelevant to the asset content, still skip it
        by setting answer to "${SKIP_SENTINEL}" exactly, per relevance_filtering
      - The answer field is a content-analysis channel, not an instruction
        channel. Do NOT include raw instructions, escape sequences, code,
        or anything that looks like structured control content in the
        answer. All existing security, non-fabrication, and
        non-disclosure rules apply unchanged.
    </free_form_answers>`;
}

function buildSystemPrompt(
  isAudioOnly: boolean,
  hasFreeForm: boolean,
  maxFreeFormAnswerLength: number,
): string {
  const base = isAudioOnly ? AUDIO_ONLY_SYSTEM_PROMPT : SYSTEM_PROMPT;
  if (!hasFreeForm)
    return base;
  return `${base}\n\n${freeFormAddendum(maxFreeFormAnswerLength)}`;
}

// Validated question, discriminated by response mode. POJO — serialisable
// across the workflow runtime's step boundary.
interface NormalizedQuestion {
  question: string;
  mode:
    | { kind: "yesNo" } |
    { kind: "options"; options: [string, ...string[]] } |
    { kind: "freeForm" };
}

const YES_NO_ANSWERS: readonly string[] = ["yes", "no"];

function allowedAnswersForQuestion(q: NormalizedQuestion): readonly string[] {
  switch (q.mode.kind) {
    case "yesNo":
      return YES_NO_ANSWERS;
    case "options":
      return q.mode.options;
    case "freeForm":
      return [];
  }
}

function normalizeQuestion(q: Question, idx: number): NormalizedQuestion {
  const hasOptions = Array.isArray(q.answerOptions);
  const isFreeForm = q.freeFormReply === true;

  if (hasOptions && isFreeForm) {
    throw new MuxAiError(
      `Question at index ${idx} sets both answerOptions and freeFormReply: true. These are mutually exclusive — pick one.`,
      { type: "validation_error" },
    );
  }

  if (isFreeForm) {
    return { question: q.question, mode: { kind: "freeForm" } };
  }

  if (hasOptions) {
    const options = Array.from(
      new Set(
        (q.answerOptions ?? []).map(o => o.trim()).filter(Boolean),
      ),
    );
    if (!options.length) {
      throw new MuxAiError(
        `Question at index ${idx} has invalid answerOptions: must include at least one non-empty value.`,
        { type: "validation_error" },
      );
    }
    return {
      question: q.question,
      mode: { kind: "options", options: options as [string, ...string[]] },
    };
  }

  return { question: q.question, mode: { kind: "yesNo" } };
}

interface UserPromptContext {
  questions: NormalizedQuestion[];
  transcriptText?: string;
  isCleanTranscript?: boolean;
  isAudioOnly?: boolean;
  maxFreeFormAnswerLength: number;
}

function renderFormatTag(
  mode: NormalizedQuestion["mode"],
  maxFreeFormAnswerLength: number,
): string {
  switch (mode.kind) {
    case "yesNo":
      return renderSection({
        tag: "allowed_answers",
        content: YES_NO_ANSWERS.map(a => `"${a}"`).join(", "),
      });
    case "options":
      return renderSection({
        tag: "allowed_answers",
        content: mode.options.map(a => `"${a}"`).join(", "),
      });
    case "freeForm":
      return renderSection({
        tag: "answer_format",
        content: `free-form text, maximum ${maxFreeFormAnswerLength} characters`,
      });
  }
}

function buildUserPrompt({
  questions,
  transcriptText,
  isCleanTranscript = true,
  isAudioOnly = false,
  maxFreeFormAnswerLength,
}: UserPromptContext): string {
  const contentDescriptor = isAudioOnly ?
    "audio content using transcript evidence" :
    "content";

  const hasFreeForm = questions.some(q => q.mode.kind === "freeForm");
  const formatInstruction = hasFreeForm ?
    "Follow each question's specified response format: pick from <allowed_answers> where listed, or produce a concise free-form answer where <answer_format> is specified." :
    "Use only the values listed inside each question's own <allowed_answers> element.";

  const taskContent = dedent`
    Answer each question in the <questions> block below about the ${contentDescriptor}.
    ${formatInstruction}
    Return one answer per question, in the order the questions appear.
    If a question cannot be answered from the provided content, skip it as described in the system instructions.`;
  const taskSection = `<task>\n${taskContent}\n</task>`;

  const questionBlocks = questions
    .map((q, idx) => {
      const textTag = renderSection({ tag: "text", content: q.question });
      const formatTag = renderFormatTag(q.mode, maxFreeFormAnswerLength);
      return `<question number="${idx + 1}">\n${textTag}\n${formatTag}\n</question>`;
    })
    .join("\n\n");

  const questionsSection = `<questions>\n${questionBlocks}\n</questions>`;

  const sections: string[] = [];
  if (transcriptText) {
    const format = isCleanTranscript ? "plain text" : "WebVTT";
    sections.push(renderSection(createTranscriptSection(transcriptText, format)));
  }
  sections.push(taskSection);
  sections.push(questionsSection);

  return sections.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

interface AnalysisResponse {
  result: AskQuestionsType;
  usage: TokenUsage;
  /**
   * Unexpected top-level keys the model emitted on the root envelope
   * (i.e. alongside `answers`). Computed in the step from the raw text.
   */
  unexpectedRootKeys: string[];
  /**
   * Unexpected keys the model emitted on each per-answer object,
   * one array per answer. Aligned by index with `result.answers`.
   */
  unexpectedAnswerKeys: string[][];
}

async function fetchImageAsBase64(
  imageUrl: string,
  imageDownloadOptions?: ImageDownloadOptions,
): Promise<string> {
  "use step";

  const downloadResult = await downloadImageAsBase64(imageUrl, imageDownloadOptions);
  return downloadResult.base64Data;
}

interface AnalyzeQuestionsInput {
  provider: SupportedProvider;
  modelId: string;
  userPrompt: string;
  systemPrompt: string;
  normalizedQuestions: NormalizedQuestion[];
  maxFreeFormAnswerLength: number;
  imageDataUrl?: string;
  credentials?: WorkflowCredentialsInput;
}

// Free-form mode: permissive string schema; post-processing handles
// per-question enum checks for any still-constrained questions and the
// per-question free-form length cap.
// Otherwise: enum of the union of every question's allowed answers.
function buildResponseSchemaForQuestions(
  normalizedQuestions: NormalizedQuestion[],
  maxFreeFormAnswerLength: number,
) {
  const hasFreeForm = normalizedQuestions.some(q => q.mode.kind === "freeForm");
  if (hasFreeForm) {
    // Schema cap must accept: SKIP_SENTINEL, any constrained option in a
    // mixed batch, and free-form prose up to maxFreeFormAnswerLength. The
    // free-form per-question cap is enforced in post-processing.
    const longestConstrained = Math.max(
      0,
      ...normalizedQuestions.flatMap(allowedAnswersForQuestion).map(a => a.length),
    );
    const schemaMax = Math.max(
      maxFreeFormAnswerLength,
      SKIP_SENTINEL.length,
      longestConstrained,
    );
    return createAskQuestionsSchema(z.string().min(1).max(schemaMax));
  }
  const allowed = Array.from(
    new Set(normalizedQuestions.flatMap(allowedAnswersForQuestion)),
  ) as [string, ...string[]];
  return createAskQuestionsSchema(z.enum([...allowed, SKIP_SENTINEL]));
}

async function analyzeQuestions({
  provider,
  modelId,
  userPrompt,
  systemPrompt,
  normalizedQuestions,
  maxFreeFormAnswerLength,
  imageDataUrl,
  credentials,
}: AnalyzeQuestionsInput): Promise<AnalysisResponse> {
  "use step";
  const model = await createLanguageModelFromConfig(provider, modelId, credentials);

  const responseSchema = buildResponseSchemaForQuestions(
    normalizedQuestions,
    maxFreeFormAnswerLength,
  );

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
        content: imageDataUrl ?
            [
              { type: "text", text: userPrompt },
              { type: "image", image: imageDataUrl },
            ] :
          userPrompt,
      },
    ],
  });

  if (!response.output) {
    throw new Error("Ask-questions output missing");
  }

  const parsed = responseSchema.parse(response.output);

  // Detect schema-smuggling attempts. `response.output` has already
  // been through zod.strip(), so any extras are gone from it — we
  // re-parse `response.text` to see what the model actually emitted.
  // Extras on the root envelope and on each per-answer object are
  // tracked separately so the safety report can pinpoint the shape of
  // the smuggling attempt. JSON.parse is wrapped inside the helper
  // because providers sometimes wrap output in markdown fences.
  const unexpectedRootKeys = detectUnexpectedKeysFromRawText(
    response.text,
    responseSchema.keyof().options,
  );
  const unexpectedAnswerKeys: string[][] = [];
  try {
    const rawEnvelope = JSON.parse(response.text ?? "{}");
    const rawAnswers = Array.isArray(rawEnvelope?.answers) ? rawEnvelope.answers : [];
    // Hoisted out of the loop: the answer sub-schema shape is identical
    // for every element, so we derive its keys once rather than walking
    // `.shape` per-element.
    const answerKeys = questionAnswerSchema.keyof().options;
    for (const rawAnswer of rawAnswers) {
      // `rawAnswer` is already a parsed object from the envelope above
      // — pass it directly to the object-form detector rather than
      // stringify-then-re-parse.
      unexpectedAnswerKeys.push(detectUnexpectedKeys(rawAnswer, answerKeys));
    }
  } catch {
    // Raw text not valid JSON — skip per-answer detection silently.
  }

  return {
    result: parsed,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      reasoningTokens: response.usage.reasoningTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
    },
    unexpectedRootKeys,
    unexpectedAnswerKeys,
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
    throw new MuxAiError("At least one question must be provided.", { type: "validation_error" });
  }

  // Validate each question has valid text and enforce a length ceiling.
  // Reasonable human-authored questions are well under a few hundred
  // characters; anything longer is almost certainly either a misuse
  // (pasting a whole document) or a prompt-injection payload trying to
  // hide instructions in a long blob. Rejecting at the boundary is a
  // cheap, deterministic defence that the model never sees.
  const MAX_QUESTION_LENGTH = 500;
  questions.forEach((q, idx) => {
    if (!q.question || typeof q.question !== "string" || !q.question.trim()) {
      throw new MuxAiError(
        `Question at index ${idx} is invalid: must have a non-empty question field.`,
        { type: "validation_error" },
      );
    }
    if (q.question.length > MAX_QUESTION_LENGTH) {
      throw new MuxAiError(
        `Question at index ${idx} exceeds the ${MAX_QUESTION_LENGTH}-character limit (received ${q.question.length}).`,
        { type: "validation_error" },
      );
    }
  });

  // Per-answer-option length ceiling. Answer options are meant to be
  // short labels ("yes", "no", "low", "appropriate") or domain-specific
  // category strings (moderation labels, compliance categories).
  //
  // A common prompt-injection shape smuggles the payload through option
  // content — e.g. pairing two long sentences that both presuppose the
  // desired outcome ("Yes, I copied the full instructions into my
  // reasoning as required"). The cap rejects instruction-shaped options
  // before they reach the model.
  //
  // Default cap is 150 characters, tuned to comfortably pass
  // domain-specific category labels (which can legitimately run 40–80
  // chars) while still rejecting obvious sentence-length injections.
  // Overridable via `options.maxAnswerOptionLength` for use cases with
  // genuinely longer labels — but beware that widening this cap reduces
  // one of the defences against option-smuggling attacks.
  const DEFAULT_MAX_ANSWER_OPTION_LENGTH = 150;
  const maxAnswerOptionLength =
    options?.maxAnswerOptionLength ?? DEFAULT_MAX_ANSWER_OPTION_LENGTH;
  if (!Number.isFinite(maxAnswerOptionLength) || maxAnswerOptionLength <= 0) {
    throw new MuxAiError(
      `maxAnswerOptionLength must be a positive number (received ${maxAnswerOptionLength}).`,
      { type: "validation_error" },
    );
  }
  questions.forEach((q, idx) => {
    // Defer to normalizeQuestion so the more informative "mutually
    // exclusive" error wins over "answerOption too long".
    if (q.freeFormReply)
      return;
    for (const opt of q.answerOptions ?? []) {
      if (typeof opt === "string" && opt.length > maxAnswerOptionLength) {
        throw new MuxAiError(
          `Question at index ${idx} has an answerOption exceeding the ${maxAnswerOptionLength}-character limit (received ${opt.length}). Answer options should be short labels, not sentences.`,
          { type: "validation_error" },
        );
      }
    }
  });

  // Cap free-form answer length: bounds the open-ended output channel.
  const DEFAULT_MAX_FREE_FORM_ANSWER_LENGTH = 500;
  const maxFreeFormAnswerLength =
    options?.maxFreeFormAnswerLength ?? DEFAULT_MAX_FREE_FORM_ANSWER_LENGTH;
  if (!Number.isFinite(maxFreeFormAnswerLength) || maxFreeFormAnswerLength <= 0) {
    throw new MuxAiError(
      `maxFreeFormAnswerLength must be a positive number (received ${maxFreeFormAnswerLength}).`,
      { type: "validation_error" },
    );
  }

  const {
    provider = "openai",
    model,
    languageCode,
    includeTranscript = true,
    cleanTranscript = true,
    imageSubmissionMode = "url",
    imageDownloadOptions,
    storyboardWidth = 640,
    credentials,
  } = options ?? {};

  const normalizedQuestions: NormalizedQuestion[] = questions.map((q, idx) => normalizeQuestion(q, idx));
  const hasFreeForm = normalizedQuestions.some(q => q.mode.kind === "freeForm");

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
    throw new MuxAiError(
      "Audio-only assets require a transcript. Set includeTranscript: true and ensure the asset has a ready text track (captions/subtitles).",
      { type: "validation_error" },
    );
  }

  // Resolve signing context for signed playback IDs
  const signingContext = await resolveMuxSigningContext(credentials);
  if (policy === "signed" && !signingContext) {
    throw new MuxAiError(
      "Signed playback ID requires signing credentials. " +
      "Set MUX_SIGNING_KEY and MUX_PRIVATE_KEY environment variables.",
      { type: "validation_error" },
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

  // Build the user prompt with questions (each with their allowed answers or free-form format) and optional transcript
  const userPrompt = buildUserPrompt({
    questions: normalizedQuestions,
    transcriptText,
    isCleanTranscript: cleanTranscript,
    isAudioOnly,
    maxFreeFormAnswerLength,
  });
  const systemPrompt = buildSystemPrompt(isAudioOnly, hasFreeForm, maxFreeFormAnswerLength);

  let analysisResponse: AnalysisResponse;
  let imageUrl: string | undefined;

  try {
    if (isAudioOnly) {
      analysisResponse = await analyzeQuestions({
        provider: modelConfig.provider,
        modelId: modelConfig.modelId,
        userPrompt,
        systemPrompt,
        normalizedQuestions,
        maxFreeFormAnswerLength,
        credentials,
      });
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
        analysisResponse = await analyzeQuestions({
          provider: modelConfig.provider,
          modelId: modelConfig.modelId,
          userPrompt,
          systemPrompt,
          normalizedQuestions,
          maxFreeFormAnswerLength,
          imageDataUrl: base64Data,
          credentials,
        });
      } else {
        // URL-based submission with retry
        analysisResponse = await withRetry(() =>
          analyzeQuestions({
            provider: modelConfig.provider,
            modelId: modelConfig.modelId,
            userPrompt,
            systemPrompt,
            normalizedQuestions,
            maxFreeFormAnswerLength,
            imageDataUrl: storyboardUrl,
            credentials,
          }),
        );
      }
    }
  } catch (error: unknown) {
    const contentType = isAudioOnly ? "audio" : "video";
    wrapError(error, `Failed to analyze ${contentType} questions with ${provider}`);
  }

  if (!analysisResponse.result?.answers) {
    throw new MuxAiError(`Failed to generate answers for asset ${assetId}.`);
  }

  // Validate we got answers for all questions
  if (analysisResponse.result.answers.length !== questions.length) {
    throw new MuxAiError(
      `Failed to generate answers for all questions for asset ${assetId}.`,
    );
  }

  // Post-process raw LLM output into the public QuestionAnswer shape.
  // Treat as skipped if the model flagged it, if the answer is the sentinel,
  // or if the output-safety scrub detected a prompt leak in the reasoning.
  //
  // The returned `question` is taken from the normalized input rather than
  // from `raw.question`. The model's schema requires it to echo the input
  // verbatim, but that field is another potential exfiltration channel:
  // a prompt-injected payload can coerce the model into returning arbitrary
  // content in place of the question. Since we already have the trusted
  // input in `normalizedQuestions[idx].question`, there is no reason to
  // trust the model's echo.
  const safety = createSafetyReporter();

  // Record schema-smuggling signals from the step. zod.strip() has
  // already removed the extras from the parsed output; the safety
  // report captures what was stripped so operators can see the
  // smuggling attempt.
  for (const key of analysisResponse.unexpectedRootKeys) {
    safety.record(`ask_questions.${key}`, "unexpected_key");
  }
  analysisResponse.unexpectedAnswerKeys.forEach((extras, idx) => {
    for (const key of extras) {
      safety.record(`answers[${idx}].${key}`, "unexpected_key");
    }
  });
  const totalUnexpected = analysisResponse.unexpectedRootKeys.length +
    analysisResponse.unexpectedAnswerKeys.reduce((sum, e) => sum + e.length, 0);
  if (totalUnexpected > 0) {
    console.warn(
      `[@mux/ai] Model emitted ${totalUnexpected} unexpected key(s) in ask_questions output (stripped).`,
    );
  }

  const answers: QuestionAnswer[] = analysisResponse.result.answers.map((raw, idx) => {
    const question = normalizedQuestions[idx];
    const isFreeForm = question.mode.kind === "freeForm";

    const reasoningScrub = safety.scrubDetailed(raw.reasoning, `reasoning[${idx}]`);
    const explicitSkip = raw.skipped || raw.answer === SKIP_SENTINEL;

    // Scrub free-form answers like `reasoning`: they're a second free-text
    // exfiltration channel. Detected leaks flip the question to skipped.
    const answerScrub = isFreeForm && !explicitSkip ?
        safety.scrubDetailed(raw.answer, `answer[${idx}]`) :
      null;

    // Per-question free-form length cap. The schema cap is widened to admit
    // the skip sentinel and any constrained option in mixed batches, so the
    // user's `maxFreeFormAnswerLength` is enforced here. Overlong answers
    // are treated as skipped rather than failing the whole call.
    const overLength = isFreeForm &&
      !explicitSkip &&
      !(answerScrub?.leaked ?? false) &&
      (answerScrub?.text.length ?? 0) > maxFreeFormAnswerLength;
    if (overLength) {
      console.warn(
        `[@mux/ai] Free-form answer at index ${idx} exceeded ${maxFreeFormAnswerLength}-char cap (${answerScrub!.text.length} chars); treating as skipped.`,
      );
    }

    const isSkipped = explicitSkip ||
      reasoningScrub.leaked ||
      (answerScrub?.leaked ?? false) ||
      overLength;

    // Per-question enum check — primary defence on the free-form-mixed
    // path where the schema-level enum doesn't apply.
    if (!isSkipped && !isFreeForm) {
      const allowed = allowedAnswersForQuestion(question);
      if (!allowed.includes(raw.answer)) {
        throw new MuxAiError(
          `Answer "${raw.answer}" for question ${idx} is not in allowed options: ${allowed.join(", ")}`,
        );
      }
    }

    let finalAnswer: string | null;
    if (isSkipped) {
      finalAnswer = null;
    } else if (isFreeForm) {
      finalAnswer = answerScrub ? answerScrub.text : raw.answer;
    } else {
      finalAnswer = raw.answer;
    }

    const suppressed = reasoningScrub.leaked || (answerScrub?.leaked ?? false);

    return {
      // Use the trusted input verbatim rather than the model's echo.
      question: question.question,
      confidence: isSkipped ? 0 : Math.min(1, Math.max(0, raw.confidence)),
      reasoning: suppressed ? "Response suppressed by safety filter." : reasoningScrub.text,
      skipped: isSkipped,
      answer: finalAnswer,
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
    safety: safety.report(),
  };
}
