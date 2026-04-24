import type { Question } from "@mux/ai/workflows";

/**
 * Parse a CLI question string with optional pipe-delimited answer options.
 *
 * Syntax:
 *   "Question text"                                → answer options default to yes/no
 *   "Question text|option1,option2,option3"        → custom allowed answers
 *   "Question text|*"                              → EXPERIMENTAL: free-form reply
 *
 * Examples:
 *   "Is this about glasses?"
 *   "What is the production quality?|amateur,semi-pro,professional"
 *   "What is the sentiment?|positive,neutral,negative"
 *   "Describe the primary subject.|*"
 *
 * Shell note: the pipe character (and the `*` sigil for free-form) must be
 * quoted so the shell doesn't interpret them as a command pipeline or
 * glob pattern.
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
  const afterPipe = input.slice(pipeIdx + 1).trim();

  if (!question) {
    throw new Error(`Empty question text in "${input}".`);
  }

  // Free-form sigil: a bare "*" after the pipe means "any answer".
  if (afterPipe === "*") {
    return { question, freeFormReply: true };
  }

  const answerOptions = afterPipe
    .split(",")
    .map(o => o.trim())
    .filter(Boolean);

  if (!answerOptions.length) {
    throw new Error(
      `Pipe found but no answer options in "${input}". ` +
      "Expected format: \"Question text|option1,option2,...\" " +
      "or \"Question text|*\" for free-form replies.",
    );
  }

  return { question, answerOptions };
}
