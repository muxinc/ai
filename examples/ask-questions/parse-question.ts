import type { Question } from "@mux/ai/workflows";

/**
 * Parse a CLI question string with optional pipe-delimited answer options.
 *
 * Syntax:
 *   "Question text"                                → answer options default to yes/no
 *   "Question text|option1,option2,option3"        → custom allowed answers
 *
 * Examples:
 *   "Is this about glasses?"
 *   "What is the production quality?|amateur,semi-pro,professional"
 *   "What is the sentiment?|positive,neutral,negative"
 *
 * Shell note: the pipe character must be quoted so the shell doesn't
 * interpret it as a command pipeline.
 */
export function parseQuestionArg(input: string): Question {
  const pipeIdx = input.indexOf("|");
  if (pipeIdx === -1) {
    const question = input.trim();
    if (!question) {
      throw new Error("Empty question text.");
    }
    return { question };
  }

  const question = input.slice(0, pipeIdx).trim();
  const answerOptions = input
    .slice(pipeIdx + 1)
    .split(",")
    .map(o => o.trim())
    .filter(Boolean);

  if (!question) {
    throw new Error(`Empty question text in "${input}".`);
  }
  if (!answerOptions.length) {
    throw new Error(
      `Pipe found but no answer options in "${input}". ` +
      "Expected format: \"Question text|option1,option2,...\".",
    );
  }

  return { question, answerOptions };
}
