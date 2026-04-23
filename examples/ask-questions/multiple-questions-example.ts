import { Command } from "commander";

import { askQuestions } from "@mux/ai/workflows";

import { parseQuestionArg } from "./parse-question";

type Provider = "openai" | "baseten" | "anthropic" | "google";

const program = new Command();

program
  .name("ask-multiple-questions")
  .description("Ask multiple questions about a Mux asset")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .argument(
    "<questions...>",
    "Questions to ask (space-separated). Answer options default to yes/no. " +
    "To use custom allowed answers for a question, append a pipe followed by " +
    "comma-separated options, e.g. \"What is the quality?|amateur,semi-pro,professional\"",
  )
  .option("-p, --provider <provider>", "AI provider: openai, baseten, anthropic, google (default: openai)")
  .option("-m, --model <model>", "Model name (default varies by provider)")
  .option("--no-transcript", "Exclude transcript from analysis")
  .action(async (assetId: string, questionArgs: string[], options: {
    provider?: Provider;
    model?: string;
    transcript: boolean;
  }) => {
    const questionObjects = questionArgs.map(parseQuestionArg);

    console.log("Asset ID:", assetId);
    console.log(`Questions (${questionObjects.length}):`);
    questionObjects.forEach((q, idx) => {
      const answers = (q.answerOptions ?? ["yes", "no"]).join(", ");
      console.log(`  ${idx + 1}. ${q.question} [${answers}]`);
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
      });

      console.log(`\n${"=".repeat(80)}\n`);
      console.log(`RESULTS (${result.answers.length} questions answered)\n`);

      result.answers.forEach((answer, idx) => {
        const formattedAnswer = answer.answer?.toUpperCase() ?? "SKIPPED";
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
