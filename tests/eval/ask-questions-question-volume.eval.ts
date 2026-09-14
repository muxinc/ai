import { evalite } from "evalite";
import { reportTrace } from "evalite/traces";

import type { TokenUsage } from "../../src/types";
import { askQuestions } from "../../src/workflows";
import type { Question } from "../../src/workflows";

/**
 * Ask Questions — Question Volume Investigation (AIT-405)
 *
 * A production customer sent 90 timestamp-windowed questions in a single
 * `askQuestions` call and intermittently got back fewer answers than
 * questions asked — the model finished normally (finishReason: "stop"), it
 * just under-delivered. This eval measures answer-completeness as a function
 * of question-batch size, to check whether capping at 50 questions
 * (ASK_QUESTIONS_MAX_QUESTIONS_PER_CALL) actually reduces/eliminates that
 * under-delivery, versus just moving the same failure to a smaller N.
 *
 * Replays the real failure's exact question shape (timestamp window +
 * binary constrained answer) against an internal staging asset instead of
 * the customer's own asset/environment — a ~62 minute two-person recording
 * (Dave and Darius), so the 90-question condition covers the first ~38
 * minutes at the same ~25s window size the real customer traffic used.
 *
 * The 50-question set is a literal prefix of the 90-question set (same
 * windows, same start point) so question count is the only variable that
 * differs between conditions — not window timing, size, or content.
 */

const STAGING_ASSET_ID = "8vwrvoPIXzxYQ8QYgJguAGIPzkCOSBMosvVtFbFMKbE";

/**
 * How many times to repeat each condition. The failure is stochastic (the
 * model doesn't reliably under-deliver on every call at a given N), so a
 * single run per condition tells you nothing — this is what turns a
 * pass/fail into a completion-rate percentage. Raise this if the first pass
 * looks noisy.
 */
const REPEATS_PER_CONDITION = 6;

const WINDOW_SECONDS = 25;
const GAP_SECONDS = 2;
const QUESTION_COUNT_LARGE = 90;
const QUESTION_COUNT_SMALL = 50;

/** Matches the model/provider Robots actually defaults to in production (see
 * apps/api/scripts/simulate-usage/ask-questions.ts DEFAULT_MODEL) rather than
 * this package's own internal default (openai), so this replays the real
 * production path as closely as possible. */
const PRODUCTION_DEFAULT_PROVIDER = "google" as const;
const PRODUCTION_DEFAULT_MODEL = "gemini-3.1-flash-lite" as const;

function formatTimestamp(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Generates sequential timestamp-window questions, mirroring the real
 * production payload's shape exactly: "Who is the person speaking for most
 * of the video between {start} and {end}?" with a binary constrained
 * answer — just swapping in this asset's actual named speakers. */
function buildSpeakerWindowQuestions(count: number): Question[] {
  const questions: Question[] = [];
  let cursor = 4; // matches the real payload's own 0:04 start offset
  for (let i = 0; i < count; i++) {
    const start = cursor;
    const end = start + WINDOW_SECONDS;
    questions.push({
      question: `Who is the person speaking for most of the video between ${formatTimestamp(start)} and ${formatTimestamp(end)}?`,
      answerOptions: ["Dave", "Darius"],
    });
    cursor = end + GAP_SECONDS;
  }
  return questions;
}

const ALL_90_QUESTIONS = buildSpeakerWindowQuestions(QUESTION_COUNT_LARGE);
const FIRST_50_QUESTIONS = ALL_90_QUESTIONS.slice(0, QUESTION_COUNT_SMALL);

interface VolumeCondition {
  label: string;
  questions: Question[];
}

const CONDITIONS: VolumeCondition[] = [
  { label: "90-questions", questions: ALL_90_QUESTIONS },
  { label: "50-questions", questions: FIRST_50_QUESTIONS },
];

const data = CONDITIONS.flatMap(condition =>
  Array.from({ length: REPEATS_PER_CONDITION }, (_, repeatIndex) => ({
    input: {
      assetId: STAGING_ASSET_ID,
      label: condition.label,
      repeatIndex,
      questions: condition.questions,
    },
  })),
);

interface TaskInput {
  assetId: string;
  label: string;
  repeatIndex: number;
  questions: Question[];
}

interface TaskOutput {
  succeeded: boolean;
  questionCount: number;
  answerCount: number;
  errorMessage?: string;
  usage?: TokenUsage;
  latencyMs: number;
}

evalite("Ask Questions — Question Volume (AIT-405)", {
  data,

  task: async ({ assetId, questions }: TaskInput): Promise<TaskOutput> => {
    const startTime = performance.now();
    try {
      const result = await askQuestions(assetId, questions, {
        provider: PRODUCTION_DEFAULT_PROVIDER,
        model: PRODUCTION_DEFAULT_MODEL,
        includeTranscript: true,
      });
      const latencyMs = performance.now() - startTime;

      reportTrace({
        input: { assetId, questionCount: questions.length },
        output: result,
        usage: {
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
          totalTokens: result.usage?.totalTokens ?? 0,
        },
        start: startTime,
        end: startTime + latencyMs,
      });

      return {
        succeeded: true,
        questionCount: questions.length,
        answerCount: result.answers.length,
        usage: result.usage,
        latencyMs,
      };
    } catch (error) {
      return {
        succeeded: false,
        questionCount: questions.length,
        answerCount: 0,
        errorMessage: error instanceof Error ? error.message : String(error),
        latencyMs: performance.now() - startTime,
      };
    }
  },

  scorers: [
    {
      name: "answer-count-complete",
      description: "1 if the call succeeded and returned exactly one answer per question asked, else 0. The only metric this investigation cares about — not answer correctness.",
      scorer: ({ output }: { output: TaskOutput }) =>
        output.succeeded && output.answerCount === output.questionCount ? 1 : 0,
    },
  ],

  columns: async ({ input, output }: { input: TaskInput; output: TaskOutput }) => [
    { label: "Condition", value: input.label },
    { label: "Repeat", value: input.repeatIndex + 1 },
    { label: "Questions Asked", value: output.questionCount },
    { label: "Answers Received", value: output.answerCount },
    { label: "Succeeded", value: output.succeeded ? "yes" : "no" },
    { label: "Error", value: output.errorMessage ?? "" },
    { label: "Output Tokens", value: output.usage?.outputTokens ?? 0 },
    { label: "Latency", value: `${Math.round(output.latencyMs)}ms` },
  ],
});
