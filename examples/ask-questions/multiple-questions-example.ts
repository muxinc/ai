import { Command } from "commander";

import { askQuestions } from "@mux/ai/workflows";

import { parseQuestionArg } from "./parse-question";

const program = new Command();

program
  .name("ask-multiple-questions")
  .description("Ask multiple questions about a Mux asset")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .argument(
    "<questions...>",
    "Questions to ask (space-separated). Answer options default to yes/no. " +
    "To use custom allowed answers for a question, append a pipe followed by " +
    "comma-separated options, e.g. \"What is the quality?|amateur,semi-pro,professional\". " +
    "Use \"|*\" (experimental) for a free-form prose reply.",
  )
  .option("-p, --provider <provider>", "AI provider: openai, anthropic, google (default: openai)")
  .option("-m, --model <model>", "Model name (default varies by provider)")
  .option("--no-transcript", "Exclude transcript from analysis")
  .option(
    "--free-form-max-length <n>",
    "Maximum character length for free-form answers (default: 500). Only applies to questions using the |* sigil.",
    (value) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--free-form-max-length must be a positive number (received ${value}).`);
      }
      return n;
    },
  )
  .action(async (assetId: string, questionArgs: string[], options: {
    provider?: string;
    model?: string;
    transcript: boolean;
    freeFormMaxLength?: number;
  }) => {
    const questionObjects = questionArgs.map(parseQuestionArg);
    const freeFormMaxLen = options.freeFormMaxLength ?? 500;

    console.log("Asset ID:", assetId);
    console.log(`Questions (${questionObjects.length}):`);
    questionObjects.forEach((q, idx) => {
      const format = q.freeFormReply ?
        `free-form (max ${freeFormMaxLen} chars)` :
        (q.answerOptions ?? ["yes", "no"]).join(", ");
      console.log(`  ${idx + 1}. ${q.question} [${format}]`);
    });
    console.log(`Provider: ${options.provider || "openai (default)"}`);
    console.log(`Model: ${options.model || "default"}`);
    console.log(`Include Transcript: ${options.transcript}\n`);

    try {
      // Uses the default prompt built into the library
      // Credentials are automatically read from environment variables
      const result = await askQuestions(assetId, questionObjects, {
        provider: options.provider as any,
        model: options.model,
        includeTranscript: options.transcript,
        maxFreeFormAnswerLength: options.freeFormMaxLength,
      });

      console.log(`\n${"=".repeat(80)}\n`);
      console.log(`RESULTS (${result.answers.length} questions answered)\n`);

      result.answers.forEach((answer, idx) => {
        // Short constrained answers like "yes" / "glasses" read well uppercased;
        // free-form prose does not — keep prose as-is.
        const isFreeForm = questionObjects[idx].freeFormReply === true;
        const formattedAnswer = answer.answer === null ?
          "SKIPPED" :
          (isFreeForm ? answer.answer : answer.answer.toUpperCase());
        console.log(`${idx + 1}. ❓ Question:`);
        console.log(`   ${answer.question}`);
        console.log(`\n   ✅ Answer: ${formattedAnswer}`);
        console.log(`   📊 Confidence: ${(answer.confidence * 100).toFixed(1)}%`);
        console.log(`\n   💭 Reasoning:`);
        console.log(`   ${answer.reasoning.replace(/\n/g, "\n   ")}`);
        console.log(`\n${"-".repeat(80)}\n`);
      });

      console.log(`🖼️  Storyboard URL:`);
      console.log(result.storyboardUrl ?? "N/A (audio-only asset)");

      if (result.usage) {
        console.log("\n📈 Token Usage:");
        console.log(`  Input: ${result.usage.inputTokens}`);
        console.log(`  Output: ${result.usage.outputTokens}`);
        console.log(`  Total: ${result.usage.totalTokens}`);
      }

      // Summary statistics
      const answerCounts = result.answers.reduce<Record<string, number>>((acc, a) => {
        const key = a.answer ?? "(skipped)";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      const avgConfidence = result.answers.reduce((sum, a) => sum + a.confidence, 0) / result.answers.length;

      console.log("\n📊 Summary:");
      for (const [answer, count] of Object.entries(answerCounts)) {
        console.log(`  ${answer}: ${count}`);
      }
      console.log(`  Average Confidence: ${(avgConfidence * 100).toFixed(1)}%`);
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
